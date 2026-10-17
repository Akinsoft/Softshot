import { defaultDeviceId, displayMicrophoneLabel, microphoneDeviceOptionValue } from "./audio-devices.js";
import type { AppPage, AppSettings, AppSettingsUpdate } from "./shared.js";

export interface AppWindowContext {
  applySettings(settings: AppSettings): void;
  microphoneDevices(): MediaDeviceInfo[];
  navigate(page: AppPage): void;
  settings(): AppSettings;
  showError(error: unknown): void;
  showMessage(message: string): void;
  updateSettings(update: AppSettingsUpdate): Promise<void>;
}

export interface AppWindowPage {
  render(settings: AppSettings): void;
}

export function selectOption(label: string, value: string, isSelected: boolean): HTMLOptionElement {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  option.selected = isSelected;
  return option;
}

export function microphoneOptions(devices: readonly MediaDeviceInfo[], selectedDeviceId: string | null): HTMLOptionElement[] {
  const isSavedDeviceUnavailable = selectedDeviceId !== null
    && selectedDeviceId !== defaultDeviceId
    && devices.every((device) => device.deviceId !== selectedDeviceId);
  return [
    microphoneOption("Off", null, selectedDeviceId),
    microphoneOption("Default", defaultDeviceId, selectedDeviceId),
    ...(isSavedDeviceUnavailable
      ? [microphoneOption("Unavailable microphone", selectedDeviceId, selectedDeviceId)]
      : []),
    ...devices.map((device, index) =>
      microphoneOption(displayMicrophoneLabel(device, index), device.deviceId, selectedDeviceId)
    )
  ];
}

export async function runWithErrorToast(context: AppWindowContext, task: Promise<void>): Promise<void> {
  try {
    await task;
  } catch (error) {
    context.showError(error);
  }
}

function microphoneOption(label: string, deviceId: string | null, selectedDeviceId: string | null): HTMLOptionElement {
  return selectOption(label, microphoneDeviceOptionValue(deviceId), selectedDeviceId === deviceId);
}
