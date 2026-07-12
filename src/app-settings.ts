import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AppSettings } from "./shared";

const settingsFileName = "settings.json";
const settingsTemporaryFileName = `${settingsFileName}.tmp`;
const settingsIndentSpaces = 2;
const maxShortcutKeyCount = 3;
const defaultCaptureShortcut = "PrintScreen";
const defaultMicrophoneDeviceId = null;
const isSystemAudioEnabledByDefault = true;
const keySeparator = "+";

const modifierKeys = new Set(["Alt", "Control", "Meta", "Shift"]);

export function createDefaultAppSettings(isLaunchAtStartupEnabled: boolean): AppSettings {
  return {
    captureShortcut: defaultCaptureShortcut,
    launchAtStartup: isLaunchAtStartupEnabled,
    microphoneDeviceId: defaultMicrophoneDeviceId,
    systemAudioEnabled: isSystemAudioEnabledByDefault
  };
}

export async function loadAppSettings(userDataPath: string, isLaunchAtStartupEnabled: boolean): Promise<AppSettings> {
  const filePath = settingsFilePath(userDataPath);
  try {
    return appSettingsFromJson(JSON.parse(await readFile(filePath, "utf8")), isLaunchAtStartupEnabled);
  } catch (error) {
    if (isMissingFileError(error)) {
      return createDefaultAppSettings(isLaunchAtStartupEnabled);
    }

    throw error;
  }
}

export async function saveAppSettings(userDataPath: string, settings: AppSettings): Promise<void> {
  const filePath = settingsFilePath(userDataPath);
  const temporaryFilePath = path.join(userDataPath, settingsTemporaryFileName);
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    await writeFile(temporaryFilePath, `${JSON.stringify(settings, null, settingsIndentSpaces)}\n`);
    await rename(temporaryFilePath, filePath);
  } finally {
    await rm(temporaryFilePath, { force: true });
  }
}

export function validateCaptureShortcut(shortcut: string): string {
  const keys = shortcut.split(keySeparator).map((key) => key.trim());
  if (keys.length === 0 || keys.some((key) => key.length === 0)) {
    throw new Error("Capture shortcut cannot be empty.");
  }

  if (keys.length > maxShortcutKeyCount) {
    throw new Error("Capture shortcut can use up to three keys.");
  }

  const uniqueKeys = new Set(keys);
  if (uniqueKeys.size !== keys.length) {
    throw new Error("Capture shortcut cannot use the same key twice.");
  }

  if (keys.every((key) => modifierKeys.has(key))) {
    throw new Error("Capture shortcut needs one non-modifier key.");
  }

  return keys.join(keySeparator);
}

function appSettingsFromJson(value: unknown, isLaunchAtStartupEnabled: boolean): AppSettings {
  if (!isJsonObject(value)) {
    throw new TypeError("Settings file must contain a JSON object.");
  }

  return {
    captureShortcut: captureShortcutFromJson(value),
    launchAtStartup: isLaunchAtStartupFromJson(value, isLaunchAtStartupEnabled),
    microphoneDeviceId: microphoneDeviceIdFromJson(value),
    systemAudioEnabled: isSystemAudioEnabledFromJson(value)
  };
}

function captureShortcutFromJson(value: Record<string, unknown>): string {
  if (!("captureShortcut" in value)) {
    return defaultCaptureShortcut;
  }

  if (typeof value.captureShortcut !== "string") {
    throw new TypeError("Settings captureShortcut must be a string.");
  }

  return validateCaptureShortcut(value.captureShortcut);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isLaunchAtStartupFromJson(value: Record<string, unknown>, isLaunchAtStartupEnabled: boolean): boolean {
  if (!("launchAtStartup" in value)) {
    return isLaunchAtStartupEnabled;
  }

  if (typeof value.launchAtStartup !== "boolean") {
    throw new TypeError("Settings launchAtStartup must be a boolean.");
  }

  return value.launchAtStartup;
}

function microphoneDeviceIdFromJson(value: Record<string, unknown>): string | null {
  if (!("microphoneDeviceId" in value)) {
    return defaultMicrophoneDeviceId;
  }

  if (value.microphoneDeviceId === null) {
    return null;
  }

  if (typeof value.microphoneDeviceId !== "string") {
    throw new TypeError("Settings microphoneDeviceId must be a string or null.");
  }

  if (value.microphoneDeviceId.trim().length === 0) {
    throw new Error("Settings microphoneDeviceId cannot be empty.");
  }

  return value.microphoneDeviceId;
}

function isSystemAudioEnabledFromJson(value: Record<string, unknown>): boolean {
  if (!("systemAudioEnabled" in value)) {
    return isSystemAudioEnabledByDefault;
  }

  if (typeof value.systemAudioEnabled !== "boolean") {
    throw new TypeError("Settings systemAudioEnabled must be a boolean.");
  }

  return value.systemAudioEnabled;
}

function settingsFilePath(userDataPath: string): string {
  return path.join(userDataPath, settingsFileName);
}
