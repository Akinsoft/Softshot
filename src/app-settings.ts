import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AppSettings, ClipDurationSeconds, ClipQuality, ClipSettings, ClipSource, VideoFps } from "./shared";
import { clipDurationOptionsSeconds, clipQualities, videoFpsOptions } from "./shared";

const settingsFileName = "settings.json";
const settingsTemporaryFileName = `${settingsFileName}.tmp`;
const settingsIndentSpaces = 2;
const maxShortcutKeyCount = 3;
const maxWindowTitleLength = 260;
const defaultCaptureShortcut = "PrintScreen";
const defaultClipShortcut = "Alt+F10";
const defaultClipDurationSeconds: ClipDurationSeconds = 30;
const defaultClipQuality: ClipQuality = "1080p";
const defaultExportDirectory = null;
const defaultExportPresetId = null;
const defaultMicrophoneDeviceId = null;
const isSystemAudioEnabledByDefault = true;
const keySeparator = "+";
const exportPresetIdPattern = /^[a-z\d-]{1,40}$/u;
const clipSettingKeys = new Set([
  "directory",
  "durationSeconds",
  "enabled",
  "fps",
  "microphoneDeviceId",
  "quality",
  "shortcut",
  "source",
  "systemAudioEnabled"
]);

const modifierKeys = new Set(["Alt", "Control", "Meta", "Shift"]);
const clipDurationSet: ReadonlySet<unknown> = new Set(clipDurationOptionsSeconds);
const clipQualitySet: ReadonlySet<unknown> = new Set(clipQualities);

export function createDefaultAppSettings(isLaunchAtStartupEnabled: boolean): AppSettings {
  return {
    captureShortcut: defaultCaptureShortcut,
    clips: createDefaultClipSettings(),
    exportDirectory: defaultExportDirectory,
    exportPresetId: defaultExportPresetId,
    launchAtStartup: isLaunchAtStartupEnabled,
    microphoneDeviceId: defaultMicrophoneDeviceId,
    systemAudioEnabled: isSystemAudioEnabledByDefault
  };
}

function createDefaultClipSettings(): ClipSettings {
  return {
    directory: null,
    durationSeconds: defaultClipDurationSeconds,
    enabled: false,
    fps: videoFpsOptions.high,
    microphoneDeviceId: null,
    quality: defaultClipQuality,
    shortcut: defaultClipShortcut,
    source: { displayId: null, kind: "display" },
    systemAudioEnabled: true
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

function validateShortcut(shortcut: string, label: string): string {
  const keys = shortcut.split(keySeparator).map((key) => key.trim());
  if (keys.length === 0 || keys.some((key) => key.length === 0)) {
    throw new Error(`${label} cannot be empty.`);
  }

  if (keys.length > maxShortcutKeyCount) {
    throw new Error(`${label} can use up to three keys.`);
  }

  const uniqueKeys = new Set(keys);
  if (uniqueKeys.size !== keys.length) {
    throw new Error(`${label} cannot use the same key twice.`);
  }

  if (keys.every((key) => modifierKeys.has(key))) {
    throw new Error(`${label} needs one non-modifier key.`);
  }

  return keys.join(keySeparator);
}

export function validateCaptureShortcut(shortcut: string): string {
  return validateShortcut(shortcut, "Capture shortcut");
}

export function isTrueSetting(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`${label} must be true or false.`);
  }

  return value;
}

export function validateMicrophoneDeviceId(value: unknown): string | null {
  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new TypeError("Microphone device id must be a string or null.");
  }

  if (value.trim().length === 0) {
    throw new Error("Microphone device id cannot be empty.");
  }

  return value;
}

export function clipSettingsWithUpdate(current: ClipSettings, update: unknown): ClipSettings {
  if (!isJsonObject(update)) {
    throw new TypeError("Clip settings update must be an object.");
  }

  const updateKeys = Object.keys(update);
  if (updateKeys.length === 0 || updateKeys.some((key) => !clipSettingKeys.has(key))) {
    throw new Error("Clip settings update must contain only supported setting names.");
  }

  return clipSettingsFromObject(update, current);
}

