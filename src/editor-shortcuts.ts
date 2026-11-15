import { isTriggerKeyCode } from "./keyboard-keys.js";
import {
  acceleratorModifierKeys,
  isModifierKeyCode,
  keySeparator,
  maxShortcutKeyCount,
  shortcutKeys
} from "./shortcut-keys.js";

export const editorCommands = [
  "play",
  "previousFrame",
  "nextFrame",
  "backOneSecond",
  "forwardOneSecond",
  "jumpStart",
  "jumpEnd",
  "hand",
  "cut",
  "deleteClip",
  "snap",
  "undo",
  "redo",
  "zoomIn",
  "zoomOut",
  "zoomFit",
  "export"
] as const;

export type EditorCommand = (typeof editorCommands)[number];

export type EditorShortcuts = Record<EditorCommand, string>;

export const editorCommandLabels: Readonly<EditorShortcuts> = {
  backOneSecond: "Back 1 second",
  cut: "Cut tool",
  deleteClip: "Delete clip",
  export: "Export",
  forwardOneSecond: "Forward 1 second",
  hand: "Hand tool",
  jumpEnd: "Go to end",
  jumpStart: "Go to start",
  nextFrame: "Next frame",
  play: "Play or pause",
  previousFrame: "Previous frame",
  redo: "Redo",
  snap: "Snapping",
  undo: "Undo",
  zoomFit: "Fit timeline",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out"
};

export const defaultEditorShortcuts: Readonly<EditorShortcuts> = {
  backOneSecond: "Shift+ArrowLeft",
  cut: "KeyC",
  deleteClip: "Delete",
  export: "Control+KeyE",
  forwardOneSecond: "Shift+ArrowRight",
  hand: "KeyB",
  jumpEnd: "End",
  jumpStart: "Home",
  nextFrame: "ArrowRight",
  play: "Space",
  previousFrame: "ArrowLeft",
  redo: "Control+KeyY",
  snap: "KeyN",
  undo: "Control+KeyZ",
  zoomFit: "Backslash",
  zoomIn: "Equal",
  zoomOut: "Minus"
};

export const editorEscapeKeyCode = "Escape";

const editorCommandSet: ReadonlySet<unknown> = new Set(editorCommands);

export interface EditorShortcutKeyState {
  altKey: boolean;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export function isEditorCommand(value: unknown): value is EditorCommand {
  return editorCommandSet.has(value);
}

export function editorShortcutModifiers(state: EditorShortcutKeyState): string[] {
  const pressedModifiers: Record<(typeof acceleratorModifierKeys)[number], boolean> = {
    Alt: state.altKey,
    Control: state.ctrlKey,
    Meta: state.metaKey,
    Shift: state.shiftKey
  };
  return acceleratorModifierKeys.filter((modifier) => pressedModifiers[modifier]);
}

export function editorShortcutFromKeyState(state: EditorShortcutKeyState): string | null {
  if (isModifierKeyCode(state.code)) {
    return null;
  }

  return [...editorShortcutModifiers(state), state.code].join(keySeparator);
}

export function editorCommandUsingShortcut(
  shortcuts: Readonly<EditorShortcuts>,
  shortcut: string,
  except: EditorCommand
): EditorCommand | null {
  return editorCommands.find((command) => command !== except && shortcuts[command] === shortcut) ?? null;
}

export function editorShortcutProblem(shortcut: string): string | null {
  const keys = shortcutKeys(shortcut);
  if (keys.length > maxShortcutKeyCount) {
    return `Use up to ${String(maxShortcutKeyCount)} keys`;
  }

  const trigger = keys.at(-1) ?? "";
  const modifiers = keys.slice(0, -1);
  const orderedModifiers = acceleratorModifierKeys.filter((modifier) => modifiers.includes(modifier));
  const hasOrderedModifiers = orderedModifiers.join(keySeparator) === modifiers.join(keySeparator);
  if (!isTriggerKeyCode(trigger) || trigger === editorEscapeKeyCode || !hasOrderedModifiers) {
    return "Unsupported key";
  }

  return null;
}
