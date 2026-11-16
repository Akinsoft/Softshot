import koffi from "koffi";

import { characterKeyScanCodes, characterKeyVirtualKeys } from "./keyboard-keys";
import type { ShortcutKeyLabels } from "./shared";

const scanCodeToVirtualKeyMapping = 3;
const virtualKeyToCharacterMapping = 2;
const characterCodeLimit = 0x1_00_00;
const spaceCodePoint = 0x20;
const currentThreadId = 0;

const user32 = koffi.load("user32.dll");

const getKeyboardLayout: (threadId: number) => unknown = user32.func("void * __stdcall GetKeyboardLayout(uint32_t threadId)");
const mapVirtualKey: (code: number, mapping: number, layout: unknown) => number = user32.func(
  "uint32_t __stdcall MapVirtualKeyExW(uint32_t code, uint32_t mapping, void *layout)"
);

function characterLabel(mappedCharacter: number): string | null {
  const codePoint = mappedCharacter % characterCodeLimit;
  return codePoint > spaceCodePoint ? String.fromCodePoint(codePoint).toLocaleUpperCase() : null;
}

export function characterKeyLabels(): ShortcutKeyLabels {
  const layout = getKeyboardLayout(currentThreadId);
  const labels: ShortcutKeyLabels = {};
  const addLabel = (key: string, virtualKey: number): void => {
    const label = characterLabel(mapVirtualKey(virtualKey, virtualKeyToCharacterMapping, layout));
    if (label !== null) {
      labels[key] = label;
    }
  };

  for (const [scanCode, code] of characterKeyScanCodes()) {
    addLabel(code, mapVirtualKey(scanCode, scanCodeToVirtualKeyMapping, layout));
  }

  for (const [virtualKey, key] of characterKeyVirtualKeys()) {
    addLabel(key, virtualKey);
  }

  return labels;
}
