import koffi from "koffi";

import { characterKeyScanCodes, characterKeyVirtualKeys, keyCodeFromScanCode, type ScanCodePrefix } from "./keyboard-keys";

const windowClassName = "SoftshotRawKeyboard";
const messageOnlyWindowParent = -3;
const inputMessage = 0x00_FF;
const rawInputDataCommand = 0x10_00_00_03;
const rawInputErrorResult = 0xFF_FF_FF_FF;
const keyboardInputType = 1;
const genericDesktopUsagePage = 0x01;
const keyboardUsage = 0x06;
const inputSinkFlag = 0x01_00;
const deviceRemovalFlag = 0x01;
const keyBreakFlag = 0x01;
const extendedKeyFlag = 0x02;
const pauseKeyFlag = 0x04;
const fakeVirtualKey = 0xFF;
const scanCodeToVirtualKeyMapping = 3;
const virtualKeyToCharacterMapping = 2;
const characterCodeLimit = 0x1_00_00;
const spaceCodePoint = 0x20;
const currentThreadId = 0;
const flagBitBase = 2;

const windowProcedureType = koffi.proto(
  "intptr_t __stdcall SoftshotKeyboardWindowProcedure(void *window, uint32_t message, uintptr_t wParam, intptr_t lParam)"
);
const windowClassType = koffi.struct("SoftshotKeyboardWindowClass", {
  size: "uint32_t",
  style: "uint32_t",
  windowProcedure: koffi.pointer(windowProcedureType),
  classExtraBytes: "int",
  windowExtraBytes: "int",
  instance: "void *",
  icon: "void *",
  cursor: "void *",
  background: "void *",
  menuName: "const char16_t *",
  className: "const char16_t *",
  smallIcon: "void *"
});
const rawInputDeviceType = koffi.struct("SoftshotRawInputDevice", {
  usagePage: "uint16_t",
  usage: "uint16_t",
  flags: "uint32_t",
  targetWindow: "void *"
});
const rawKeyboardInputType = koffi.struct("SoftshotRawKeyboardInput", {
  type: "uint32_t",
  size: "uint32_t",
  device: "void *",
  wParam: "uintptr_t",
  makeCode: "uint16_t",
  flags: "uint16_t",
  reserved: "uint16_t",
  virtualKey: "uint16_t",
  message: "uint32_t",
  extraInformation: "uint32_t"
});
const rawInputHeaderSize = koffi.offsetof(rawKeyboardInputType, "makeCode");

const user32 = koffi.load("user32.dll");
const kernel32 = koffi.load("kernel32.dll");

type MessageParameter = bigint | number;

const getModuleHandle: (name: null) => unknown = kernel32.func("void * __stdcall GetModuleHandleW(const char16_t *name)");
const registerClass: (windowClass: WindowClass) => number = user32.func(
  "uint16_t __stdcall RegisterClassExW(const SoftshotKeyboardWindowClass *windowClass)"
);
const createWindow: (
  extendedStyle: number,
  className: string,
  windowName: string,
  style: number,
  x: number,
  y: number,
  width: number,
  height: number,
  parent: number,
  menu: null,
  instance: unknown,
  parameter: null
) => unknown = user32.func(
  "void * __stdcall CreateWindowExW(uint32_t extendedStyle, const char16_t *className, const char16_t *windowName, uint32_t style, "
  + "int x, int y, int width, int height, intptr_t parent, void *menu, void *instance, void *parameter)"
);
const defaultWindowProcedure: (
  window: unknown,
  message: number,
  wordParameter: MessageParameter,
  longParameter: MessageParameter
) => MessageParameter = user32.func(
  "intptr_t __stdcall DefWindowProcW(void *window, uint32_t message, uintptr_t wParam, intptr_t lParam)"
);
const registerRawInputDevices: (devices: RawInputDevice[], count: number, size: number) => number = user32.func(
  "int __stdcall RegisterRawInputDevices(const SoftshotRawInputDevice *devices, uint32_t count, uint32_t size)"
);
const getRawInputData: (
  input: MessageParameter,
  command: number,
  data: RawKeyboardInput,
  size: [number],
  headerSize: number
) => number = user32.func(
  "uint32_t __stdcall GetRawInputData(intptr_t input, uint32_t command, _Out_ SoftshotRawKeyboardInput *data, "
  + "_Inout_ uint32_t *size, uint32_t headerSize)"
);
const getKeyboardLayout: (threadId: number) => unknown = user32.func("void * __stdcall GetKeyboardLayout(uint32_t threadId)");
const mapVirtualKey: (code: number, mapping: number, layout: unknown) => number = user32.func(
  "uint32_t __stdcall MapVirtualKeyExW(uint32_t code, uint32_t mapping, void *layout)"
);

