import { type MessagePort, parentPort, receiveMessageOnPort, workerData } from "node:worker_threads";

import koffi from "koffi";

import {
  type KeyboardHookCommand,
  keyboardHookControlSlots,
  type KeyboardHookEvent,
  keyboardHookWakeMessage,
  type KeyboardHookWorkerData
} from "./keyboard-hook-protocol";
import { keyCodeFromHookKey } from "./keyboard-keys";
import { ShortcutMatcher } from "./shortcut-matcher";

if (parentPort === null) {
  throw new Error("The keyboard hook must run in a worker thread.");
}

const lowLevelKeyboardHook = 13;
const extendedKeyFlag = 0x01;
const keyUpFlag = 0x80;
const altGraphControlScanCode = 0x2_1D;
const menuMaskVirtualKey = 0xE8;
const keyboardInputType = 1;
const keyUpInputFlag = 0x02;
const firstUserMessage = 0x04_00;
const peekWithoutRemoving = 0;
const suppressKey = 1;
const flagBitBase = 2;
const inputUnionPaddingBytes = 8;
const missingScanCode = 0;
const virtualKeyToExtendedScanCodeMapping = 4;
const scanCodeByteBase = 0x1_00;
const extendedScanCodePrefix = 0xE0;

const hookInfoType = koffi.struct("SoftshotKeyboardHookInfo", {
  virtualKey: "uint32_t",
  scanCode: "uint32_t",
  flags: "uint32_t",
  time: "uint32_t",
  extraInformation: "uintptr_t"
});
koffi.struct("SoftshotKeyboardHookMessage", {
  window: "void *",
  message: "uint32_t",
  wordParameter: "uintptr_t",
  longParameter: "intptr_t",
  time: "uint32_t",
  x: "int32_t",
  y: "int32_t",
  privateData: "uint32_t"
});
const keyboardInputStructType = koffi.struct("SoftshotKeyboardInput", {
  virtualKey: "uint16_t",
  scanCode: "uint16_t",
  flags: "uint32_t",
  time: "uint32_t",
  extraInformation: "uintptr_t"
});
const inputType = koffi.struct("SoftshotInput", {
  type: "uint32_t",
  keyboard: keyboardInputStructType,
  unionPadding: koffi.array("uint8_t", inputUnionPaddingBytes)
});
const hookProcedureType = koffi.proto(
  "intptr_t __stdcall SoftshotKeyboardHookProcedure(int code, uintptr_t wParam, void *info)"
);

const user32 = koffi.load("user32.dll");
const kernel32 = koffi.load("kernel32.dll");

type MessageParameter = bigint | number;

interface HookInfo {
  flags: number;
  scanCode: number;
  virtualKey: number;
}

interface ThreadMessage {
  message?: number;
}

interface KeyboardInput {
  keyboard: { extraInformation: number; flags: number; scanCode: number; time: number; virtualKey: number };
  type: number;
  unionPadding: number[];
}

const setWindowsHook: (id: number, procedure: unknown, module: unknown, threadId: number) => unknown = user32.func(
  "void * __stdcall SetWindowsHookExW(int id, SoftshotKeyboardHookProcedure *procedure, void *module, uint32_t threadId)"
);
const callNextHook: (hook: null, code: number, wordParameter: MessageParameter, info: unknown) => MessageParameter = user32.func(
  "intptr_t __stdcall CallNextHookEx(void *hook, int code, uintptr_t wParam, void *info)"
);
const unhookWindowsHook: (hook: unknown) => number = user32.func("int __stdcall UnhookWindowsHookEx(void *hook)");
const getMessage: (message: ThreadMessage, window: null, first: number, last: number) => number = user32.func(
  "int __stdcall GetMessageW(_Out_ SoftshotKeyboardHookMessage *message, void *window, uint32_t first, uint32_t last)"
);
const peekMessage: (message: ThreadMessage, window: null, first: number, last: number, removal: number) => number = user32.func(
  "int __stdcall PeekMessageW(_Out_ SoftshotKeyboardHookMessage *message, void *window, uint32_t first, uint32_t last, uint32_t removal)"
);
const getAsyncKeyState: (virtualKey: number) => number = user32.func("int16_t __stdcall GetAsyncKeyState(int virtualKey)");
const mapVirtualKey: (code: number, mapping: number) => number = user32.func(
  "uint32_t __stdcall MapVirtualKeyW(uint32_t code, uint32_t mapping)"
);
const sendInput: (count: number, inputs: KeyboardInput[], size: number) => number = user32.func(
  "uint32_t __stdcall SendInput(uint32_t count, const SoftshotInput *inputs, int size)"
);
const getCurrentThreadId: () => number = kernel32.func("uint32_t __stdcall GetCurrentThreadId()");
const getModuleHandle: (name: null) => unknown = kernel32.func("void * __stdcall GetModuleHandleW(const char16_t *name)");

