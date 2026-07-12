import { recordingAudioChannelCount, recordingAudioSampleRate } from "./audio-quality.js";

const defaultDeviceId = "default";
const communicationsDeviceId = "communications";
const microphoneAliasPrefixes = ["Default - ", "Communications - "] as const;
const microphoneLabelPrefix = "Microphone";

export function audioInputDevices(devices: MediaDeviceInfo[]): MediaDeviceInfo[] {
  const seenDeviceKeys = new Set<string>();
  const uniqueDevices: MediaDeviceInfo[] = [];
  for (const device of devices) {
    if (device.kind !== "audioinput" || isVirtualMicrophoneAlias(device)) {
      continue;
    }

    const key = normalizedMicrophoneLabel(device) || device.deviceId;
    if (!seenDeviceKeys.has(key)) {
      seenDeviceKeys.add(key);
      uniqueDevices.push(device);
    }
  }

  return uniqueDevices;
}

export function displayMicrophoneLabel(device: MediaDeviceInfo, index: number): string {
  return device.label || `${microphoneLabelPrefix} ${String(index + 1)}`;
}

export function isDefaultMicrophoneDevice(deviceId: string): boolean {
  return deviceId === defaultDeviceId;
}

export function microphoneConstraints(deviceId: string): MediaTrackConstraints {
  const constraints: MediaTrackConstraints = {
    autoGainControl: false,
    channelCount: { ideal: recordingAudioChannelCount },
    echoCancellation: false,
    noiseSuppression: false,
    sampleRate: { ideal: recordingAudioSampleRate }
  };
  if (!isDefaultMicrophoneDevice(deviceId)) {
    constraints.deviceId = { exact: deviceId };
  }

  return constraints;
}

export function microphoneSelectionLabel(deviceId: string | null, devices: MediaDeviceInfo[]): string {
  if (deviceId === null) {
    return "Off";
  }

  if (isDefaultMicrophoneDevice(deviceId)) {
    return "Default";
  }

  const deviceIndex = devices.findIndex((device) => device.deviceId === deviceId);
  if (deviceIndex === -1) {
    return "Saved microphone";
  }

  return displayMicrophoneLabel(devices[deviceIndex], deviceIndex);
}

export function normalizeMicrophoneDeviceId(value: string): string | null {
  return value === "off" ? null : value;
}

export function microphoneDeviceOptionValue(deviceId: string | null): string {
  return deviceId ?? "off";
}

function isVirtualMicrophoneAlias(device: MediaDeviceInfo): boolean {
  return device.deviceId === defaultDeviceId
    || device.deviceId === communicationsDeviceId
    || microphoneAliasPrefixes.some((prefix) => device.label.startsWith(prefix));
}

function normalizedMicrophoneLabel(device: MediaDeviceInfo): string {
  let label = device.label.trim();
  for (const prefix of microphoneAliasPrefixes) {
    if (label.startsWith(prefix)) {
      label = label.slice(prefix.length).trim();
    }
  }

  return label;
}

export { defaultDeviceId };