interface WindowClass {
  background: null;
  className: string;
  classExtraBytes: number;
  cursor: null;
  icon: null;
  instance: unknown;
  menuName: null;
  size: number;
  smallIcon: null;
  style: number;
  windowExtraBytes: number;
  windowProcedure: unknown;
}

interface RawInputDevice {
  flags: number;
  targetWindow: unknown;
  usage: number;
  usagePage: number;
}

interface RawKeyboardInput {
  flags: number;
  makeCode: number;
  type: number;
  virtualKey: number;
}

export interface RawKeyEvent {
  code: string | null;
  isKeyDown: boolean;
  virtualKey: number;
}

type RawKeyListener = (event: RawKeyEvent) => void;

function hasFlag(value: number, flag: number): boolean {
  return Math.floor(value / flag) % flagBitBase === 1;
}

function scanCodePrefix(flags: number): ScanCodePrefix {
  if (hasFlag(flags, pauseKeyFlag)) {
    return "e1";
  }

  return hasFlag(flags, extendedKeyFlag) ? "e0" : "";
}

function characterLabel(mappedCharacter: number): string | null {
  const codePoint = mappedCharacter % characterCodeLimit;
  return codePoint > spaceCodePoint ? String.fromCodePoint(codePoint).toLocaleUpperCase() : null;
}

export class RawKeyboard {
  private readonly listeners = new Set<RawKeyListener>();

  private window: unknown = null;

  private windowProcedure: unknown = null;

  constructor(private readonly reportError: (error: unknown) => void) {}

  private messageWindow(): unknown {
    if (this.window !== null) {
      return this.window;
    }

    const instance = getModuleHandle(null);
    this.windowProcedure = koffi.register(
      (window: unknown, message: number, wordParameter: MessageParameter, longParameter: MessageParameter): MessageParameter =>
        this.handleWindowMessage(window, message, wordParameter, longParameter),
      koffi.pointer(windowProcedureType)
    );
    const windowClass: WindowClass = {
      background: null,
      className: windowClassName,
      classExtraBytes: 0,
      cursor: null,
      icon: null,
      instance,
      menuName: null,
      size: koffi.sizeof(windowClassType),
      smallIcon: null,
      style: 0,
      windowExtraBytes: 0,
      windowProcedure: this.windowProcedure
    };
    if (registerClass(windowClass) === 0) {
      throw new Error("Could not create the keyboard listener window class.");
    }

    const window = createWindow(0, windowClassName, "", 0, 0, 0, 0, 0, messageOnlyWindowParent, null, instance, null);
    if (window === null) {
      throw new Error("Could not create the keyboard listener window.");
    }

    this.window = window;
    return window;
  }

  private setDeviceRegistration(flags: number, targetWindow: unknown): void {
    const device: RawInputDevice = { flags, targetWindow, usage: keyboardUsage, usagePage: genericDesktopUsagePage };
    if (registerRawInputDevices([device], 1, koffi.sizeof(rawInputDeviceType)) === 0) {
      throw new Error("Could not listen to the keyboard.");
    }
  }

  private handleWindowMessage(
    window: unknown,
    message: number,
    wordParameter: MessageParameter,
    longParameter: MessageParameter
  ): MessageParameter {
    if (message === inputMessage) {
      try {
        this.handleInput(longParameter);
      } catch (error) {
        this.reportError(error);
      }
    }

    return defaultWindowProcedure(window, message, wordParameter, longParameter);
  }

  private handleInput(rawInput: MessageParameter): void {
    const input: RawKeyboardInput = { flags: 0, makeCode: 0, type: 0, virtualKey: 0 };
    const size: [number] = [koffi.sizeof(rawKeyboardInputType)];
    if (getRawInputData(rawInput, rawInputDataCommand, input, size, rawInputHeaderSize) === rawInputErrorResult) {
      throw new Error("Could not read keyboard input.");
    }

    if (input.type !== keyboardInputType) {
      throw new Error(`Unexpected raw input type ${String(input.type)}.`);
    }

    if (input.virtualKey === fakeVirtualKey) {
      return;
    }

    const event: RawKeyEvent = {
      code: keyCodeFromScanCode(input.makeCode, scanCodePrefix(input.flags)),
      isKeyDown: !hasFlag(input.flags, keyBreakFlag),
      virtualKey: input.virtualKey
    };
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  characterKeyLabels(): Record<string, string> {
    const layout = getKeyboardLayout(currentThreadId);
    const labels: Record<string, string> = {};
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

  subscribe(listener: RawKeyListener): () => void {
    if (this.listeners.size === 0) {
      this.setDeviceRegistration(inputSinkFlag, this.messageWindow());
    }

    this.listeners.add(listener);
    return (): void => {
      if (this.listeners.delete(listener) && this.listeners.size === 0) {
        this.setDeviceRegistration(deviceRemovalFlag, null);
      }
    };
  }
}
