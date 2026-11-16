import path from "node:path";
import { MessageChannel, type MessagePort, Worker } from "node:worker_threads";

import koffi from "koffi";

import {
  type KeyboardHookCommand,
  keyboardHookControlSlotCount,
  keyboardHookControlSlots,
  type KeyboardHookEvent,
  keyboardHookWakeMessage,
  type KeyboardHookWorkerData,
  type KeyboardKeyEvent
} from "./keyboard-hook-protocol";
import type { ShortcutTarget } from "./shared";

const quitMessage = 0x00_12;
const workerFileName = "keyboard-hook-worker.js";

const user32 = koffi.load("user32.dll");
const postThreadMessage: (threadId: number, message: number, wordParameter: number, longParameter: number) => number = user32.func(
  "int __stdcall PostThreadMessageW(uint32_t threadId, uint32_t message, uintptr_t wParam, intptr_t lParam)"
);

type KeyListener = (event: KeyboardKeyEvent) => void;

interface ShortcutHandler {
  onPress: () => void;
  shortcut: string;
}

export class KeyboardHook {
  private commands: MessagePort | null = null;

  private readonly control = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * keyboardHookControlSlotCount));

  private hasFailed = false;

  private isStopping = false;

  private keyListener: KeyListener | null = null;

  private readonly shortcutHandlers = new Map<ShortcutTarget, ShortcutHandler>();

  constructor(private readonly reportError: (error: unknown) => void) {}

  private postToHookThread(message: number): void {
    const threadId = Atomics.load(this.control, keyboardHookControlSlots.threadId);
    if (threadId !== 0) {
      postThreadMessage(threadId, message, 0, 0);
    }
  }

  private send(command: KeyboardHookCommand): void {
    if (this.commands === null) {
      return;
    }

    this.commands.postMessage(command);
    this.postToHookThread(keyboardHookWakeMessage);
  }

  private sendRecordingState(): void {
    this.send({ isRecording: this.keyListener !== null, type: "recording" });
  }

  private sendShortcuts(): void {
    const shortcuts = [...this.shortcutHandlers].map(([target, { shortcut }]) => ({ shortcut, target }));
    this.send({ shortcuts, type: "shortcuts" });
  }

  private fail(error: unknown): void {
    if (this.hasFailed || this.isStopping) {
      return;
    }

    this.hasFailed = true;
    this.reportError(error);
  }

  private handleEvent(event: KeyboardHookEvent): void {
    switch (event.type) {
      case "error": {
        this.reportError(new Error(event.message));
        break;
      }

      case "key": {
        this.keyListener?.(event.key);
        break;
      }

      case "shortcut": {
        this.shortcutHandlers.get(event.target)?.onPress();
        break;
      }

      default: {
        throw new Error(`Unexpected keyboard hook event: ${JSON.stringify(event)}`);
      }
    }
  }

  bindShortcut(target: ShortcutTarget, shortcut: string, onPress: () => void): void {
    this.shortcutHandlers.set(target, { onPress, shortcut });
    this.sendShortcuts();
  }

  unbindShortcut(target: ShortcutTarget): void {
    if (this.shortcutHandlers.delete(target)) {
      this.sendShortcuts();
    }
  }

  record(listener: KeyListener): () => void {
    this.keyListener = listener;
    this.sendRecordingState();
    return (): void => {
      if (this.keyListener !== listener) {
        return;
      }

      this.keyListener = null;
      this.sendRecordingState();
    };
  }

  start(): void {
    if (this.commands !== null) {
      return;
    }

    const { port1, port2 } = new MessageChannel();
    const workerData: KeyboardHookWorkerData = { commands: port2, control: this.control };
    const worker = new Worker(path.join(__dirname, workerFileName), { transferList: [port2], workerData });
    worker.on("message", (event: KeyboardHookEvent): void => {
      this.handleEvent(event);
    });
    worker.on("error", (error): void => {
      this.fail(error);
    });
    worker.on("exit", (exitCode): void => {
      this.fail(new Error(`Keyboard shortcuts stopped working (exit code ${String(exitCode)}).`));
    });
    this.commands = port1;
    this.sendShortcuts();
    this.sendRecordingState();
  }

  stop(): void {
    this.isStopping = true;
    Atomics.store(this.control, keyboardHookControlSlots.stopRequested, 1);
    this.postToHookThread(quitMessage);
  }
}