const host = parentPort;
const { commands, control } = workerData as KeyboardHookWorkerData;
const matcher = new ShortcutMatcher((virtualKey) => getAsyncKeyState(virtualKey) < 0);

function hasFlag(value: number, flag: number): boolean {
  return Math.floor(value / flag) % flagBitBase === 1;
}

function post(event: KeyboardHookEvent): void {
  host.postMessage(event);
}

function menuMaskInput(flags: number): KeyboardInput {
  return {
    keyboard: { extraInformation: 0, flags, scanCode: 0, time: 0, virtualKey: menuMaskVirtualKey },
    type: keyboardInputType,
    unionPadding: Array.from({ length: inputUnionPaddingBytes }, () => 0)
  };
}

function sendMenuMask(): void {
  const inputs = [menuMaskInput(0), menuMaskInput(keyUpInputFlag)];
  if (sendInput(inputs.length, inputs, koffi.sizeof(inputType)) !== inputs.length) {
    post({ message: "Could not stop Windows from opening a menu after a shortcut.", type: "error" });
  }
}

function hookKeyCode(info: HookInfo): string | null {
  const hasExtendedFlag = hasFlag(info.flags, extendedKeyFlag);
  if (info.scanCode !== missingScanCode) {
    return keyCodeFromHookKey(info.virtualKey, info.scanCode, hasExtendedFlag);
  }

  const mappedScanCode = mapVirtualKey(info.virtualKey, virtualKeyToExtendedScanCodeMapping);
  const isExtendedKey = hasExtendedFlag || Math.floor(mappedScanCode / scanCodeByteBase) === extendedScanCodePrefix;
  return keyCodeFromHookKey(info.virtualKey, mappedScanCode % scanCodeByteBase, isExtendedKey);
}

function shouldSuppressKey(info: HookInfo): boolean {
  if (info.virtualKey === menuMaskVirtualKey || info.scanCode === altGraphControlScanCode) {
    return false;
  }

  const code = hookKeyCode(info);
  const isKeyDown = !hasFlag(info.flags, keyUpFlag);
  if (matcher.isRecording) {
    post({ key: { code, isKeyDown, virtualKey: info.virtualKey }, type: "key" });
  }

  if (code === null) {
    return false;
  }

  if (!isKeyDown) {
    return matcher.keyUp(code);
  }

  const decision = matcher.keyDown({ code, virtualKey: info.virtualKey }, Date.now());
  for (const target of decision.pressedTargets) {
    post({ target, type: "shortcut" });
  }

  if (decision.needsMenuMask) {
    sendMenuMask();
  }

  return decision.isSuppressed;
}

function isSuppressedHookCall(code: number, info: unknown): boolean {
  if (code < 0) {
    return false;
  }

  try {
    return shouldSuppressKey(koffi.decode(info, hookInfoType) as HookInfo);
  } catch (error) {
    post({ message: error instanceof Error ? error.message : String(error), type: "error" });
    return false;
  }
}

function handleHookCall(code: number, wordParameter: MessageParameter, info: unknown): MessageParameter {
  return isSuppressedHookCall(code, info) ? suppressKey : callNextHook(null, code, wordParameter, info);
}

function applyCommand(command: KeyboardHookCommand): void {
  switch (command.type) {
    case "recording": {
      matcher.isRecording = command.isRecording;
      break;
    }

    case "shortcuts": {
      matcher.setShortcuts(command.shortcuts);
      break;
    }

    default: {
      throw new Error(`Unexpected keyboard hook command: ${JSON.stringify(command)}`);
    }
  }
}

function applyPendingCommands(port: MessagePort): void {
  let received = receiveMessageOnPort(port);
  while (received) {
    applyCommand(received.message as KeyboardHookCommand);
    received = receiveMessageOnPort(port);
  }
}

function runMessageLoop(): void {
  const message: ThreadMessage = {};
  peekMessage(message, null, firstUserMessage, firstUserMessage, peekWithoutRemoving);
  Atomics.store(control, keyboardHookControlSlots.threadId, getCurrentThreadId());
  if (Atomics.load(control, keyboardHookControlSlots.stopRequested) !== 0) {
    return;
  }

  applyPendingCommands(commands);
  while (getMessage(message, null, 0, 0) > 0) {
    if (message.message === keyboardHookWakeMessage) {
      applyPendingCommands(commands);
    }
  }
}

const procedure = koffi.register(handleHookCall, koffi.pointer(hookProcedureType));
const hook = setWindowsHook(lowLevelKeyboardHook, procedure, getModuleHandle(null), 0);
if (hook === null) {
  koffi.unregister(procedure);
  throw new Error("Could not watch the keyboard for shortcuts.");
}

try {
  runMessageLoop();
} finally {
  unhookWindowsHook(hook);
  koffi.unregister(procedure);
}
