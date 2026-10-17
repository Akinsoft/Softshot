import { type AppWindowContext, type AppWindowPage, microphoneOptions } from "./app-window-controls.js";
import { ShortcutButton } from "./app-window-shortcut.js";
import { normalizeMicrophoneDeviceId } from "./audio-devices.js";
import { getRequiredElement } from "./overlay-dom.js";
import type { AppSettings } from "./shared.js";

export class CapturePage implements AppWindowPage {
  private readonly microphoneSelect = getRequiredElement("capture-microphone-select", HTMLSelectElement);

  private readonly shortcutButton: ShortcutButton;

  private readonly systemAudioCheckbox = getRequiredElement("capture-system-audio-checkbox", HTMLInputElement);

  constructor(private readonly context: AppWindowContext) {
    this.shortcutButton = new ShortcutButton(
      getRequiredElement("capture-shortcut-button", HTMLButtonElement),
      getRequiredElement("capture-shortcut-status", HTMLSpanElement),
      "capture",
      (settings): void => {
        context.applySettings(settings);
      }
    );
  }

  bind(): void {
    this.shortcutButton.bind();
    this.microphoneSelect.addEventListener("change", (): void => {
      void this.context.updateSettings({
        microphoneDeviceId: normalizeMicrophoneDeviceId(this.microphoneSelect.value)
      });
    });
    this.systemAudioCheckbox.addEventListener("change", (): void => {
      void this.context.updateSettings({ systemAudioEnabled: this.systemAudioCheckbox.checked });
    });
  }

  render(settings: AppSettings): void {
    this.shortcutButton.render(settings.captureShortcut);
    this.systemAudioCheckbox.checked = settings.systemAudioEnabled;
    this.microphoneSelect.replaceChildren(
      ...microphoneOptions(this.context.microphoneDevices(), settings.microphoneDeviceId)
    );
  }
}
