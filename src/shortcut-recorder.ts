import { acceleratorKey, acceleratorModifier } from "./keyboard-keys";
import type { RawKeyboard, RawKeyEvent } from "./raw-keyboard";
import {
  acceleratorModifierKeys,
  isModifierKeyCode,
  keySeparator,
  maxShortcutKeyCount,
  modifierKeyCodes,
  shortcutKeys
} from "./shortcut-keys";

const escapeKeyCode = "Escape";

export type ShortcutRecorderEvent =
  | { message: string; type: "error" }
  | { shortcut: string; type: "preview" }
  | { shortcut: string; type: "recorded" }
  | { type: "cancelled" };

interface PressedKey {
  code: string;
  virtualKey: number;
}

function isPresent(value: string | null): value is string {
  return value !== null;
}

function optionalKey(key: string | null): string[] {
  return key === null ? [] : [key];
}

function recordedShortcut(modifiers: PressedKey[], trigger: PressedKey | null): string {
  const modifierNames = modifiers.map((modifier) => acceleratorModifier(modifier.virtualKey));
  const triggerName = trigger === null ? null : acceleratorKey(trigger.virtualKey);
  if (modifierNames.every((name) => isPresent(name)) && (trigger === null || triggerName !== null)) {
    const usedModifiers = new Set(modifierNames);
    return [...acceleratorModifierKeys.filter((key) => usedModifiers.has(key)), ...optionalKey(triggerName)].join(keySeparator);
  }

  const modifierCodes = new Set(modifiers.map((modifier) => modifier.code));
  return [...modifierKeyCodes.filter((code) => modifierCodes.has(code)), ...optionalKey(trigger?.code ?? null)].join(keySeparator);
}

export class ShortcutRecorder {
  private readonly heldKeys = new Map<string, PressedKey>();

  private stopListening: (() => void) | null = null;

  constructor(
    private readonly keyboard: RawKeyboard,
    private readonly onEvent: (event: ShortcutRecorderEvent) => void
  ) {}

  private handleKey(event: RawKeyEvent): void {
    const { code, virtualKey } = event;
    if (!event.isKeyDown) {
      if (code !== null) {
        this.heldKeys.delete(code);
      }

      return;
    }

    if (code === null) {
      this.onEvent({ message: "Unsupported key", type: "error" });
      return;
    }

    if (this.heldKeys.has(code)) {
      return;
    }

    this.heldKeys.set(code, { code, virtualKey });
    if (code === escapeKeyCode && this.heldKeys.size === 1) {
      this.onEvent({ type: "cancelled" });
      return;
    }

    const modifiers: PressedKey[] = [];
    for (const key of this.heldKeys.values()) {
      if (isModifierKeyCode(key.code)) {
        modifiers.push(key);
      }
    }

    const trigger = isModifierKeyCode(code) ? null : { code, virtualKey };
    const shortcut = recordedShortcut(modifiers, trigger);
    if (shortcutKeys(shortcut).length > maxShortcutKeyCount) {
      this.onEvent({ message: `Use up to ${String(maxShortcutKeyCount)} keys`, type: "error" });
      return;
    }

    this.onEvent(trigger === null ? { shortcut, type: "preview" } : { shortcut, type: "recorded" });
  }

  start(): void {
    if (this.stopListening !== null) {
      return;
    }

    this.heldKeys.clear();
    this.stopListening = this.keyboard.subscribe((event): void => {
      this.handleKey(event);
    });
  }

  stop(): void {
    if (this.stopListening === null) {
      return;
    }

    this.stopListening();
    this.stopListening = null;
  }
}