function appSettingsFromJson(value: unknown, isLaunchAtStartupEnabled: boolean): AppSettings {
  if (!isJsonObject(value)) {
    throw new TypeError("Settings file must contain a JSON object.");
  }

  return {
    captureShortcut: captureShortcutFromJson(value),
    clips: clipSettingsFromJson(value),
    exportDirectory: exportDirectoryFromJson(value),
    exportPresetId: exportPresetIdFromJson(value),
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

function clipSettingsFromJson(value: Record<string, unknown>): ClipSettings {
  const defaults = createDefaultClipSettings();
  if (!("clips" in value)) {
    return defaults;
  }

  if (!isJsonObject(value.clips)) {
    throw new TypeError("Settings clips must be an object.");
  }

  return clipSettingsFromObject(value.clips, defaults);
}

function clipSettingsFromObject(value: Record<string, unknown>, base: ClipSettings): ClipSettings {
  return {
    directory: "directory" in value ? validateAbsoluteDirectory(value.directory, "Clips folder") : base.directory,
    durationSeconds: "durationSeconds" in value ? validateClipDuration(value.durationSeconds) : base.durationSeconds,
    enabled: "enabled" in value ? isTrueSetting(value.enabled, "Clips enabled") : base.enabled,
    fps: "fps" in value ? validateClipFps(value.fps) : base.fps,
    microphoneDeviceId: "microphoneDeviceId" in value
      ? validateMicrophoneDeviceId(value.microphoneDeviceId)
      : base.microphoneDeviceId,
    quality: "quality" in value ? validateClipQuality(value.quality) : base.quality,
    shortcut: "shortcut" in value ? validateClipShortcut(value.shortcut) : base.shortcut,
    source: "source" in value ? validateClipSource(value.source) : base.source,
    systemAudioEnabled: "systemAudioEnabled" in value
      ? isTrueSetting(value.systemAudioEnabled, "Clip desktop audio")
      : base.systemAudioEnabled
  };
}

function validateClipDuration(value: unknown): ClipDurationSeconds {
  if (clipDurationSet.has(value)) {
    return value as ClipDurationSeconds;
  }

  throw new TypeError(`Clip length must be one of ${clipDurationOptionsSeconds.join(", ")} seconds.`);
}

function validateClipFps(value: unknown): VideoFps {
  if (value === videoFpsOptions.standard || value === videoFpsOptions.high) {
    return value;
  }

  throw new TypeError("Clip frame rate must be 30 or 60 FPS.");
}

function validateClipQuality(value: unknown): ClipQuality {
  if (clipQualitySet.has(value)) {
    return value as ClipQuality;
  }

  throw new TypeError(`Clip quality must be one of ${clipQualities.join(", ")}.`);
}

function validateClipShortcut(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("Clip shortcut must be a string.");
  }

  return validateShortcut(value, "Clip shortcut");
}

function validateClipSource(value: unknown): ClipSource {
  if (!isJsonObject(value)) {
    throw new TypeError("Clip source must be an object.");
  }

  if (value.kind === "display") {
    if (value.displayId !== null && !Number.isSafeInteger(value.displayId)) {
      throw new TypeError("Clip monitor id must be a whole number or null.");
    }

    return { displayId: value.displayId as number | null, kind: "display" };
  }

  if (value.kind === "window") {
    if (typeof value.title !== "string" || value.title.length === 0 || value.title.length > maxWindowTitleLength) {
      throw new TypeError("Clip application title must be a non-empty string.");
    }

    if (value.processName !== null && (typeof value.processName !== "string" || value.processName.length === 0)) {
      throw new TypeError("Clip application process name must be a non-empty string or null.");
    }

    return { kind: "window", processName: value.processName, title: value.title };
  }

  throw new TypeError("Clip source must be a monitor or an application.");
}

function validateAbsoluteDirectory(value: unknown, label: string): string | null {
  if (value === null) {
    return null;
  }

  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new TypeError(`${label} must be an absolute path or null.`);
  }

  return value;
}

export function validateExportDirectory(value: unknown): string | null {
  return validateAbsoluteDirectory(value, "Export folder");
}

export function validateExportPresetId(value: unknown): string | null {
  if (value === null) {
    return null;
  }

  if (typeof value !== "string" || !exportPresetIdPattern.test(value)) {
    throw new TypeError("Export preset id must be a short preset name or null.");
  }

  return value;
}

function exportDirectoryFromJson(value: Record<string, unknown>): string | null {
  return "exportDirectory" in value ? validateExportDirectory(value.exportDirectory) : defaultExportDirectory;
}

function exportPresetIdFromJson(value: Record<string, unknown>): string | null {
  return "exportPresetId" in value ? validateExportPresetId(value.exportPresetId) : defaultExportPresetId;
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

  return isTrueSetting(value.launchAtStartup, "Settings launchAtStartup");
}

function microphoneDeviceIdFromJson(value: Record<string, unknown>): string | null {
  if (!("microphoneDeviceId" in value)) {
    return defaultMicrophoneDeviceId;
  }

  return validateMicrophoneDeviceId(value.microphoneDeviceId);
}

function isSystemAudioEnabledFromJson(value: Record<string, unknown>): boolean {
  if (!("systemAudioEnabled" in value)) {
    return isSystemAudioEnabledByDefault;
  }

  return isTrueSetting(value.systemAudioEnabled, "Settings systemAudioEnabled");
}

function settingsFilePath(userDataPath: string): string {
  return path.join(userDataPath, settingsFileName);
}
