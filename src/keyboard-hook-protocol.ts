import type { MessagePort } from "node:worker_threads";

import type { ShortcutTarget } from "./shared";

export const keyboardHookWakeMessage = 0x80_00;

export const keyboardHookControlSlots = {
  stopRequested: 1,
  threadId: 0
} as const;

export const keyboardHookControlSlotCount = Object.keys(keyboardHookControlSlots).length;

export interface KeyboardKeyEvent {
  code: string | null;
  isKeyDown: boolean;
  virtualKey: number;
}

export interface ShortcutBinding {
  shortcut: string;
  target: ShortcutTarget;
}

export type KeyboardHookCommand =
  | { isRecording: boolean; type: "recording" }
  | { shortcuts: ShortcutBinding[]; type: "shortcuts" };

export type KeyboardHookEvent =
  | { key: KeyboardKeyEvent; type: "key" }
  | { message: string; type: "error" }
  | { target: ShortcutTarget; type: "shortcut" };

export interface KeyboardHookWorkerData {
  commands: MessagePort;
  control: Int32Array;
}
