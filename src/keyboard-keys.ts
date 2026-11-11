import { acceleratorModifierKeys, isModifierKeyCode } from "./shortcut-keys";

const hexRadix = 16;
const hexByteLength = 2;
const firstDigitVirtualKey = 0x30;
const lastDigitVirtualKey = 0x39;
const firstLetterVirtualKey = 0x41;
const lastLetterVirtualKey = 0x5A;
const firstNumpadDigitVirtualKey = 0x60;
const lastNumpadDigitVirtualKey = 0x69;
const firstFunctionVirtualKey = 0x70;
const lastFunctionVirtualKey = 0x87;
const functionKeyNumberOffset = firstFunctionVirtualKey - 1;
const [controlModifier, altModifier, shiftModifier, metaModifier] = acceleratorModifierKeys;

export type ScanCodePrefix = "" | "e0" | "e1";

const characterScanCodes = new Map([
  ["02", "Digit1"],
  ["03", "Digit2"],
  ["04", "Digit3"],
  ["05", "Digit4"],
  ["06", "Digit5"],
  ["07", "Digit6"],
  ["08", "Digit7"],
  ["09", "Digit8"],
  ["0a", "Digit9"],
  ["0b", "Digit0"],
  ["0c", "Minus"],
  ["0d", "Equal"],
  ["10", "KeyQ"],
  ["11", "KeyW"],
  ["12", "KeyE"],
  ["13", "KeyR"],
  ["14", "KeyT"],
  ["15", "KeyY"],
  ["16", "KeyU"],
  ["17", "KeyI"],
  ["18", "KeyO"],
  ["19", "KeyP"],
  ["1a", "BracketLeft"],
  ["1b", "BracketRight"],
  ["1e", "KeyA"],
  ["1f", "KeyS"],
  ["20", "KeyD"],
  ["21", "KeyF"],
  ["22", "KeyG"],
  ["23", "KeyH"],
  ["24", "KeyJ"],
  ["25", "KeyK"],
  ["26", "KeyL"],
  ["27", "Semicolon"],
  ["28", "Quote"],
  ["29", "Backquote"],
  ["2b", "Backslash"],
  ["2c", "KeyZ"],
  ["2d", "KeyX"],
  ["2e", "KeyC"],
  ["2f", "KeyV"],
  ["30", "KeyB"],
  ["31", "KeyN"],
  ["32", "KeyM"],
  ["33", "Comma"],
  ["34", "Period"],
  ["35", "Slash"],
  ["56", "IntlBackslash"],
  ["73", "IntlRo"],
  ["7d", "IntlYen"]
]);

const namedScanCodes = new Map([
  ["01", "Escape"],
  ["0e", "Backspace"],
  ["0f", "Tab"],
  ["1c", "Enter"],
  ["1d", "ControlLeft"],
  ["2a", "ShiftLeft"],
  ["36", "ShiftRight"],
  ["37", "NumpadMultiply"],
  ["38", "AltLeft"],
  ["39", "Space"],
  ["3a", "CapsLock"],
  ["3b", "F1"],
  ["3c", "F2"],
  ["3d", "F3"],
  ["3e", "F4"],
  ["3f", "F5"],
  ["40", "F6"],
  ["41", "F7"],
  ["42", "F8"],
  ["43", "F9"],
  ["44", "F10"],
  ["45", "NumLock"],
  ["46", "ScrollLock"],
  ["47", "Numpad7"],
  ["48", "Numpad8"],
  ["49", "Numpad9"],
  ["4a", "NumpadSubtract"],
  ["4b", "Numpad4"],
  ["4c", "Numpad5"],
  ["4d", "Numpad6"],
  ["4e", "NumpadAdd"],
  ["4f", "Numpad1"],
  ["50", "Numpad2"],
  ["51", "Numpad3"],
  ["52", "Numpad0"],
  ["53", "NumpadDecimal"],
  ["57", "F11"],
  ["58", "F12"],
  ["64", "F13"],
  ["65", "F14"],
  ["66", "F15"],
  ["67", "F16"],
  ["68", "F17"],
  ["69", "F18"],
  ["6a", "F19"],
  ["6b", "F20"],
  ["6c", "F21"],
  ["6d", "F22"],
  ["6e", "F23"],
  ["70", "KanaMode"],
  ["76", "F24"],
  ["79", "Convert"],
  ["7b", "NonConvert"],
  ["e010", "MediaTrackPrevious"],
  ["e019", "MediaTrackNext"],
  ["e01c", "NumpadEnter"],
  ["e01d", "ControlRight"],
  ["e020", "AudioVolumeMute"],
  ["e022", "MediaPlayPause"],
  ["e024", "MediaStop"],
  ["e02e", "AudioVolumeDown"],
  ["e030", "AudioVolumeUp"],
  ["e035", "NumpadDivide"],
  ["e037", "PrintScreen"],
  ["e038", "AltRight"],
  ["e045", "NumLock"],
  ["e047", "Home"],
  ["e048", "ArrowUp"],
  ["e049", "PageUp"],
  ["e04b", "ArrowLeft"],
  ["e04d", "ArrowRight"],
  ["e04f", "End"],
  ["e050", "ArrowDown"],
  ["e051", "PageDown"],
  ["e052", "Insert"],
  ["e053", "Delete"],
  ["e05b", "MetaLeft"],
  ["e05c", "MetaRight"],
  ["e05d", "ContextMenu"],
  ["e11d", "Pause"]
]);

