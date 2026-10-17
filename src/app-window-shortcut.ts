import { errorMessage } from "./async-errors.js";
import type { AppSettings, ShortcutRecordingEvent, ShortcutTarget } from "./shared.js";
import { getSoftshotApi } from "./softshot-api.js";

const statusClearDelayMs = 1400;
const keySeparator = "+";
const recordingButtonText = "Press keys";

const displayNames = new Map([
  ["Control", "Ctrl"],
  ["Meta", "Win"],
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
  ["VolumeDown", "Volume Down"],
  ["VolumeMute", "Volume Mute"],
  ["VolumeUp", "Volume Up"]
]);

type ShortcutSavedHandler = (settings: AppSettings) => void;

export class ShortcutButton {
  private isRecording = false;

  private shortcut = "";

  private statusTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly button: HTMLButtonElement,
    private readonly status: HTMLElement,
    private readonly target: ShortcutTarget,
    private readonly onSaved: ShortcutSavedHandler
  ) {}

  private async begin(): Promise<void> {
    if (this.isRecording) {
      return;
    }

    await getSoftshotApi().beginShortcutRecording(this.target);
    this.isRecording = true;
    this.button.classList.add("recording");
    this.button.textContent = recordingButtonText;
    this.button.focus();
    this.setStatus("");
  }

  private finish(): void {
    if (!this.isRecording) {
      return;
    }

    this.isRecording = false;
    this.button.classList.remove("recording");
    this.button.replaceChildren(shortcutKeycaps(this.shortcut));
  }

  private setStatus(message: string): void {
    if (this.statusTimeout !== null) {
      clearTimeout(this.statusTimeout);
      this.statusTimeout = null;
    }

    this.status.textContent = message;
  }

  private setTemporaryStatus(message: string): void {
    this.setStatus(message);
    this.statusTimeout = setTimeout((): void => {
      this.statusTimeout = null;
      this.setStatus("");
    }, statusClearDelayMs);
  }

  private handleEvent(event: ShortcutRecordingEvent): void {
    switch (event.type) {
      case "cancelled": {
        this.finish();
        break;
      }

      case "error": {
        this.setTemporaryStatus(event.message);
        break;
      }

      case "preview": {
        this.button.replaceChildren(shortcutKeycaps(event.shortcut));
        break;
      }

      case "saved": {
        this.onSaved(event.settings);
        this.finish();
        this.setStatus("");
        break;
      }

      default: {
        throw new Error(`Unexpected shortcut recording event: ${JSON.stringify(event)}`);
      }
    }
  }

  bind(): void {
    this.button.addEventListener("click", (): void => {
      void this.begin().catch((error: unknown): void => {
        this.setTemporaryStatus(errorMessage(error));
      });
    });
    getSoftshotApi().onShortcutRecordingEvent((event): void => {
      if (event.target === this.target) {
        this.handleEvent(event);
      }
    });
  }

  render(shortcut: string): void {
    this.shortcut = shortcut;
    if (!this.isRecording) {
      this.button.replaceChildren(shortcutKeycaps(shortcut));
    }
  }
}

export function shortcutKeycaps(shortcut: string): HTMLSpanElement {
  const keycaps = document.createElement("span");
  keycaps.className = "softshot-keycaps";
  keycaps.append(...shortcut.split(keySeparator).map((key) => {
    const keycap = document.createElement("kbd");
    keycap.className = "softshot-keycap";
    keycap.textContent = displayNames.get(key) ?? key;
    return keycap;
  }));
  return keycaps;
}

export function shortcutText(shortcut: string): string {
  return shortcut.split(keySeparator).map((key) => displayNames.get(key) ?? key).join(" + ");
}
