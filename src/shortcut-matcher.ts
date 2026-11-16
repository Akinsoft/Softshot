import type { ShortcutBinding } from "./keyboard-hook-protocol";
import { acceleratorKey, acceleratorModifier } from "./keyboard-keys";
import type { ShortcutTarget } from "./shared";
import { acceleratorModifierKeys, isAcceleratorShortcut, isModifierKeyCode, shortcutKeys } from "./shortcut-keys";

const [, altModifier, , metaModifier] = acceleratorModifierKeys;
const menuOpeningModifiers: ReadonlySet<string> = new Set([altModifier, metaModifier]);
const suppressedKeyRepeatTimeoutMs = 1500;

export interface PressedKey {
  code: string;
  virtualKey: number;
}

export interface KeyDownDecision {
  isSuppressed: boolean;
  needsMenuMask: boolean;
  pressedTargets: ShortcutTarget[];
}

interface ShortcutPattern {
  modifiers: ReadonlySet<string>;
  target: ShortcutTarget;
  trigger: string;
  usesKeyCodes: boolean;
}

const passedKeyDown: KeyDownDecision = { isSuppressed: false, needsMenuMask: false, pressedTargets: [] };

function shortcutPattern({ shortcut, target }: ShortcutBinding): ShortcutPattern {
  const keys = shortcutKeys(shortcut);
  const [trigger, ...modifiers] = keys.toReversed();
  return { modifiers: new Set(modifiers), target, trigger, usesKeyCodes: !isAcceleratorShortcut(keys) };
}

function haveSameKeys(first: ReadonlySet<string>, second: ReadonlySet<string>): boolean {
  return first.size === second.size && [...first].every((key) => second.has(key));
}

export class ShortcutMatcher {
  private readonly heldKeys = new Map<string, number>();

  private patterns: ShortcutPattern[] = [];

  private readonly suppressedKeyTimes = new Map<string, number>();

  isRecording = false;

  constructor(private readonly isKeyHeld: (virtualKey: number) => boolean) {}

  private isStillHeld(code: string, virtualKey: number, atMs: number): boolean {
    const suppressedAtMs = this.suppressedKeyTimes.get(code) ?? null;
    return suppressedAtMs === null ? this.isKeyHeld(virtualKey) : atMs - suppressedAtMs <= suppressedKeyRepeatTimeoutMs;
  }

  private forgetReleasedKeys(atMs: number): void {
    for (const [code, virtualKey] of this.heldKeys) {
      if (this.isStillHeld(code, virtualKey, atMs)) {
        continue;
      }

      this.heldKeys.delete(code);
      this.suppressedKeyTimes.delete(code);
    }
  }

  private heldModifierCodes(): Set<string> {
    const codes = new Set<string>();
    for (const code of this.heldKeys.keys()) {
      if (isModifierKeyCode(code)) {
        codes.add(code);
      }
    }

    return codes;
  }

  private heldAcceleratorModifiers(): Set<string> {
    const modifiers = new Set<string>();
    for (const virtualKey of this.heldKeys.values()) {
      const modifier = acceleratorModifier(virtualKey);
      if (modifier !== null) {
        modifiers.add(modifier);
      }
    }

    return modifiers;
  }

  private pressedTargets(key: PressedKey, acceleratorModifiers: ReadonlySet<string>): ShortcutTarget[] {
    const modifierCodes = this.heldModifierCodes();
    const acceleratorTrigger = acceleratorKey(key.virtualKey);
    return this.patterns
      .filter((pattern) => pattern.usesKeyCodes
        ? pattern.trigger === key.code && haveSameKeys(pattern.modifiers, modifierCodes)
        : pattern.trigger === acceleratorTrigger && haveSameKeys(pattern.modifiers, acceleratorModifiers))
      .map((pattern) => pattern.target);
  }

  keyDown(key: PressedKey, atMs: number): KeyDownDecision {
    this.forgetReleasedKeys(atMs);
    if (this.heldKeys.has(key.code)) {
      const isSuppressed = this.suppressedKeyTimes.has(key.code);
      if (isSuppressed) {
        this.suppressedKeyTimes.set(key.code, atMs);
      }

      return { ...passedKeyDown, isSuppressed };
    }

    this.heldKeys.set(key.code, key.virtualKey);
    if (isModifierKeyCode(key.code)) {
      return passedKeyDown;
    }

    const acceleratorModifiers = this.heldAcceleratorModifiers();
    const pressedTargets = this.isRecording ? [] : this.pressedTargets(key, acceleratorModifiers);
    if (!this.isRecording && pressedTargets.length === 0) {
      return passedKeyDown;
    }

    this.suppressedKeyTimes.set(key.code, atMs);
    const needsMenuMask = [...acceleratorModifiers].some((modifier) => menuOpeningModifiers.has(modifier));
    return { isSuppressed: true, needsMenuMask, pressedTargets };
  }

  keyUp(code: string): boolean {
    this.heldKeys.delete(code);
    return this.suppressedKeyTimes.delete(code);
  }

  setShortcuts(bindings: readonly ShortcutBinding[]): void {
    this.patterns = bindings.map((binding) => shortcutPattern(binding));
  }
}
