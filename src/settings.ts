import type { AppSettings, AppSettingsUpdate, SettingsKeybindEvent, SoftshotApi } from "./shared";

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
type ElementConstructor<TElement extends HTMLElement> = new() => TElement;

class SettingsController {
  private readonly closeButton = getRequiredElement("settings-close-button", HTMLButtonElement);

  private readonly keybindButton = getRequiredElement("keybind-button", HTMLButtonElement);

  private readonly startupCheckbox = getRequiredElement("startup-checkbox", HTMLInputElement);

  private readonly status = getRequiredElement("settings-status", HTMLSpanElement);

  private isRecordingKeybind = false;

  private settings: AppSettings | null = null;

  private statusTimeout: ReturnType<typeof setTimeout> | null = null;

  private async beginKeybindRecording(): Promise<void> {
    if (this.isRecordingKeybind) {
      return;
    }

    await softshotApi().beginSettingsKeybindRecording();
    this.isRecordingKeybind = true;
    this.keybindButton.classList.add("recording");
    this.keybindButton.textContent = recordingButtonText;
    this.keybindButton.focus();
    this.setStatus("");
  }

  private finishKeybindRecording(): void {
    if (!this.isRecordingKeybind) {
      return;
    }

    this.isRecordingKeybind = false;
    this.keybindButton.classList.remove("recording");
    this.render();
  }

  private async endKeybindRecording(): Promise<void> {
    this.finishKeybindRecording();
    await softshotApi().endSettingsKeybindRecording();
  }

  private render(): void {
    if (!this.settings) {
      return;
    }

    this.startupCheckbox.checked = this.settings.launchAtStartup;

    if (!this.isRecordingKeybind) {
      this.keybindButton.textContent = displayShortcut(this.settings.captureShortcut);
    }
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
      this.status.textContent = "";
      this.statusTimeout = null;
    }, statusClearDelayMs);
  }

  private async updateSettings(update: AppSettingsUpdate): Promise<void> {
    const updatedSettings = await softshotApi().updateSettings(update);
    this.settings = updatedSettings;
    this.render();
    this.setStatus("");
  }

  private wireEvents(): void {
    this.closeButton.addEventListener("click", (): void => {
      void this.closeSettings();
    });

    this.keybindButton.addEventListener("click", (): void => {
      void this.beginKeybindRecording().catch(reportError);
    });

    this.startupCheckbox.addEventListener("change", (): void => {
      void this.updateLaunchAtStartup();
    });

    softshotApi().onSettingsKeybindEvent((event): void => {
      this.handleSettingsKeybindEvent(event);
    });
  }

  private async updateLaunchAtStartup(): Promise<void> {
    const isLaunchAtStartupEnabled = this.startupCheckbox.checked;
    this.startupCheckbox.disabled = true;

    try {
      await this.updateSettings({ launchAtStartup: isLaunchAtStartupEnabled });
    } catch (error) {
      this.startupCheckbox.checked = !isLaunchAtStartupEnabled;
      this.setTemporaryStatus(errorMessage(error));
    } finally {
      this.startupCheckbox.disabled = false;
    }
  }

  private async closeSettings(): Promise<void> {
    try {
      await softshotApi().closeSettings();
    } catch (error) {
      await reportError(error);
    }
  }

  private handleSettingsKeybindEvent(event: SettingsKeybindEvent): void {
    switch (event.type) {
      case "cancelled": {
        this.finishKeybindRecording();
        break;
      }

      case "error": {
        this.setTemporaryStatus(event.message);
        break;
      }

      case "preview": {
        this.keybindButton.textContent = displayShortcut(event.shortcut);
        break;
      }

      case "saved": {
        this.settings = event.settings;
        this.finishKeybindRecording();
        this.setStatus("");
        break;
      }

      default: {
        throw new Error(`Unexpected keybind event: ${JSON.stringify(event)}`);
      }
    }
  }

  async start(): Promise<void> {
    this.wireEvents();
    this.settings = await softshotApi().getSettings();
    this.render();
    await softshotApi().settingsReadyToShow();
  }
}

function displayShortcut(shortcut: string): string {
  return shortcut
    .split(keySeparator)
    .map((key) => displayNames.get(key) ?? key)
    .join(keySeparator);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function getRequiredElement<TElement extends HTMLElement>(
  id: string,
  expectedType: ElementConstructor<TElement>
): TElement {
  const value = document.querySelector(`#${id}`);
  if (!(value instanceof expectedType)) {
    throw new TypeError(`Missing element: ${id}.`);
  }

  return value;
}

async function reportError(error: unknown): Promise<void> {
  await softshotApi().showError(errorMessage(error));
}

function softshotApi(): SoftshotApi {
  return (globalThis as typeof globalThis & Window).softshot;
}

void new SettingsController().start().catch(async (error: unknown): Promise<void> => {
  await softshotApi().showError(errorMessage(error));
});
