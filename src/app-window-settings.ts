import { type AppWindowContext, type AppWindowPage, microphoneOptions } from "./app-window-controls.js";
import { normalizeMicrophoneDeviceId } from "./audio-devices.js";
import { getRequiredElement } from "./overlay-dom.js";
import type { AppSettings } from "./shared.js";

export class SettingsPage implements AppWindowPage {
  private readonly microphoneSelect = getRequiredElement("microphone-select", HTMLSelectElement);

  private readonly startupCheckbox = getRequiredElement("startup-checkbox", HTMLInputElement);

  private readonly systemAudioCheckbox = getRequiredElement("system-audio-checkbox", HTMLInputElement);

  constructor(private readonly context: AppWindowContext) {}

  bind(): void {
    this.startupCheckbox.addEventListener("change", (): void => {
      void this.context.updateSettings({ launchAtStartup: this.startupCheckbox.checked });
    });
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
    this.startupCheckbox.checked = settings.launchAtStartup;
    this.systemAudioCheckbox.checked = settings.systemAudioEnabled;
    this.microphoneSelect.replaceChildren(
      ...microphoneOptions(this.context.microphoneDevices(), settings.microphoneDeviceId)
    );
  }
}
