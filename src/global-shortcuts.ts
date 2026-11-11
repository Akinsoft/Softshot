import { globalShortcut } from "electron";

import type { RawKeyboard, RawKeyEvent } from "./raw-keyboard";
import { isAcceleratorShortcut, shortcutKeys } from "./shortcut-keys";

interface KeyChord {
  callback: () => void;
  key: string;
  modifiers: string[];
}

export function shortcutAccelerator(shortcut: string): string | null {
  return isAcceleratorShortcut(shortcutKeys(shortcut)) ? shortcut : null;
}

export class GlobalShortcuts {
  private readonly chords = new Map<string, KeyChord>();

  private readonly heldKeys = new Set<string>();

  private stopListening: (() => void) | null = null;

  constructor(private readonly keyboard: RawKeyboard) {}

  private handleKey(event: RawKeyEvent): void {
    const { code } = event;
    if (code === null) {
      return;
    }

    if (!event.isKeyDown) {
      this.heldKeys.delete(code);
      return;
    }

    if (this.heldKeys.has(code)) {
      return;
    }

    this.heldKeys.add(code);
    const matches: KeyChord[] = [];
    for (const chord of this.chords.values()) {
      if (chord.key === code && chord.modifiers.every((modifier) => this.heldKeys.has(modifier))) {
        matches.push(chord);
      }
    }

    const modifierCount = Math.max(...matches.map((chord) => chord.modifiers.length));
    const mostSpecificMatches = matches.filter((match) => match.modifiers.length === modifierCount);
    for (const chord of mostSpecificMatches) {
      chord.callback();
    }
  }

  private syncListening(): void {
    if (this.chords.size > 0 && this.stopListening === null) {
      this.heldKeys.clear();
      this.stopListening = this.keyboard.subscribe((event): void => {
        this.handleKey(event);
      });
      return;
    }

    if (this.chords.size === 0 && this.stopListening !== null) {
      this.stopListening();
      this.stopListening = null;
    }
  }

  register(shortcut: string, callback: () => void): boolean {
    if (shortcutAccelerator(shortcut) !== null) {
      return globalShortcut.register(shortcut, callback);
    }

    if (this.chords.has(shortcut)) {
      return false;
    }

    const [key, ...modifiers] = shortcutKeys(shortcut).toReversed();
    this.chords.set(shortcut, { callback, key, modifiers });
    try {
      this.syncListening();
    } catch (error) {
      this.chords.delete(shortcut);
      throw error;
    }

    return true;
  }

  unregister(shortcut: string): void {
    if (!this.chords.delete(shortcut)) {
      globalShortcut.unregister(shortcut);
      return;
    }

    this.syncListening();
  }

  unregisterAll(): void {
    globalShortcut.unregisterAll();
    this.chords.clear();
    this.syncListening();
  }
}