const scanCodeKeys = new Map([...characterScanCodes, ...namedScanCodes]);
const keyCodes: ReadonlySet<string> = new Set(scanCodeKeys.values());

const modifierVirtualKeys = new Map([
  ["10", shiftModifier],
  ["11", controlModifier],
  ["12", altModifier],
  ["5b", metaModifier],
  ["5c", metaModifier]
]);

const characterVirtualKeys = new Map([
  ["ba", ";"],
  ["bb", "Plus"],
  ["bc", ","],
  ["bd", "-"],
  ["be", "."],
  ["bf", "/"],
  ["c0", "`"],
  ["db", "["],
  ["dc", "\\"],
  ["dd", "]"],
  ["de", "'"]
]);

const namedVirtualKeys = new Map([
  ["08", "Backspace"],
  ["09", "Tab"],
  ["0d", "Enter"],
  ["1b", "Escape"],
  ["20", "Space"],
  ["21", "PageUp"],
  ["22", "PageDown"],
  ["23", "End"],
  ["24", "Home"],
  ["25", "Left"],
  ["26", "Up"],
  ["27", "Right"],
  ["28", "Down"],
  ["2c", "PrintScreen"],
  ["2d", "Insert"],
  ["2e", "Delete"],
  ["6a", "nummult"],
  ["6b", "numadd"],
  ["6d", "numsub"],
  ["6e", "numdec"],
  ["6f", "numdiv"],
  ["ad", "VolumeMute"],
  ["ae", "VolumeDown"],
  ["af", "VolumeUp"],
  ["b0", "MediaNextTrack"],
  ["b1", "MediaPreviousTrack"],
  ["b2", "MediaStop"],
  ["b3", "MediaPlayPause"]
]);

function hexCode(value: number): string {
  return value.toString(hexRadix).padStart(hexByteLength, "0");
}

function isInRange(value: number, first: number, last: number): boolean {
  return value >= first && value <= last;
}

export function keyCodeFromScanCode(makeCode: number, prefix: ScanCodePrefix): string | null {
  return scanCodeKeys.get(`${prefix}${hexCode(makeCode)}`) ?? null;
}

export function isTriggerKeyCode(key: string): boolean {
  return keyCodes.has(key) && !isModifierKeyCode(key);
}

export function acceleratorModifier(virtualKey: number): string | null {
  return modifierVirtualKeys.get(hexCode(virtualKey)) ?? null;
}

export function acceleratorKey(virtualKey: number): string | null {
  if (isInRange(virtualKey, firstDigitVirtualKey, lastDigitVirtualKey)
    || isInRange(virtualKey, firstLetterVirtualKey, lastLetterVirtualKey)) {
    return String.fromCodePoint(virtualKey);
  }

  if (isInRange(virtualKey, firstNumpadDigitVirtualKey, lastNumpadDigitVirtualKey)) {
    return `num${String(virtualKey - firstNumpadDigitVirtualKey)}`;
  }

  if (isInRange(virtualKey, firstFunctionVirtualKey, lastFunctionVirtualKey)) {
    return `F${String(virtualKey - functionKeyNumberOffset)}`;
  }

  const hexVirtualKey = hexCode(virtualKey);
  return characterVirtualKeys.get(hexVirtualKey) ?? namedVirtualKeys.get(hexVirtualKey) ?? null;
}

export function characterKeyScanCodes(): Array<[number, string]> {
  return [...characterScanCodes].map(([scanCode, code]) => [Number.parseInt(scanCode, hexRadix), code]);
}

export function characterKeyVirtualKeys(): Array<[number, string]> {
  return [...characterVirtualKeys].map(([virtualKey, key]) => [Number.parseInt(virtualKey, hexRadix), key]);
}
