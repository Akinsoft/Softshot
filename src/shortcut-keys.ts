export const keySeparator = "+";
export const maxShortcutKeyCount = 3;
export const acceleratorModifierKeys = ["Control", "Alt", "Shift", "Meta"] as const;
export const modifierKeyCodes = [
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "ShiftLeft",
  "ShiftRight",
  "MetaLeft",
  "MetaRight"
] as const;

const acceleratorModifierKeySet: ReadonlySet<string> = new Set(acceleratorModifierKeys);
const modifierKeyCodeSet: ReadonlySet<string> = new Set(modifierKeyCodes);

export function shortcutKeys(shortcut: string): string[] {
  return shortcut.split(keySeparator);
}

export function isModifierKey(key: string): boolean {
  return acceleratorModifierKeySet.has(key) || modifierKeyCodeSet.has(key);
}

export function isModifierKeyCode(key: string): boolean {
  return modifierKeyCodeSet.has(key);
}

export function isAcceleratorShortcut(keys: readonly string[]): boolean {
  return keys.slice(0, -1).every((key) => acceleratorModifierKeySet.has(key));
}
