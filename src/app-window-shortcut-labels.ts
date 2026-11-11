import type { ShortcutKeyLabels } from "./shared.js";
import { shortcutKeys } from "./shortcut-keys.js";

const shortcutTextSeparator = " + ";

const displayNames = new Map([
  ["AltLeft", "Left Alt"],
  ["AltRight", "Right Alt"],
  ["ArrowDown", "Down"],
  ["ArrowLeft", "Left"],
  ["ArrowRight", "Right"],
  ["ArrowUp", "Up"],
  ["AudioVolumeDown", "Volume Down"],
  ["AudioVolumeMute", "Volume Mute"],
  ["AudioVolumeUp", "Volume Up"],
  ["CapsLock", "Caps Lock"],
  ["ContextMenu", "Menu"],
  ["Control", "Ctrl"],
  ["ControlLeft", "Left Ctrl"],
  ["ControlRight", "Right Ctrl"],
  ["MediaNextTrack", "Next Track"],
  ["MediaPlayPause", "Play Pause"],
  ["MediaPreviousTrack", "Previous Track"],
  ["MediaStop", "Stop Media"],
  ["MediaTrackNext", "Next Track"],
  ["MediaTrackPrevious", "Previous Track"],
  ["Meta", "Win"],
  ["MetaLeft", "Left Win"],
  ["MetaRight", "Right Win"],
  ["NumLock", "Num Lock"],
  ["Numpad0", "Num 0"],
  ["Numpad1", "Num 1"],
  ["Numpad2", "Num 2"],
  ["Numpad3", "Num 3"],
  ["Numpad4", "Num 4"],
  ["Numpad5", "Num 5"],
  ["Numpad6", "Num 6"],
  ["Numpad7", "Num 7"],
  ["Numpad8", "Num 8"],
  ["Numpad9", "Num 9"],
  ["NumpadAdd", "Num +"],
  ["NumpadDecimal", "Num ."],
  ["NumpadDivide", "Num /"],
  ["NumpadEnter", "Num Enter"],
  ["NumpadMultiply", "Num *"],
  ["NumpadSubtract", "Num -"],
  ["num0", "Num 0"],
  ["num1", "Num 1"],
  ["num2", "Num 2"],
  ["num3", "Num 3"],
  ["num4", "Num 4"],
  ["num5", "Num 5"],
  ["num6", "Num 6"],
  ["num7", "Num 7"],
  ["num8", "Num 8"],
  ["num9", "Num 9"],
  ["numadd", "Num +"],
  ["numdec", "Num ."],
  ["numdiv", "Num /"],
  ["nummult", "Num *"],
  ["numsub", "Num -"],
  ["PrintScreen", "PrtSc"],
  ["ScrollLock", "Scroll Lock"],
  ["ShiftLeft", "Left Shift"],
  ["ShiftRight", "Right Shift"],
  ["VolumeDown", "Volume Down"],
  ["VolumeMute", "Volume Mute"],
  ["VolumeUp", "Volume Up"]
]);

export class ShortcutLabels {
  private readonly keyLabels: ReadonlyMap<string, string>;

  constructor(keyLabels: ShortcutKeyLabels) {
    this.keyLabels = new Map(Object.entries(keyLabels));
  }

  private keyName(key: string): string {
    return this.keyLabels.get(key) ?? displayNames.get(key) ?? key;
  }

  keycaps(shortcut: string): HTMLSpanElement {
    const keycaps = document.createElement("span");
    keycaps.className = "softshot-keycaps";
    keycaps.append(...shortcutKeys(shortcut).map((key) => {
      const keycap = document.createElement("kbd");
      keycap.className = "softshot-keycap";
      keycap.textContent = this.keyName(key);
      return keycap;
    }));
    return keycaps;
  }

  text(shortcut: string): string {
    return shortcutKeys(shortcut).map((key) => this.keyName(key)).join(shortcutTextSeparator);
  }
}
