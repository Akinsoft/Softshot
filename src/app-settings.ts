import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { isMissingFileError } from "./async-errors";
import { isTriggerKeyCode } from "./keyboard-keys";
import type {
  AppSettings,
  ClipDurationSeconds,
  ClipQuality,
  ClipSettings,
  ClipSourceKind,
  ClipWindowSelection,
  VideoFps
} from "./shared";
import { clipDurationOptionsSeconds, clipQualities, isClipSourceKind, videoFpsOptions } from "./shared";
import {
  isAcceleratorShortcut,
  isModifierKey,
  isModifierKeyCode,
  keySeparator,
  maxShortcutKeyCount,
  shortcutKeys
} from "./shortcut-keys";

const settingsFileName = "settings.json";
const settingsTemporaryFileName = `${settingsFileName}.tmp`;
const settingsIndentSpaces = 2;
const maxWindowTitleLength = 260;
const defaultCaptureShortcut = "PrintScreen";
const defaultClipShortcut = "Alt+F10";
const defaultClipDurationSeconds: ClipDurationSeconds = 30;
const defaultClipQuality: ClipQuality = "1080p";
const defaultExportDirectory = null;
const defaultExportPresetId = null;
const defaultMicrophoneDeviceId = null;
const isSystemAudioEnabledByDefault = true;
const isSidebarCollapsedByDefault = false;
const exportPresetIdPattern = /^[a-z\d-]{1,40}$/u;
const clipSettingKeys = new Set([
  "directory",
  "displayId",
  "durationSeconds",
  "enabled",
  "fps",
  "quality",
  "savedToastEnabled",
  "shortcut",
  "sourceKind",
  "window"
]);

const clipDurationSet: ReadonlySet<unknown> = new Set(clipDurationOptionsSeconds);
const clipQualitySet: ReadonlySet<unknown> = new Set(clipQualities);

function createDefaultAppSettings(isLaunchAtStartupEnabled: boolean): AppSettings {
  return {
    captureShortcut: defaultCaptureShortcut,
    clips: createDefaultClipSettings(),
    exportDirectory: defaultExportDirectory,
    exportPresetId: defaultExportPresetId,
    launchAtStartup: isLaunchAtStartupEnabled,
    microphoneDeviceId: defaultMicrophoneDeviceId,
    sidebarCollapsed: isSidebarCollapsedByDefault,
    systemAudioEnabled: isSystemAudioEnabledByDefault
  };
}

function createDefaultClipSettings(): ClipSettings {
  return {
    directory: null,
    displayId: null,
    durationSeconds: defaultClipDurationSeconds,
    enabled: false,
    fps: videoFpsOptions.high,
    quality: defaultClipQuality,
    savedToastEnabled: true,
    shortcut: defaultClipShortcut,
    sourceKind: "display",
    window: null
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
  const keys = shortcutKeys(shortcut).map((key) => key.trim());
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

  if (keys.every((key) => isModifierKey(key))) {
    throw new Error(`${label} needs one non-modifier key.`);
  }

  if (!isAcceleratorShortcut(keys)) {
    validateKeyChord(keys, label);
  }

  return keys.join(keySeparator);
}

function validateKeyChord(keys: string[], label: string): void {
  const [trigger, ...modifiers] = keys.toReversed();
  if (!isTriggerKeyCode(trigger) || modifiers.some((key) => !isModifierKeyCode(key))) {
    throw new Error(`${label} uses a key Softshot does not recognise.`);
  }
}

export function validateCaptureShortcut(shortcut: string): string {
  return validateShortcut(shortcut, "Quick Capture shortcut");
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
    sidebarCollapsed: isSidebarCollapsedFromJson(value),
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
  const settings: ClipSettings = {
    directory: "directory" in value ? validateAbsoluteDirectory(value.directory, "Clips folder") : base.directory,
    displayId: "displayId" in value ? validateClipDisplayId(value.displayId) : base.displayId,
    durationSeconds: "durationSeconds" in value ? validateClipDuration(value.durationSeconds) : base.durationSeconds,
    enabled: "enabled" in value ? isTrueSetting(value.enabled, "Clips enabled") : base.enabled,
    fps: "fps" in value ? validateClipFps(value.fps) : base.fps,
    quality: "quality" in value ? validateClipQuality(value.quality) : base.quality,
    savedToastEnabled: "savedToastEnabled" in value
      ? isTrueSetting(value.savedToastEnabled, "Saved clip popup")
      : base.savedToastEnabled,
    shortcut: "shortcut" in value ? validateClipShortcut(value.shortcut) : base.shortcut,
    sourceKind: "sourceKind" in value ? validateClipSourceKind(value.sourceKind) : base.sourceKind,
    window: "window" in value ? validateClipWindow(value.window) : base.window
  };
  if (settings.sourceKind === "window" && settings.window === null) {
    throw new Error("Choose an app for Clips to record.");
  }

  return settings;
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

function validateClipSourceKind(value: unknown): ClipSourceKind {
  if (isClipSourceKind(value)) {
    return value;
  }

  throw new TypeError("Clip source must be a monitor, an app or games.");
}

function validateClipDisplayId(value: unknown): number | null {
  if (value === null || Number.isSafeInteger(value)) {
    return value as number | null;
  }

  throw new TypeError("Clip monitor id must be a whole number or null.");
}

function validateClipWindow(value: unknown): ClipWindowSelection | null {
  if (value === null) {
    return null;
  }

  if (!isJsonObject(value)) {
    throw new TypeError("Clip app must be an object or null.");
  }

  if (typeof value.title !== "string" || value.title.length === 0 || value.title.length > maxWindowTitleLength) {
    throw new TypeError("Clip app title must be a non-empty string.");
  }

  if (value.processName !== null && (typeof value.processName !== "string" || value.processName.length === 0)) {
    throw new TypeError("Clip app process name must be a non-empty string or null.");
  }

  return { processName: value.processName, title: value.title };
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

function isSidebarCollapsedFromJson(value: Record<string, unknown>): boolean {
  if (!("sidebarCollapsed" in value)) {
    return isSidebarCollapsedByDefault;
  }

  return isTrueSetting(value.sidebarCollapsed, "Settings sidebarCollapsed");
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
