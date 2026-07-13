import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, copyFile, link, mkdir, open, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  Display,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  screen,
  session,
  shell,
  Tray,
  webContents as electronWebContents
} from "electron";

import { loadAppSettings, saveAppSettings, validateCaptureShortcut } from "./app-settings";
import { startUpdateChecks } from "./app-updater";
import { remuxVideoEnd } from "./editor-remux";
import type {
  AppSettings,
  AudioSourceKind,
  CapturePipeline,
  EditorAudioTrack,
  EditorBootstrap,
  OverlayBootstrap,
  PreparedVideoFile,
  RecordingAudioTrack,
  RecordingEncoder,
  RecordingFile,
  SaveDialogResult,
  SaveResult,
  SettingsKeybindEvent,
  VideoFileExtension,
  VideoFps
} from "./shared";
import { videoFpsOptions } from "./shared";
import {
  recordingRetentionMs,
  shortLivedRecordingFilePrefix,
  shortLivedRecordingRetentionMs,
  standardRecordingRetentionMs
} from "./temporary-retention";
import { hasWebmCluster, webmClusterSignatureLength } from "./webm";

const appName = "Softshot";
const appId = "com.akinsoft.softshot";
const captureShortcutRetryDelayMs = 1000;
const captureShortcutRetryLimit = 12;
const keySeparator = "+";
const overlayReadyTimeoutMs = 15_000;
const captureOnReadyDelayMs = 300;
const timestampPartWidth = 2;
const pngSignature = Buffer.from("89504e470d0a1a0a", "hex");
const clipboardFileEnvironmentName = "SOFTSHOT_CLIPBOARD_FILE";
const clipboardFolderName = "clipboard";
const transparentWindowBackground = "#00000000";
const editorWindowWidthPx = 860;
const editorWindowHeightPx = 620;
const editorWindowMinWidthPx = 720;
const editorWindowMinHeightPx = 520;
const settingsWindowWidthPx = 380;
const settingsWindowHeightPx = 320;
const appIconRelativePath = path.join("src", "assets", "app-logo.ico");
const appLogoRelativePath = path.join("src", "assets", "app-logo.png");
const preloadScriptRelativePath = path.join("dist", "main", "preload.js");
const trayIconLogicalSizePx = 16;
const trayIconScaleFactor2x = 2;
const trayIconScaleFactor3x = 3;
const trayIconScaleFactors = [1, trayIconScaleFactor2x, trayIconScaleFactor3x] as const;
const powershellExecutable = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
const powershellClipboardTimeoutMs = 10_000;
const minimumRecordingByteLength = 1;
const webmScanChunkSizeBytes = 65_536;
const webmSignatureCarryByteLength = webmClusterSignatureLength - 1;
const mp4FileTypeSignature = new TextEncoder().encode("ftyp");
const mp4MediaDataSignature = new TextEncoder().encode("mdat");
const missingEditorRecordingDataMessage = "Missing editor recording data.";
const noKeyValue = "Unidentified";
const mediaPermissionName = "media";
const settingsKeybindEventChannel = "settings:keybind-event";
const settingsChangedEventChannel = "settings:changed";
const appSettingsUpdateKeys = new Set(["captureShortcut", "launchAtStartup", "microphoneDeviceId", "systemAudioEnabled"]);
const settingsKeybindShortcutRearmDelayMs = 250;
const maxCaptureShortcutKeyCount = 3;
const firstFunctionKey = 1;
const lastFunctionKey = 24;
const maxShortcutModifierKeyCount = maxCaptureShortcutKeyCount - 1;

const modifierShortcutKeys = ["Control", "Alt", "Shift", "Meta"] as const;
const modifierKeys = new Set<string>(modifierShortcutKeys);
const namedKeys = new Map([
  [" ", "Space"],
  ["AudioVolumeDown", "VolumeDown"],
  ["AudioVolumeMute", "VolumeMute"],
  ["AudioVolumeUp", "VolumeUp"],
  ["ArrowDown", "Down"],
  ["ArrowLeft", "Left"],
  ["ArrowRight", "Right"],
  ["ArrowUp", "Up"],
  ["Esc", "Escape"],
  ["MediaTrackNext", "MediaNextTrack"],
  ["MediaTrackPrevious", "MediaPreviousTrack"],
  ["PageDown", "PageDown"],
  ["PageUp", "PageUp"],
  ["PrintScreen", "PrintScreen"]
]);
const globalShortcutBaseKeys = [
  "Backspace",
  "Delete",
  "Down",
  "End",
  "Enter",
  "Escape",
  "Home",
  "Insert",
  "Left",
  "MediaNextTrack",
  "MediaPlayPause",
  "MediaPreviousTrack",
  "MediaStop",
  "PageDown",
  "PageUp",
  "PrintScreen",
  "Right",
  "Space",
  "Tab",
  "Up",
  "VolumeDown",
  "VolumeMute",
  "VolumeUp"
] as const;
const numpadKeys = new Map([
  ["Numpad0", "num0"],
  ["Numpad1", "num1"],
  ["Numpad2", "num2"],
  ["Numpad3", "num3"],
  ["Numpad4", "num4"],
  ["Numpad5", "num5"],
  ["Numpad6", "num6"],
  ["Numpad7", "num7"],
  ["Numpad8", "num8"],
  ["Numpad9", "num9"],
  ["NumpadAdd", "numadd"],
  ["NumpadDecimal", "numdec"],
  ["NumpadDivide", "numdiv"],
  ["NumpadMultiply", "nummult"],
  ["NumpadSubtract", "numsub"]
]);
const punctuationKeys = new Map([
  ["`", "`"],
  [",", "Comma"],
  ["-", "Minus"],
  [".", "Period"],
  ["/", "Slash"],
  [";", "Semicolon"],
  ["=", "Plus"],
  ["+", "Plus"]
]);
const globalShortcutNumpadKeys = [
  "num0",
  "num1",
  "num2",
  "num3",
  "num4",
  "num5",
  "num6",
  "num7",
  "num8",
  "num9",
  "numadd",
  "numdec",
  "numdiv",
  "nummult",
  "numsub"
] as const;
const globalShortcutPunctuationKeys = [
  "Comma",
  "Minus",
  "Period",
  "Plus",
  "Semicolon",
  "Slash"
] as const;
const globalShortcutSingleCharacterKeys = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split("");

interface PendingOverlayBootstrap {
  promise: Promise<OverlayBootstrap>;
  reject(error: Error): void;
  resolve(data: OverlayBootstrap): void;
}

interface RecordingTemporaryFile {
  byteLength: number;
  filePath: string;
  ownerWebContentsId: number;
}

interface RecordingAudioTrackFile extends RecordingAudioTrack {
  file: RecordingTemporaryFile;
}

interface SettingsUpdateOptions {
  captureShortcutRegistrationDelayMs?: number;
}

class SoftshotApp {
  private activeOverlay: BrowserWindow | null = null;

  private readonly activeEditorWindows = new Set<BrowserWindow>();

  private readonly editorDataByWebContents = new Map<number, EditorBootstrap>();

  private readonly editorOperationCountsByWebContents = new Map<number, number>();

  private readonly editorClipboardFilesByWebContents = new Map<number, string>();

  private readonly editorSavePathsByWebContents = new Map<number, Set<string>>();

  private readonly editorSavedFilesByWebContents = new Map<number, string>();

  private readonly editorSourceFilesByWebContents = new Map<number, string>();

  private readonly editorTempFilesByWebContents = new Map<number, Set<string>>();

  private readonly completedEditorWebContents = new Set<number>();

  private settings: AppSettings | null = null;

  private settingsUpdateChain: Promise<boolean> = Promise.resolve(true);

  private settingsKeybindRecordingWebContentsId: number | null = null;

  private isSettingsKeybindSaving = false;

  private readonly settingsKeybindRecorderShortcuts = new Set<string>();

  private settingsWindow: BrowserWindow | null = null;

  private readonly displayMediaDisplayIdsByWebContents = new Map<number, number>();

  private isCaptureShortcutUnavailable = false;

  private isQuitting = false;

  private liveCaptureOverlayWebContentsId: number | null = null;

  private readonly overlayDataByWebContents = new Map<number, OverlayBootstrap>();

  private readonly overlayBootstrapConsumedWebContents = new Set<number>();

  private readonly overlayLoadPromisesByWebContents = new Map<number, Promise<void>>();

  private readonly overlayReadyWebContentsIds = new Set<number>();

  private overlayOpenPromise: Promise<boolean> | null = null;

  private readonly pendingOverlayBootstrapsByWebContents = new Map<number, PendingOverlayBootstrap>();

  private isOverlayPreparationUnavailable = false;

  private preparedOverlay: BrowserWindow | null = null;

  private captureShortcutRetryAttempts = 0;

  private captureShortcutRetryTimeout: ReturnType<typeof setTimeout> | null = null;

  private readonly recordingTempFilesById = new Map<string, RecordingTemporaryFile>();

  private readonly temporaryFileDeletionTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  private registeredShortcuts: string[] = [];

  private tray: Tray | null = null;

  private capture(): void {
    if (this.requestActiveOverlayStop()) {
      return;
    }

    this.debugLog("capture requested");
    void this.openOverlayWithErrorHandling();
  }

  private closeSenderWindow(event: Electron.IpcMainInvokeEvent): void {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) {
      return;
    }

    window.close();
  }

  private assertEditorSavePath(webContentsId: number, filePath: string): void {
    if (this.editorSavePathsByWebContents.get(webContentsId)?.has(filePath)) {
      return;
    }

    throw new Error("The save path was not selected by this editor.");
  }

  private assertEditorTempFile(webContentsId: number, filePath: string): void {
    if (this.editorTempFilesByWebContents.get(webContentsId)?.has(filePath)) {
      return;
    }

    throw new Error("The prepared recording file does not belong to this editor.");
  }

  private registerEditorSavePath(webContentsId: number, filePath: string): void {
    const savePaths = this.editorSavePathsByWebContents.get(webContentsId) ?? new Set<string>();
    savePaths.add(filePath);
    this.editorSavePathsByWebContents.set(webContentsId, savePaths);
  }

  private registerEditorTempFile(webContentsId: number, filePath: string): void {
    const temporaryFiles = this.editorTempFilesByWebContents.get(webContentsId) ?? new Set<string>();
    temporaryFiles.add(filePath);
    this.editorTempFilesByWebContents.set(webContentsId, temporaryFiles);
  }

  private async runEditorOperation<T>(webContentsId: number, operation: () => Promise<T>): Promise<T> {
    const operationCount = (this.editorOperationCountsByWebContents.get(webContentsId) ?? 0) + 1;
    this.editorOperationCountsByWebContents.set(webContentsId, operationCount);
    try {
      return await operation();
    } finally {
      const remainingOperationCount = (this.editorOperationCountsByWebContents.get(webContentsId) ?? 1) - 1;
      if (remainingOperationCount === 0) {
        this.editorOperationCountsByWebContents.delete(webContentsId);
      } else {
        this.editorOperationCountsByWebContents.set(webContentsId, remainingOperationCount);
      }
    }
  }

  private async appendRecordingFileChunk(ownerWebContentsId: number, recordingId: string, bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength === 0) {
      throw new Error("Cannot append an empty recording chunk.");
    }

    const recordingFile = this.getRecordingTempFile(recordingId, ownerWebContentsId);
    await appendFile(recordingFile.filePath, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    recordingFile.byteLength += bytes.byteLength;
  }

  private async replaceFileAtomically(targetFilePath: string, writeTemporaryFile: (filePath: string) => Promise<void>): Promise<void> {
    const temporaryFilePath = path.join(
      path.dirname(targetFilePath),
      `.softshot-${randomUUID()}.tmp`
    );
    try {
      await writeTemporaryFile(temporaryFilePath);
      await rename(temporaryFilePath, targetFilePath);
    } finally {
      await rm(temporaryFilePath, { force: true });
    }
  }

  private async createRecordingFile(ownerWebContentsId: number, fileExtension: VideoFileExtension): Promise<RecordingFile> {
    const id = randomUUID();
    const filePath = await this.createTemporaryVideoFilePath(fileExtension);
    await writeFile(filePath, "");
    if (!this.isRecordingFileOwnerActive(ownerWebContentsId)) {
      await rm(filePath, { force: true });
      throw new Error("The recording window closed before its output file was ready.");
    }

    this.recordingTempFilesById.set(id, {
      byteLength: 0,
      filePath,
      ownerWebContentsId
    });
    return { id };
  }

  private async discardRecordingFile(ownerWebContentsId: number, recordingId: string): Promise<void> {
    const recordingFile = this.takeRecordingTempFile(recordingId, ownerWebContentsId);
    await rm(recordingFile.filePath, { force: true });
  }

  private async fileHasWebmCluster(filePath: string): Promise<boolean> {
    let carry: Uint8Array = new Uint8Array();
    const stream = createReadStream(filePath, { highWaterMark: webmScanChunkSizeBytes });

    for await (const chunk of stream as AsyncIterable<Buffer>) {
      const scanBytes = joinedBytes(carry, chunk);
      if (hasWebmCluster(scanBytes)) {
        return true;
      }

      carry = trailingBytes(scanBytes, webmSignatureCarryByteLength);
    }

    return false;
  }

  private async fileHasMp4Media(filePath: string): Promise<boolean> {
    return await this.fileContainsSignature(filePath, mp4FileTypeSignature)
      && await this.fileContainsSignature(filePath, mp4MediaDataSignature);
  }

  private async fileContainsSignature(filePath: string, signature: Uint8Array): Promise<boolean> {
    let carry: Uint8Array = new Uint8Array();
    const stream = createReadStream(filePath, { highWaterMark: webmScanChunkSizeBytes });
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      const scanBytes = joinedBytes(carry, chunk);
      if (hasByteSignature(scanBytes, signature)) {
        return true;
      }

      carry = trailingBytes(scanBytes, signature.byteLength - 1);
    }

    return false;
  }

  private getRecordingTempFile(recordingId: string, ownerWebContentsId: number): RecordingTemporaryFile {
    const recordingFile = this.recordingTempFilesById.get(recordingId);
    if (recordingFile?.ownerWebContentsId !== ownerWebContentsId) {
      throw new Error("The recording file does not belong to this capture session.");
    }

    return recordingFile;
  }

  private async hasUsableRecordingFile(recordingFile: RecordingTemporaryFile, mimeType: string): Promise<boolean> {
    if (recordingFile.byteLength < minimumRecordingByteLength) {
      return false;
    }

    return mimeType.startsWith("video/mp4")
      ? await this.fileHasMp4Media(recordingFile.filePath)
      : await this.fileHasWebmCluster(recordingFile.filePath);
  }

  private takeRecordingTempFile(recordingId: string, ownerWebContentsId: number): RecordingTemporaryFile {
    const recordingFile = this.getRecordingTempFile(recordingId, ownerWebContentsId);
    this.recordingTempFilesById.delete(recordingId);
    return recordingFile;
  }

  private takeRecordingTempFiles(recordingIds: string[], ownerWebContentsId: number): RecordingTemporaryFile[] {
    if (new Set(recordingIds).size !== recordingIds.length) {
      throw new Error("Recording file ids must be unique.");
    }

    const files = recordingIds.map((recordingId) => this.getRecordingTempFile(recordingId, ownerWebContentsId));
    for (const recordingId of recordingIds) {
      this.recordingTempFilesById.delete(recordingId);
    }

    return files;
  }

  private takeRecordingTempFilesForOwner(ownerWebContentsId: number): RecordingTemporaryFile[] {
    const files: RecordingTemporaryFile[] = [];
    for (const [recordingId, recordingFile] of this.recordingTempFilesById) {
      if (recordingFile.ownerWebContentsId !== ownerWebContentsId) {
        continue;
      }

      this.recordingTempFilesById.delete(recordingId);
      files.push(recordingFile);
    }

    return files;
  }

  private hasRecordingTempFilesForOwner(ownerWebContentsId: number): boolean {
    for (const file of this.recordingTempFilesById.values()) {
      if (file.ownerWebContentsId === ownerWebContentsId) {
        return true;
      }
    }

    return false;
  }

  private isRecordingFileOwnerActive(ownerWebContentsId: number): boolean {
    const contents = electronWebContents.fromId(ownerWebContentsId);
    if (!contents || contents.isDestroyed()) {
      return false;
    }

    const ownerWindow = BrowserWindow.fromWebContents(contents);
    return ownerWindow === this.activeOverlay || (ownerWindow !== null && this.activeEditorWindows.has(ownerWindow));
  }

  private async cleanupAbandonedRecordingFiles(ownerWebContentsId: number, shouldPreserveData: boolean): Promise<void> {
    const files = this.takeRecordingTempFilesForOwner(ownerWebContentsId);
    const cleanupResults = await Promise.allSettled(files.map(async (file): Promise<void> => {
      if (shouldPreserveData && file.byteLength > 0) {
        if (!this.isQuitting) {
          this.notifyRecoverableRecording(file.filePath);
        }

        return;
      }

      await rm(file.filePath, { force: true });
    }));
    const errors = cleanupResults.flatMap((result): unknown[] =>
      result.status === "rejected" ? [result.reason as unknown] : []
    );
    if (errors.length > 0) {
      throw new AggregateError(errors, "Could not clean up all abandoned recording files.");
    }
  }

  private createOverlayWindow(display: Display): BrowserWindow {
    return new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreen: true,
      fullscreenable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      backgroundColor: transparentWindowBackground,
      hasShadow: false,
      transparent: true,
      webPreferences: {
        preload: this.preloadScriptPath(),
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false
      }
    });
  }

  private createEditorWindow(): BrowserWindow {
    return new BrowserWindow({
      width: editorWindowWidthPx,
      height: editorWindowHeightPx,
      minWidth: editorWindowMinWidthPx,
      minHeight: editorWindowMinHeightPx,
      frame: false,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: "#15171a",
      icon: this.appIconPath(),
      title: appName,
      webPreferences: {
        preload: this.preloadScriptPath(),
        contextIsolation: true,
        nodeIntegration: false
      }
    });
  }

  private createSettingsWindow(): BrowserWindow {
    return new BrowserWindow({
      width: settingsWindowWidthPx,
      height: settingsWindowHeightPx,
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: "#15171a",
      icon: this.appIconPath(),
      title: appName,
      webPreferences: {
        preload: this.preloadScriptPath(),
        contextIsolation: true,
        nodeIntegration: false
      }
    });
  }

  private createTray(): Tray {
    const currentTray = new Tray(this.createTrayImage());
    currentTray.setToolTip(appName);
    currentTray.setContextMenu(Menu.buildFromTemplate(this.trayMenuTemplate()));
    return currentTray;
  }

  private createTrayImage(): Electron.NativeImage {
    const logoPath = this.appLogoPath();
    const sourceImage = nativeImage.createFromPath(logoPath);
    if (sourceImage.isEmpty()) {
      throw new Error(`Could not load app logo from ${logoPath}.`);
    }

    const trayImage = nativeImage.createEmpty();
    for (const scaleFactor of trayIconScaleFactors) {
      const size = trayIconLogicalSizePx * scaleFactor;
      const representation = sourceImage.resize({ height: size, quality: "best", width: size });
      trayImage.addRepresentation({ dataURL: representation.toDataURL(), scaleFactor });
    }

    if (trayImage.isEmpty()) {
      throw new Error(`Could not create tray icon from ${logoPath}.`);
    }

    trayImage.setTemplateImage(false);
    return trayImage;
  }

  private appLogoPath(): string {
    return path.join(app.getAppPath(), appLogoRelativePath);
  }

  private appIconPath(): string {
    return path.join(app.getAppPath(), appIconRelativePath);
  }

  private preloadScriptPath(): string {
    return path.join(app.getAppPath(), preloadScriptRelativePath);
  }

  private currentCaptureShortcut(): string {
    return this.currentSettings().captureShortcut;
  }

  private currentSettings(): AppSettings {
    if (!this.settings) {
      throw new Error("Softshot settings have not loaded.");
    }

    return this.settings;
  }

  private applyLaunchAtStartup(isEnabled: boolean): void {
    app.setLoginItemSettings({
      openAtLogin: isEnabled,
      path: app.getPath("exe")
    });

    const loginItemSettings = app.getLoginItemSettings();
    if (loginItemSettings.openAtLogin !== isEnabled) {
      throw new Error("Could not update launch at startup.");
    }
  }

  private debugLog(message: string): void {
    if (process.env.SOFTSHOT_DEBUG !== "1") {
      return;
    }

    process.stdout.write(`[softshot] ${message}\n`);
  }

  private async getDesktopSourceForDisplay(
    displayId: number,
    thumbnailSize?: Electron.Size
  ): Promise<Electron.DesktopCapturerSource> {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      fetchWindowIcons: false,
      thumbnailSize: thumbnailSize ?? { height: 0, width: 0 }
    });

    const source = sources.find((candidate) => candidate.display_id === String(displayId));
    if (source) {
      return source;
    }

    const availableIds = sources.map((candidate) => candidate.display_id || "(empty)").join(", ");
    throw new Error(`Could not match display ${String(displayId)} to a screen source. Available display ids: ${availableIds}.`);
  }

  private async captureFrozenScreenBytes(display: Display): Promise<Uint8Array> {
    const source = await this.getDesktopSourceForDisplay(display.id, {
      height: Math.round(display.bounds.height * display.scaleFactor),
      width: Math.round(display.bounds.width * display.scaleFactor)
    });
    if (source.thumbnail.isEmpty()) {
      throw new Error("Desktop capture did not provide a frozen screen image.");
    }

    return source.thumbnail.toPNG();
  }

  private getDisplayMediaDisplayId(request: Electron.DisplayMediaRequestHandlerHandlerRequest): number {
    if (!request.videoRequested) {
      throw new Error("Softshot display capture requires a video stream.");
    }

    if (!request.frame) {
      throw new Error("Softshot could not identify the display capture frame.");
    }

    const requestWebContents = electronWebContents.fromFrame(request.frame);
    if (!requestWebContents) {
      throw new Error("Softshot could not identify the display capture window.");
    }

    const displayId = this.displayMediaDisplayIdsByWebContents.get(requestWebContents.id);
    if (typeof displayId !== "number") {
      throw new TypeError("Softshot received an unexpected display capture request.");
    }

    return displayId;
  }

  private async handleDisplayMediaRequest(
    request: Electron.DisplayMediaRequestHandlerHandlerRequest,
    callback: (streams: Electron.Streams) => void
  ): Promise<void> {
    try {
      const displayId = this.getDisplayMediaDisplayId(request);
      const source = await this.getDesktopSourceForDisplay(displayId);
      const streams: Electron.Streams = { video: source };
      if (request.audioRequested) {
        streams.audio = "loopback";
      }

      callback(streams);
    } catch (error) {
      this.debugLog(`display media request failed: ${errorMessage(error)}`);
      callback({});
    }
  }

  private async getOverlayData(event: Electron.IpcMainInvokeEvent): Promise<OverlayBootstrap> {
    this.getOverlayWindowSender(event);
    if (this.overlayBootstrapConsumedWebContents.has(event.sender.id)) {
      throw new Error("The capture overlay bootstrap has already been consumed.");
    }

    const data = this.overlayDataByWebContents.get(event.sender.id);
    if (data) {
      this.overlayDataByWebContents.delete(event.sender.id);
      this.overlayBootstrapConsumedWebContents.add(event.sender.id);
      return data;
    }

    const pendingData = await this.waitForOverlayBootstrap(event.sender.id);
    this.overlayBootstrapConsumedWebContents.add(event.sender.id);
    return pendingData;
  }

  private getSenderOverlay(event: Electron.IpcMainInvokeEvent): BrowserWindow {
    const overlay = BrowserWindow.fromWebContents(event.sender);
    if (!overlay || overlay.isDestroyed()) {
      throw new Error("Missing overlay window.");
    }

    if (this.activeOverlay !== overlay) {
      throw new Error("Only the active capture overlay can change live capture state.");
    }

    return overlay;
  }

  private getOverlayWindowSender(event: Electron.IpcMainInvokeEvent): BrowserWindow {
    const overlay = BrowserWindow.fromWebContents(event.sender);
    if (!overlay || overlay.isDestroyed()) {
      throw new Error("Missing capture overlay window.");
    }

    if (this.activeOverlay === overlay || this.preparedOverlay === overlay) {
      return overlay;
    }

    throw new Error("Only a Softshot capture overlay can use overlay controls.");
  }

  private getRecordingFileSender(event: Electron.IpcMainInvokeEvent): BrowserWindow {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (!senderWindow || senderWindow.isDestroyed()) {
      throw new Error("Missing Softshot recording window.");
    }

    if (this.activeOverlay === senderWindow || this.activeEditorWindows.has(senderWindow)) {
      return senderWindow;
    }

    throw new Error("Only an active capture or editor window can write recording files.");
  }

  private handleOverlayReadinessTimeout(overlay: BrowserWindow): void {
    if (overlay.isDestroyed() || overlay.isVisible()) {
      return;
    }

    this.debugLog("overlay readiness timed out");
    overlay.close();
    void this.showErrorSafely("Could not open the capture overlay.", new Error("The overlay did not become ready in time."));
  }

  private loadOverlayWindow(overlay: BrowserWindow): void {
    const overlayWebContentsId = overlay.webContents.id;
    const loadPromise = this.loadOverlayWindowFile(overlay);
    this.overlayLoadPromisesByWebContents.set(overlayWebContentsId, loadPromise);
    void loadPromise.catch(async (error: unknown): Promise<void> => {
      this.debugLog(`prepared overlay load failed: ${errorMessage(error)}`);
      this.isOverlayPreparationUnavailable = true;
      await this.showErrorSafely("Could not prepare the capture overlay.", error);
      if (this.preparedOverlay === overlay) {
        this.preparedOverlay = null;
      }

      if (!overlay.isDestroyed()) {
        overlay.close();
      }
    });
  }

  private async loadOverlayWindowFile(overlay: BrowserWindow): Promise<void> {
    await overlay.loadFile(path.join(app.getAppPath(), "src", "overlay.html"));
    this.debugLog("overlay html loaded");
  }

  private prepareNextOverlay(): void {
    if (this.isQuitting || this.isOverlayPreparationUnavailable || this.activeOverlay || this.preparedOverlay) {
      return;
    }

    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const overlay = this.createOverlayWindow(display);
    this.preparedOverlay = overlay;
    this.trackOverlayWindow(overlay);
    this.wireOverlayDiagnostics(overlay);
    this.loadOverlayWindow(overlay);
  }

  private provideOverlayBootstrap(webContentsId: number, data: OverlayBootstrap): void {
    const pendingBootstrap = this.pendingOverlayBootstrapsByWebContents.get(webContentsId);
    if (!pendingBootstrap) {
      this.overlayDataByWebContents.set(webContentsId, data);
      return;
    }

    this.pendingOverlayBootstrapsByWebContents.delete(webContentsId);
    pendingBootstrap.resolve(data);
  }

  private async initializeWhenReady(): Promise<void> {
    try {
      await app.whenReady();
      app.setName(appName);
      app.setAppUserModelId(appId);
      this.settings = await loadAppSettings(app.getPath("userData"), app.getLoginItemSettings().openAtLogin);
      this.applyLaunchAtStartup(this.settings.launchAtStartup);
      this.registerPermissionRequestHandler();
      this.registerDisplayMediaRequestHandler();
      this.registerIpcHandlers();
      this.registerCaptureShortcuts();
      this.tray = this.createTray();
      void this.cleanupExpiredTemporaryRecordings().catch((error: unknown): void => {
        this.reportBackgroundError("Could not clean up expired temporary recordings.", error);
      });
      this.prepareNextOverlay();
      this.startUpdater();

      if (process.env.SOFTSHOT_CAPTURE_ON_READY === "1") {
        setTimeout((): void => {
          this.capture();
        }, captureOnReadyDelayMs);
      }
    } catch (error) {
      await this.showErrorSafely("Softshot could not start.", error);
      app.quit();
    }
  }

  private notifySaved(title: string, filePath: string): void {
    if (!Notification.isSupported()) {
      return;
    }

    new Notification({
      title,
      body: filePath
    }).show();
  }

  private notifyRecoverableRecording(filePath: string, retentionDescription = "7 days"): void {
    if (!Notification.isSupported()) {
      return;
    }

    const notification = new Notification({
      title: `Recording kept for ${retentionDescription}`,
      body: filePath
    });
    notification.on("click", (): void => {
      shell.showItemInFolder(filePath);
    });
    notification.show();
  }

  private recordingTempDirectory(): string {
    return path.join(app.getPath("temp"), appName, clipboardFolderName);
  }

  private async cleanupExpiredTemporaryRecordings(): Promise<void> {
    const targetDirectory = this.recordingTempDirectory();
    await mkdir(targetDirectory, { recursive: true });
    const entries = await readdir(targetDirectory, { withFileTypes: true });
    await Promise.all(entries.map(async (entry): Promise<void> => {
      if (!entry.isFile()) {
        return;
      }

      const filePath = path.join(targetDirectory, entry.name);
      const fileStats = await stat(filePath);
      const remainingRetentionMs = recordingRetentionMs(entry.name) - (Date.now() - fileStats.mtimeMs);
      if (remainingRetentionMs <= 0) {
        await rm(filePath, { force: true });
        return;
      }

      this.scheduleTemporaryFileDeletion(filePath, remainingRetentionMs);
    }));
  }

  private scheduleTemporaryFileDeletion(filePath: string, retentionMs: number): void {
    const previousTimeout = this.temporaryFileDeletionTimeouts.get(filePath);
    if (previousTimeout) {
      clearTimeout(previousTimeout);
    }

    const timeout = setTimeout((): void => {
      this.temporaryFileDeletionTimeouts.delete(filePath);
      void rm(filePath, { force: true }).catch((error: unknown): void => {
        this.reportBackgroundError("Could not delete an expired temporary recording.", error);
      });
    }, retentionMs);
    timeout.unref();
    this.temporaryFileDeletionTimeouts.set(filePath, timeout);
  }

  private async openRecordingTempDirectory(): Promise<void> {
    const targetDirectory = this.recordingTempDirectory();
    await mkdir(targetDirectory, { recursive: true });
    const error = await shell.openPath(targetDirectory);
    if (error) {
      throw new Error(error);
    }
  }

  private canInstallUpdatesNow(): boolean {
    return !this.activeOverlay
      && this.activeEditorWindows.size === 0
      && (!this.settingsWindow || this.settingsWindow.isDestroyed());
  }

  private requestActiveOverlayStop(): boolean {
    const overlay = this.activeOverlay;
    if (!overlay || overlay.isDestroyed() || overlay.webContents.id !== this.liveCaptureOverlayWebContentsId) {
      return false;
    }

    this.debugLog("forwarding capture request to live overlay");
    overlay.webContents.send("overlay:stop-recording");
    return true;
  }

  private scheduleCaptureShortcutRetry(): void {
    if (this.captureShortcutRetryTimeout !== null) {
      return;
    }

    if (this.captureShortcutRetryAttempts >= captureShortcutRetryLimit) {
      void this.showShortcutWarningWithErrorHandling();
      return;
    }

    this.captureShortcutRetryAttempts += 1;
    this.captureShortcutRetryTimeout = setTimeout((): void => {
      this.captureShortcutRetryTimeout = null;
      this.retryCaptureShortcut();
    }, captureShortcutRetryDelayMs);
  }

  private retryCaptureShortcut(): void {
    this.debugLog(`retrying ${this.currentCaptureShortcut()} shortcut registration`);

    if (this.registerCurrentCaptureShortcut()) {
      return;
    }

    this.scheduleCaptureShortcutRetry();
  }

  private setLiveCaptureMouseMode(overlay: BrowserWindow, isPassthrough: boolean): void {
    if (isPassthrough) {
      overlay.setIgnoreMouseEvents(true, { forward: true });
      overlay.setFocusable(false);
      overlay.blur();
      return;
    }

    overlay.setIgnoreMouseEvents(false);
    overlay.setFocusable(true);
    overlay.focus();
  }

  private setLiveCaptureMousePassthrough(event: Electron.IpcMainInvokeEvent, isPassthrough: boolean): void {
    if (typeof isPassthrough !== "boolean") {
      throw new TypeError("Live capture mouse passthrough state must be a boolean.");
    }

    if (event.sender.id !== this.liveCaptureOverlayWebContentsId) {
      throw new Error("Only the live capture overlay can change mouse passthrough state.");
    }

    this.setLiveCaptureMouseMode(this.getSenderOverlay(event), isPassthrough);
  }

  private setLiveCaptureState(event: Electron.IpcMainInvokeEvent, isLive: boolean): void {
    if (typeof isLive !== "boolean") {
      throw new TypeError("Live capture state must be a boolean.");
    }

    if (isLive) {
      const overlay = this.getSenderOverlay(event);
      this.liveCaptureOverlayWebContentsId = event.sender.id;
      this.setLiveCaptureMouseMode(overlay, false);
      return;
    }

    const overlay = this.getSenderOverlay(event);
    this.setLiveCaptureMouseMode(overlay, false);

    if (this.liveCaptureOverlayWebContentsId === event.sender.id) {
      this.liveCaptureOverlayWebContentsId = null;
    }
  }

  private startUpdater(): void {
    startUpdateChecks({
      canInstallNow: (): boolean => this.canInstallUpdatesNow(),
      log: (message: string): void => {
        this.debugLog(message);
      }
    });
  }

  private preparedOverlayForCapture(display: Display): BrowserWindow {
    if (!this.preparedOverlay || this.preparedOverlay.isDestroyed()) {
      this.isOverlayPreparationUnavailable = false;
      this.prepareNextOverlay();
    }

    const overlay = this.preparedOverlay;
    if (!overlay || overlay.isDestroyed()) {
      throw new Error("Could not prepare the capture overlay.");
    }

    overlay.setFullScreen(false);
    overlay.setBounds(display.bounds);
    this.preparedOverlay = null;
    return overlay;
  }

  private rejectOverlayBootstrap(webContentsId: number, error: Error): void {
    const pendingBootstrap = this.pendingOverlayBootstrapsByWebContents.get(webContentsId);
    if (!pendingBootstrap) {
      return;
    }

    this.pendingOverlayBootstrapsByWebContents.delete(webContentsId);
    pendingBootstrap.reject(error);
  }

  private trackOverlayWindow(overlay: BrowserWindow): void {
    const overlayWebContentsId = overlay.webContents.id;
    overlay.on("closed", (): void => {
      this.debugLog("overlay closed");
      this.overlayDataByWebContents.delete(overlayWebContentsId);
      this.overlayBootstrapConsumedWebContents.delete(overlayWebContentsId);
      this.displayMediaDisplayIdsByWebContents.delete(overlayWebContentsId);
      this.overlayLoadPromisesByWebContents.delete(overlayWebContentsId);
      this.overlayReadyWebContentsIds.delete(overlayWebContentsId);
      this.rejectOverlayBootstrap(overlayWebContentsId, new Error("The overlay closed before capture started."));
      void this.cleanupAbandonedRecordingFiles(overlayWebContentsId, true).catch((error: unknown): void => {
        this.reportBackgroundError("Could not clean up an abandoned recording.", error);
      });

      if (this.liveCaptureOverlayWebContentsId === overlayWebContentsId) {
        this.liveCaptureOverlayWebContentsId = null;
      }

      if (this.activeOverlay === overlay) {
        this.activeOverlay = null;
      }

      if (this.preparedOverlay === overlay) {
        this.preparedOverlay = null;
      }

      this.prepareNextOverlay();
    });
  }

  private async waitForOverlayBootstrap(webContentsId: number): Promise<OverlayBootstrap> {
    const pendingBootstrap = this.pendingOverlayBootstrapsByWebContents.get(webContentsId);
    if (pendingBootstrap) {
      return await pendingBootstrap.promise;
    }

    const {
      promise,
      reject: rejectBootstrap,
      resolve: resolveBootstrap
    } = Promise.withResolvers<OverlayBootstrap>();
    this.pendingOverlayBootstrapsByWebContents.set(webContentsId, {
      promise,
      reject: rejectBootstrap,
      resolve: resolveBootstrap
    });
    return await promise;
  }

  private async chooseScreenshotSavePath(event: Electron.IpcMainInvokeEvent): Promise<string | null> {
    const targetDirectory = path.join(app.getPath("pictures"), appName);
    await mkdir(targetDirectory, { recursive: true });

    const parentWindow = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.SaveDialogOptions = {
      defaultPath: path.join(targetDirectory, `${appName} ${this.timestamp()}.png`),
      filters: [
        {
          name: "PNG image",
          extensions: ["png"]
        }
      ],
      title: "Save screenshot"
    };
    const result = parentWindow && !parentWindow.isDestroyed()
      ? await dialog.showSaveDialog(parentWindow, options)
      : await dialog.showSaveDialog(options);

    if (result.canceled || !result.filePath) {
      return null;
    }

    return result.filePath;
  }

  private async chooseEditorVideoSavePath(event: Electron.IpcMainInvokeEvent): Promise<SaveDialogResult> {
    const targetDirectory = path.join(app.getPath("videos"), appName);
    await mkdir(targetDirectory, { recursive: true });

    const parentWindow = BrowserWindow.fromWebContents(event.sender);
    const editorData = this.editorDataByWebContents.get(event.sender.id);
    if (!editorData) {
      throw new Error(missingEditorRecordingDataMessage);
    }

    const fileExtension = videoFileExtension(editorData.mimeType);
    const options: Electron.SaveDialogOptions = {
      defaultPath: path.join(targetDirectory, `${appName} ${this.timestamp()}.${fileExtension}`),
      filters: [
        {
          name: fileExtension === "mp4" ? "MP4 video" : "WebM video",
          extensions: [fileExtension]
        }
      ],
      title: "Save recording"
    };
    const result = parentWindow && !parentWindow.isDestroyed()
      ? await dialog.showSaveDialog(parentWindow, options)
      : await dialog.showSaveDialog(options);

    if (result.canceled || !result.filePath) {
      return { filePath: null };
    }

    this.registerEditorSavePath(event.sender.id, result.filePath);
    return { filePath: result.filePath };
  }

  private async openKeyboardSettings(): Promise<void> {
    try {
      await shell.openExternal("ms-settings:easeofaccess-keyboard");
    } catch (error) {
      await this.showErrorSafely("Could not open Windows keyboard settings.", error);
    }
  }

  private async openOverlay(): Promise<void> {
    if (this.activeOverlay && !this.activeOverlay.isDestroyed()) {
      this.debugLog("focusing existing overlay");
      this.activeOverlay.focus();
      return;
    }

    this.debugLog("creating overlay");
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const overlay = this.preparedOverlayForCapture(display);
    overlay.setFullScreen(true);
    overlay.setAlwaysOnTop(true, "screen-saver");
    overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    overlay.setContentProtection(true);

    this.activeOverlay = overlay;
    const overlayWebContentsId = overlay.webContents.id;
    this.displayMediaDisplayIdsByWebContents.set(overlayWebContentsId, display.id);
    const readinessTimeout = setTimeout((): void => {
      this.handleOverlayReadinessTimeout(overlay);
    }, overlayReadyTimeoutMs);

    overlay.once("show", (): void => {
      clearTimeout(readinessTimeout);
    });
    overlay.once("closed", (): void => {
      clearTimeout(readinessTimeout);
    });

    if (this.overlayReadyWebContentsIds.has(overlayWebContentsId)) {
      this.showOverlayWindow(overlay);
    }

    try {
      const imageBytes = await this.captureFrozenScreenBytes(display);
      if (overlay.isDestroyed() || this.activeOverlay !== overlay) {
        return;
      }

      this.provideOverlayBootstrap(overlayWebContentsId, { imageBytes });
    } catch (error) {
      this.rejectOverlayBootstrap(
        overlayWebContentsId,
        error instanceof Error ? error : new Error(String(error))
      );
      if (!overlay.isDestroyed()) {
        overlay.close();
      }

      throw error;
    }
  }

  private async openOverlayWithErrorHandling(): Promise<void> {
    if (this.overlayOpenPromise) {
      await this.overlayOpenPromise;
      return;
    }

    const { promise: operation, resolve } = Promise.withResolvers<boolean>();
    this.overlayOpenPromise = operation;
    try {
      await this.openOverlay();
    } catch (error) {
      await this.showErrorSafely("Could not open the capture overlay.", error);
    } finally {
      resolve(true);
      if (this.overlayOpenPromise === operation) {
        this.overlayOpenPromise = null;
      }
    }
  }

  private showEditorWindow(editor: BrowserWindow): void {
    if (editor.isDestroyed()) {
      return;
    }

    if (!editor.isVisible()) {
      editor.show();
    }

    editor.focus();
  }

  private showSettingsWindow(settingsWindow: BrowserWindow): void {
    if (settingsWindow.isDestroyed()) {
      return;
    }

    if (!settingsWindow.isVisible()) {
      settingsWindow.show();
    }

    settingsWindow.focus();
  }

  private getSenderSettingsWindow(event: Electron.IpcMainInvokeEvent): BrowserWindow {
    const settingsWindow = BrowserWindow.fromWebContents(event.sender);
    if (!settingsWindow || settingsWindow.isDestroyed()) {
      throw new Error("Missing settings window.");
    }

    if (this.settingsWindow !== settingsWindow) {
      throw new Error("Only the active settings window can change settings.");
    }

    return settingsWindow;
  }

  private showOverlayWindow(overlay: BrowserWindow): void {
    if (overlay.isDestroyed() || this.activeOverlay !== overlay) {
      return;
    }

    if (!overlay.isVisible()) {
      overlay.show();
    }

    overlay.setFullScreen(true);
    overlay.setAlwaysOnTop(true, "screen-saver");
    overlay.focus();
  }

  private assertSenderWindow(event: Electron.IpcMainInvokeEvent): void {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (!senderWindow || senderWindow.isDestroyed()) {
      throw new Error("Missing Softshot window.");
    }
  }

  private async openSettingsWindow(): Promise<void> {
    if (this.settingsWindow && !this.settingsWindow.isDestroyed()) {
      this.showSettingsWindow(this.settingsWindow);
      return;
    }

    const settingsWindow = this.createSettingsWindow();
    const settingsWebContentsId = settingsWindow.webContents.id;
    this.settingsWindow = settingsWindow;
    settingsWindow.webContents.on("before-input-event", (event, input): void => {
      this.handleSettingsKeybindInput(settingsWindow, event, input);
    });

    settingsWindow.once("ready-to-show", (): void => {
      this.showSettingsWindow(settingsWindow);
    });

    settingsWindow.on("closed", (): void => {
      if (this.settingsKeybindRecordingWebContentsId === settingsWebContentsId) {
        this.stopSettingsKeybindRecording();
      }

      if (this.settingsWindow === settingsWindow) {
        this.settingsWindow = null;
      }
    });

    try {
      await settingsWindow.loadFile(path.join(app.getAppPath(), "src", "settings.html"));
      this.showSettingsWindow(settingsWindow);
    } catch (error) {
      if (!settingsWindow.isDestroyed()) {
        settingsWindow.close();
      }

      throw error;
    }
  }

  private emitSettingsKeybindEvent(settingsWindow: BrowserWindow, data: SettingsKeybindEvent): void {
    if (settingsWindow.isDestroyed() || settingsWindow.webContents.isDestroyed()) {
      return;
    }

    settingsWindow.webContents.send(settingsKeybindEventChannel, data);
  }

  private handleSettingsKeybindInput(settingsWindow: BrowserWindow, event: Electron.Event, input: Electron.Input): void {
    if (this.settingsKeybindRecordingWebContentsId !== settingsWindow.webContents.id) {
      return;
    }

    event.preventDefault();

    if (input.type !== "keyDown" || input.isAutoRepeat) {
      return;
    }

    const shortcut = shortcutFromInput(input);
    if (!shortcut) {
      this.emitSettingsKeybindEvent(settingsWindow, {
        message: "Unsupported key",
        type: "error"
      });
      return;
    }

    if (shortcut === "Escape") {
      this.stopSettingsKeybindRecording();
      this.emitSettingsKeybindEvent(settingsWindow, { type: "cancelled" });
      return;
    }

    if (shortcutKeyCount(shortcut) > maxCaptureShortcutKeyCount) {
      this.emitSettingsKeybindEvent(settingsWindow, {
        message: "Use up to 3 keys",
        type: "error"
      });
      return;
    }

    if (isModifierOnlyShortcut(shortcut)) {
      this.emitSettingsKeybindEvent(settingsWindow, {
        shortcut,
        type: "preview"
      });
      return;
    }

    void this.saveSettingsKeybind(settingsWindow, shortcut);
  }

  private async saveSettingsKeybind(settingsWindow: BrowserWindow, shortcut: string): Promise<void> {
    if (this.isSettingsKeybindSaving) {
      return;
    }

    this.isSettingsKeybindSaving = true;
    try {
      this.releaseSettingsKeybindRecorderShortcut(shortcut);
      const settings = await this.applySettingsUpdate(
        { captureShortcut: shortcut },
        { captureShortcutRegistrationDelayMs: settingsKeybindShortcutRearmDelayMs }
      );
      this.stopSettingsKeybindRecording();
      this.emitSettingsKeybindEvent(settingsWindow, {
        settings,
        type: "saved"
      });
    } catch (error) {
      this.emitSettingsKeybindEvent(settingsWindow, {
        message: errorMessage(error),
        type: "error"
      });
      this.registerSettingsKeybindRecorderShortcut(shortcut);
    } finally {
      this.isSettingsKeybindSaving = false;
    }
  }

  private saveSettingsKeybindFromShortcut(shortcut: string): void {
    const { settingsWindow } = this;
    if (!settingsWindow || settingsWindow.isDestroyed()) {
      return;
    }

    if (this.settingsKeybindRecordingWebContentsId !== settingsWindow.webContents.id) {
      return;
    }

    void this.saveSettingsKeybind(settingsWindow, shortcut);
  }

  private startSettingsKeybindRecording(event: Electron.IpcMainInvokeEvent): void {
    this.getSenderSettingsWindow(event);
    this.settingsKeybindRecordingWebContentsId = event.sender.id;
    this.clearCaptureShortcutRetry();
    this.unregisterRegisteredCaptureShortcuts();
    this.registerSettingsKeybindRecorderShortcuts();
    this.isCaptureShortcutUnavailable = false;
    this.refreshTrayMenu();
  }

  private stopSettingsKeybindRecording(event?: Electron.IpcMainInvokeEvent): void {
    if (event) {
      this.getSenderSettingsWindow(event);
      if (this.settingsKeybindRecordingWebContentsId !== event.sender.id) {
        return;
      }
    }

    if (this.settingsKeybindRecordingWebContentsId === null) {
      return;
    }

    this.settingsKeybindRecordingWebContentsId = null;
    this.unregisterSettingsKeybindRecorderShortcuts();
    this.captureShortcutRetryAttempts = 0;

    if (!this.registerCurrentCaptureShortcut()) {
      this.scheduleCaptureShortcutRetry();
    }
  }

  private registerSettingsKeybindRecorderShortcut(shortcut: string): void {
    if (this.settingsKeybindRecorderShortcuts.has(shortcut)) {
      return;
    }

    try {
      if (!globalShortcut.register(shortcut, (): void => {
        this.saveSettingsKeybindFromShortcut(shortcut);
      })) {
        return;
      }

      this.settingsKeybindRecorderShortcuts.add(shortcut);
    } catch (error) {
      this.debugLog(`could not register keybind recorder shortcut ${shortcut}: ${errorMessage(error)}`);
    }
  }

  private registerSettingsKeybindRecorderShortcuts(): void {
    for (const shortcut of settingsKeybindRecorderShortcuts()) {
      this.registerSettingsKeybindRecorderShortcut(shortcut);
    }
  }

  private releaseSettingsKeybindRecorderShortcut(shortcut: string): void {
    if (!this.settingsKeybindRecorderShortcuts.has(shortcut)) {
      return;
    }

    globalShortcut.unregister(shortcut);
    this.settingsKeybindRecorderShortcuts.delete(shortcut);
  }

  private unregisterSettingsKeybindRecorderShortcuts(): void {
    for (const shortcut of this.settingsKeybindRecorderShortcuts) {
      globalShortcut.unregister(shortcut);
    }

    this.settingsKeybindRecorderShortcuts.clear();
  }

  private settingsSnapshot(): AppSettings {
    return { ...this.currentSettings() };
  }

  private broadcastSettingsChanged(settings: AppSettings): void {
    const windows = [this.activeOverlay, this.preparedOverlay, this.settingsWindow];
    for (const window of windows) {
      if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
        try {
          window.webContents.send(settingsChangedEventChannel, settings);
        } catch (error) {
          this.reportBackgroundError("Could not notify an open window about updated settings.", error);
        }
      }
    }
  }

  private settingsWithUpdate(update: unknown): AppSettings {
    if (typeof update !== "object" || update === null || Array.isArray(update)) {
      throw new TypeError("Settings update must be an object.");
    }

    const updateKeys = Object.keys(update);
    if (updateKeys.length === 0 || updateKeys.some((key) => !appSettingsUpdateKeys.has(key))) {
      throw new Error("Settings update must contain only supported setting names.");
    }

    const currentSettings = this.currentSettings();
    const nextSettings: AppSettings = { ...currentSettings };

    if ("captureShortcut" in update) {
      if (typeof update.captureShortcut !== "string") {
        throw new TypeError("Capture shortcut must be a string.");
      }

      nextSettings.captureShortcut = validateCaptureShortcut(update.captureShortcut);
    }

    if ("launchAtStartup" in update) {
      if (typeof update.launchAtStartup !== "boolean") {
        throw new TypeError("Launch at startup must be a boolean.");
      }

      nextSettings.launchAtStartup = update.launchAtStartup;
    }

    if ("microphoneDeviceId" in update) {
      if (update.microphoneDeviceId !== null && typeof update.microphoneDeviceId !== "string") {
        throw new TypeError("Microphone device id must be a string or null.");
      }

      if (typeof update.microphoneDeviceId === "string" && update.microphoneDeviceId.trim().length === 0) {
        throw new Error("Microphone device id cannot be empty.");
      }

      nextSettings.microphoneDeviceId = update.microphoneDeviceId;
    }

    if ("systemAudioEnabled" in update) {
      if (typeof update.systemAudioEnabled !== "boolean") {
        throw new TypeError("System audio enabled must be a boolean.");
      }

      nextSettings.systemAudioEnabled = update.systemAudioEnabled;
    }

    return nextSettings;
  }

  private async applySettingsUpdate(update: unknown, options: SettingsUpdateOptions = {}): Promise<AppSettings> {
    const previousUpdate = this.settingsUpdateChain;
    const { promise, resolve } = Promise.withResolvers<boolean>();
    this.settingsUpdateChain = promise;
    await previousUpdate;
    try {
      return await this.applySettingsUpdateNow(update, options);
    } finally {
      resolve(true);
    }
  }

  private async applySettingsUpdateNow(update: unknown, options: SettingsUpdateOptions): Promise<AppSettings> {
    const { captureShortcutRegistrationDelayMs = 0 } = options;
    const previousSettings = this.settingsSnapshot();
    const nextSettings = this.settingsWithUpdate(update);

    try {
      this.settings = nextSettings;
      if (captureShortcutRegistrationDelayMs > 0) {
        await delay(captureShortcutRegistrationDelayMs);
      }

      this.updateRegisteredCaptureShortcut(previousSettings.captureShortcut, nextSettings.captureShortcut);
      this.applyLaunchAtStartup(nextSettings.launchAtStartup);
      await saveAppSettings(app.getPath("userData"), nextSettings);
      const savedSettings = this.settingsSnapshot();
      this.broadcastSettingsChanged(savedSettings);
      return savedSettings;
    } catch (error) {
      this.settings = previousSettings;
      const restoreErrors: unknown[] = [];
      try {
        if (!this.tryUpdateRegisteredCaptureShortcut(nextSettings.captureShortcut, previousSettings.captureShortcut)) {
          restoreErrors.push(new Error(`Could not restore ${previousSettings.captureShortcut}.`));
        }
      } catch (restoreError) {
        restoreErrors.push(restoreError);
      }

      try {
        this.applyLaunchAtStartup(previousSettings.launchAtStartup);
      } catch (restoreError) {
        restoreErrors.push(restoreError);
      }

      if (restoreErrors.length > 0) {
        throw new AggregateError(
          [error, ...restoreErrors],
          "The settings update failed and the previous settings could not be fully restored.",
          { cause: error }
        );
      }

      throw error;
    }
  }

  private async updateSettings(event: Electron.IpcMainInvokeEvent, update: unknown): Promise<AppSettings> {
    this.assertSenderWindow(event);
    return await this.applySettingsUpdate(update);
  }

  private updateRegisteredCaptureShortcut(previousShortcut: string, nextShortcut: string): void {
    if (this.tryUpdateRegisteredCaptureShortcut(previousShortcut, nextShortcut)) {
      return;
    }

    throw new Error(`Could not register ${nextShortcut}.`);
  }

  private tryUpdateRegisteredCaptureShortcut(previousShortcut: string, nextShortcut: string): boolean {
    if (previousShortcut === nextShortcut && this.registeredShortcuts.includes(nextShortcut)) {
      return true;
    }

    this.clearCaptureShortcutRetry();
    this.unregisterRegisteredCaptureShortcuts();
    this.captureShortcutRetryAttempts = 0;

    const isRegistered = this.registerCaptureShortcutValue(nextShortcut);
    if (!isRegistered) {
      this.scheduleCaptureShortcutRetry();
    }

    return isRegistered;
  }

  private async deleteRecordingFiles(recordingFile: RecordingTemporaryFile, audioTrackFiles: RecordingAudioTrackFile[]): Promise<void> {
    await Promise.all([
      rm(recordingFile.filePath, { force: true }),
      ...audioTrackFiles.map(async (audioTrackFile) => {
        await rm(audioTrackFile.file.filePath, { force: true });
      })
    ]);
  }

  private async editorAudioTracksFromRecordingFiles(audioTrackFiles: RecordingAudioTrackFile[]): Promise<EditorAudioTrack[]> {
    const editorAudioTracks: EditorAudioTrack[] = [];
    for (const audioTrackFile of audioTrackFiles) {
      if (!await this.hasUsableRecordingFile(audioTrackFile.file, audioTrackFile.mimeType)) {
        throw new Error(`${audioTrackLabel(audioTrackFile.kind)} did not contain usable audio data.`);
      }

      editorAudioTracks.push({
        kind: audioTrackFile.kind,
        mimeType: audioTrackFile.mimeType,
        sourceFilePath: audioTrackFile.file.filePath,
        sourceUrl: pathToFileURL(audioTrackFile.file.filePath).toString()
      });
    }

    return editorAudioTracks;
  }

  private editorAudioTrack(webContentsId: number, kind: AudioSourceKind): EditorAudioTrack {
    const editorData = this.editorDataByWebContents.get(webContentsId);
    const audioTrack = editorData?.audioTracks.find((candidate) => candidate.kind === kind);
    if (!audioTrack) {
      throw new Error("The requested audio track does not belong to this editor.");
    }

    return audioTrack;
  }

  private async editorAudioFileSize(webContentsId: number, kind: AudioSourceKind): Promise<number> {
    const fileStats = await stat(this.editorAudioTrack(webContentsId, kind).sourceFilePath);
    return fileStats.size;
  }

  private editorVideoFilePath(webContentsId: number): string {
    const editorData = this.editorDataByWebContents.get(webContentsId);
    if (!editorData) {
      throw new Error(missingEditorRecordingDataMessage);
    }

    return editorData.sourceFilePath;
  }

  private async editorVideoFileSize(webContentsId: number): Promise<number> {
    const fileStats = await stat(this.editorVideoFilePath(webContentsId));
    return fileStats.size;
  }

  private async readEditorFile(
    filePath: string,
    start: number,
    end: number,
    sourceLabel: string
  ): Promise<Uint8Array> {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) {
      throw new RangeError(`The ${sourceLabel} file byte range is invalid.`);
    }

    const file = await open(filePath, "r");
    try {
      const fileStats = await file.stat();
      if (end > fileStats.size) {
        throw new RangeError(`The ${sourceLabel} file byte range exceeds the source file.`);
      }

      const bytes = new Uint8Array(end - start);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, start);
      if (bytesRead !== bytes.length) {
        throw new Error(`The ${sourceLabel} source returned an incomplete byte range.`);
      }

      return bytes;
    } finally {
      await file.close();
    }
  }

  private async readEditorVideoFile(
    webContentsId: number,
    start: number,
    end: number
  ): Promise<Uint8Array> {
    return await this.readEditorFile(this.editorVideoFilePath(webContentsId), start, end, "video");
  }

  private async readEditorAudioFile(
    webContentsId: number,
    kind: AudioSourceKind,
    start: number,
    end: number
  ): Promise<Uint8Array> {
    const audioTrack = this.editorAudioTrack(webContentsId, kind);
    return await this.readEditorFile(audioTrack.sourceFilePath, start, end, "audio");
  }

  private async openVideoEditor(
    event: Electron.IpcMainInvokeEvent,
    recordingId: string,
    fps: VideoFps,
    durationSeconds: number,
    mimeType: string,
    encoder: RecordingEncoder,
    capturePipeline: CapturePipeline,
    audioTracks: RecordingAudioTrack[]
  ): Promise<void> {
    const recordingFiles = this.takeRecordingTempFiles(
      [recordingId, ...audioTracks.map((audioTrack) => audioTrack.recordingId)],
      event.sender.id
    );
    const recordingFile = recordingFiles[0];
    const audioTrackFiles = audioTracks.map((audioTrack, index): RecordingAudioTrackFile => ({
      ...audioTrack,
      file: recordingFiles[index + 1]
    }));
    let isRecordingFileOwnedByEditor = false;
    try {
      if (!await this.hasUsableRecordingFile(recordingFile, mimeType)) {
        throw new Error("The recording did not contain usable video data.");
      }

      const editorAudioTracks = await this.editorAudioTracksFromRecordingFiles(audioTrackFiles);
      const overlay = BrowserWindow.fromWebContents(event.sender);
      const editor = this.createEditorWindow();
      const editorWebContentsId = editor.webContents.id;
      this.activeEditorWindows.add(editor);
      this.editorDataByWebContents.set(editorWebContentsId, {
        audioTracks: editorAudioTracks,
        capturePipeline,
        durationSeconds,
        encoder,
        fps,
        mimeType,
        sourceFilePath: recordingFile.filePath,
        sourceUrl: pathToFileURL(recordingFile.filePath).toString()
      });
      this.editorSourceFilesByWebContents.set(editorWebContentsId, recordingFile.filePath);
      this.registerEditorTempFile(editorWebContentsId, recordingFile.filePath);
      for (const audioTrackFile of audioTrackFiles) {
        this.registerEditorTempFile(editorWebContentsId, audioTrackFile.file.filePath);
      }

      isRecordingFileOwnedByEditor = true;

      editor.once("ready-to-show", (): void => {
        this.showEditorWindow(editor);
      });

      editor.on("close", (closeEvent): void => {
        if (this.isQuitting
          || editor.webContents.isCrashed()
          || (!this.hasRecordingTempFilesForOwner(editorWebContentsId)
            && !this.editorOperationCountsByWebContents.has(editorWebContentsId))) {
          return;
        }

        closeEvent.preventDefault();
        void this.showErrorSafely(
          "Please wait for the current editor operation to finish before closing the editor."
        );
      });

      editor.on("closed", (): void => {
        this.activeEditorWindows.delete(editor);
        this.editorDataByWebContents.delete(editorWebContentsId);
        this.editorOperationCountsByWebContents.delete(editorWebContentsId);
        this.editorSavePathsByWebContents.delete(editorWebContentsId);
        void this.cleanupAbandonedRecordingFiles(editorWebContentsId, false).catch((error: unknown): void => {
          this.reportBackgroundError("Could not clean up an unfinished video export.", error);
        });
        void this.cleanupEditorTempFiles(
          editorWebContentsId,
          this.completedEditorWebContents.delete(editorWebContentsId)
        ).catch((error: unknown): void => {
          this.reportBackgroundError("Could not clean up temporary editor files.", error);
        });
      });

      try {
        await editor.loadFile(path.join(app.getAppPath(), "src", "editor.html"));
        this.showEditorWindow(editor);
      } catch (error) {
        if (!editor.isDestroyed()) {
          editor.close();
        }

        throw error;
      }

      if (overlay && !overlay.isDestroyed()) {
        overlay.close();
      }
    } catch (error) {
      if (!isRecordingFileOwnedByEditor) {
        await this.deleteRecordingFiles(recordingFile, audioTrackFiles);
      }

      throw error;
    }
  }

  private pngDataFromBytes(value: unknown): { buffer: Buffer; image: Electron.NativeImage } {
    if (!(value instanceof Uint8Array) || !hasByteSignatureAt(value, pngSignature, 0)) {
      throw new Error("Screenshots must contain valid PNG data.");
    }

    const buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    const image = nativeImage.createFromBuffer(buffer);
    if (image.isEmpty()) {
      throw new Error("Could not decode the screenshot PNG.");
    }

    return { buffer, image };
  }

  private clearCaptureShortcutRetry(): void {
    if (this.captureShortcutRetryTimeout === null) {
      return;
    }

    clearTimeout(this.captureShortcutRetryTimeout);
    this.captureShortcutRetryTimeout = null;
  }

  private refreshTrayMenu(): void {
    if (!this.tray) {
      return;
    }

    this.tray.setContextMenu(Menu.buildFromTemplate(this.trayMenuTemplate()));
  }

  private registerCaptureShortcut(shortcut: string): boolean {
    if (this.registeredShortcuts.includes(shortcut)) {
      return true;
    }

    const didRegisterShortcut = globalShortcut.register(shortcut, (): void => {
      this.capture();
    });

    return didRegisterShortcut;
  }

  private unregisterRegisteredCaptureShortcuts(): void {
    for (const shortcut of this.registeredShortcuts) {
      globalShortcut.unregister(shortcut);
    }

    this.registeredShortcuts = [];
  }

  private registerCaptureShortcutValue(shortcut: string): boolean {
    if (this.registerCaptureShortcut(shortcut)) {
      this.clearCaptureShortcutRetry();
      this.isCaptureShortcutUnavailable = false;
      this.captureShortcutRetryAttempts = 0;
      this.registeredShortcuts = [shortcut];
      this.refreshTrayMenu();
      return true;
    }

    this.isCaptureShortcutUnavailable = true;
    this.registeredShortcuts = [];
    this.refreshTrayMenu();
    return false;
  }

  private registerCurrentCaptureShortcut(): boolean {
    return this.registerCaptureShortcutValue(this.currentCaptureShortcut());
  }

  private registerCaptureShortcuts(): void {
    if (!this.registerCurrentCaptureShortcut()) {
      this.scheduleCaptureShortcutRetry();
    }
  }

  private registerPermissionRequestHandler(): void {
    session.defaultSession.setPermissionCheckHandler((webContents, permission): boolean =>
      permission === mediaPermissionName && this.isManagedMediaWebContents(webContents)
    );
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback): void => {
      callback(permission === mediaPermissionName && this.isManagedMediaWebContents(webContents));
    });
  }

  private isManagedMediaWebContents(webContents: Electron.WebContents | null): boolean {
    if (!webContents || webContents.isDestroyed()) {
      return false;
    }

    const window = BrowserWindow.fromWebContents(webContents);
    return window === this.activeOverlay;
  }

  private registerNavigationGuards(): void {
    app.on("web-contents-created", (...eventArguments): void => {
      const contents = eventArguments[1];
      contents.setWindowOpenHandler(() => ({ action: "deny" }));
      contents.on("will-navigate", (event): void => {
        event.preventDefault();
      });
    });
  }

  private registerDisplayMediaRequestHandler(): void {
    session.defaultSession.setDisplayMediaRequestHandler((request, callback): void => {
      void this.handleDisplayMediaRequest(request, callback);
    });
  }

  private registerIpcHandlers(): void {
    ipcMain.handle("overlay:get-bootstrap", async (event): Promise<OverlayBootstrap> => await this.getOverlayData(event));

    ipcMain.handle("overlay:close", (event): void => {
      this.getOverlayWindowSender(event);
      this.closeSenderWindow(event);
    });

    ipcMain.handle("overlay:ready-to-show", (event): void => {
      const overlay = this.getOverlayWindowSender(event);

      this.debugLog("overlay ready to show");
      this.overlayReadyWebContentsIds.add(event.sender.id);
      this.showOverlayWindow(overlay);
    });

    ipcMain.handle("overlay:set-live-capture", (event, isLive: boolean): void => {
      this.setLiveCaptureState(event, isLive);
    });

    ipcMain.handle("overlay:set-live-capture-mouse-passthrough", (event, isPassthrough: boolean): void => {
      this.setLiveCaptureMousePassthrough(event, isPassthrough);
    });

    ipcMain.handle("overlay:show-error", async (event, message: string): Promise<void> => {
      const parentWindow = BrowserWindow.fromWebContents(event.sender);
      const options: Electron.MessageBoxOptions = {
        message,
        title: appName,
        type: "error"
      };

      if (parentWindow && !parentWindow.isDestroyed()) {
        await dialog.showMessageBox(parentWindow, options);
        return;
      }

      await dialog.showMessageBox(options);
    });

    ipcMain.handle("capture:save-screenshot", async (event, bytes: unknown): Promise<SaveDialogResult> => {
      this.getSenderOverlay(event);
      const { buffer } = this.pngDataFromBytes(bytes);
      const filePath = await this.chooseScreenshotSavePath(event);
      if (!filePath) {
        return { filePath: null };
      }

      await this.replaceFileAtomically(filePath, async (temporaryFilePath): Promise<void> => {
        await writeFile(temporaryFilePath, buffer);
      });
      this.notifySaved("Screenshot saved", filePath);
      this.closeSenderWindow(event);
      return { filePath };
    });

    ipcMain.handle("capture:copy-screenshot", (event, bytes: unknown): void => {
      this.getSenderOverlay(event);
      const { image } = this.pngDataFromBytes(bytes);
      clipboard.writeImage(image);
      this.closeSenderWindow(event);
    });

    this.registerRecordingIpcHandlers();
    this.registerEditorIpcHandlers();
    this.registerSettingsIpcHandlers();
  }

  private registerRecordingIpcHandlers(): void {
    ipcMain.handle("recording:create-file", async (event, fileExtension: unknown): Promise<RecordingFile> => {
      this.getRecordingFileSender(event);
      return await this.createRecordingFile(event.sender.id, videoFileExtensionFromUnknown(fileExtension));
    });

    ipcMain.handle("recording:append-file-chunk", async (event, recordingId: unknown, bytes: unknown): Promise<void> => {
      this.getRecordingFileSender(event);
      if (!(bytes instanceof Uint8Array)) {
        throw new TypeError("Recording chunks must contain binary data.");
      }

      await this.appendRecordingFileChunk(event.sender.id, recordingIdFromUnknown(recordingId), bytes);
    });

    ipcMain.handle("recording:discard-file", async (event, recordingId: unknown): Promise<void> => {
      this.getRecordingFileSender(event);
      await this.discardRecordingFile(event.sender.id, recordingIdFromUnknown(recordingId));
    });

    ipcMain.handle(
      "recording:open-editor",
      async (
        event,
        recordingId: unknown,
        fps: unknown,
        durationSeconds: unknown,
        mimeType: unknown,
        encoder: unknown,
        capturePipeline: unknown,
        audioTracks: unknown
      ): Promise<void> => {
        this.getSenderOverlay(event);
        await this.openVideoEditor(
          event,
          recordingIdFromUnknown(recordingId),
          videoFpsFromUnknown(fps),
          recordingDurationFromUnknown(durationSeconds),
          videoMimeTypeFromUnknown(mimeType),
          recordingEncoderFromUnknown(encoder),
          capturePipelineFromUnknown(capturePipeline),
          recordingAudioTracksFromUnknown(audioTracks)
        );
      }
    );
  }

  private registerEditorVideoSourceIpcHandlers(): void {
    ipcMain.handle("editor:get-video-file-size", async (event): Promise<number> => {
      return await this.runEditorOperation(
        event.sender.id,
        async () => await this.editorVideoFileSize(event.sender.id)
      );
    });

    ipcMain.handle(
      "editor:read-video-file",
      async (event, start: unknown, end: unknown): Promise<Uint8Array> => {
        if (typeof start !== "number" || typeof end !== "number") {
          throw new TypeError("The video file byte range must contain numbers.");
        }

        return await this.runEditorOperation(
          event.sender.id,
          async () => await this.readEditorVideoFile(event.sender.id, start, end)
        );
      }
    );
  }

  private registerEditorIpcHandlers(): void {
    ipcMain.handle("editor:get-bootstrap", (event): EditorBootstrap => {
      const data = this.editorDataByWebContents.get(event.sender.id);
      if (!data) {
        throw new Error(missingEditorRecordingDataMessage);
      }

      return data;
    });

    this.registerEditorVideoSourceIpcHandlers();

    ipcMain.handle("editor:get-audio-file-size", async (event, kind: unknown): Promise<number> => {
      return await this.runEditorOperation(
        event.sender.id,
        async () => await this.editorAudioFileSize(event.sender.id, audioSourceKindFromUnknown(kind))
      );
    });

    ipcMain.handle(
      "editor:read-audio-file",
      async (event, kind: unknown, start: unknown, end: unknown): Promise<Uint8Array> => {
        if (typeof start !== "number" || typeof end !== "number") {
          throw new TypeError("The audio file byte range must contain numbers.");
        }

        return await this.runEditorOperation(
          event.sender.id,
          async () => await this.readEditorAudioFile(
            event.sender.id,
            audioSourceKindFromUnknown(kind),
            start,
            end
          )
        );
      }
    );

    ipcMain.handle("editor:choose-save-path", async (event): Promise<SaveDialogResult> => {
      return await this.runEditorOperation(event.sender.id, async () => await this.chooseEditorVideoSavePath(event));
    });

    ipcMain.handle("editor:complete-video-file", async (event, recordingId: unknown, mimeType: unknown): Promise<PreparedVideoFile> => {
      return await this.runEditorOperation(
        event.sender.id,
        async () => await this.completeEditorVideoFile(
          event.sender.id,
          recordingIdFromUnknown(recordingId),
          videoMimeTypeFromUnknown(mimeType)
        )
      );
    });

    ipcMain.handle("editor:trim-video-end", async (event, endSeconds: unknown): Promise<PreparedVideoFile> => {
      if (typeof endSeconds !== "number") {
        throw new TypeError("The trim end must be a number.");
      }

      return await this.runEditorOperation(
        event.sender.id,
        async () => await this.trimEditorVideoEnd(event.sender.id, endSeconds)
      );
    });

    ipcMain.handle("editor:save-prepared-video", async (event, preparedFilePath: string, targetFilePath: string): Promise<SaveResult> => {
      return await this.runEditorOperation(event.sender.id, async (): Promise<SaveResult> => {
        await this.savePreparedEditorVideo(event.sender.id, preparedFilePath, targetFilePath);
        return { filePath: targetFilePath };
      });
    });

    ipcMain.handle("editor:copy-prepared-video", async (event, filePath: string): Promise<void> => {
      await this.runEditorOperation(event.sender.id, async (): Promise<void> => {
        this.assertEditorTempFile(event.sender.id, filePath);
        const editorData = this.editorDataByWebContents.get(event.sender.id);
        if (!editorData) {
          throw new Error(missingEditorRecordingDataMessage);
        }

        const clipboardFilePath = await this.createTemporaryVideoFilePath(
          videoFileExtension(editorData.mimeType),
          shortLivedRecordingFilePrefix
        );
        try {
          await link(filePath, clipboardFilePath);
          await writeFileDropListToClipboard(clipboardFilePath);
        } catch (error) {
          await rm(clipboardFilePath, { force: true });
          throw error;
        }

        const previousClipboardFilePath = this.editorClipboardFilesByWebContents.get(event.sender.id);
        if (previousClipboardFilePath) {
          this.editorTempFilesByWebContents.get(event.sender.id)?.delete(previousClipboardFilePath);
          await rm(previousClipboardFilePath, { force: true });
        }

        this.registerEditorTempFile(event.sender.id, clipboardFilePath);
        this.editorClipboardFilesByWebContents.set(event.sender.id, clipboardFilePath);
        this.completedEditorWebContents.add(event.sender.id);
        const editor = BrowserWindow.fromWebContents(event.sender);
        if (editor && !editor.isDestroyed()) {
          editor.focus();
        }
      });
    });

    ipcMain.handle("editor:close", (event): void => {
      this.closeSenderWindow(event);
    });
  }

  private registerSettingsIpcHandlers(): void {
    ipcMain.handle("settings:get", (event): AppSettings => {
      this.assertSenderWindow(event);
      return this.settingsSnapshot();
    });

    ipcMain.handle("settings:update", async (event, settings: unknown): Promise<AppSettings> => {
      return await this.updateSettings(event, settings);
    });

    ipcMain.handle("settings:ready-to-show", (event): void => {
      this.showSettingsWindow(this.getSenderSettingsWindow(event));
    });

    ipcMain.handle("settings:close", (event): void => {
      this.closeSenderWindow(event);
    });

    ipcMain.handle("settings:begin-keybind-recording", (event): void => {
      this.startSettingsKeybindRecording(event);
    });

    ipcMain.handle("settings:end-keybind-recording", (event): void => {
      this.stopSettingsKeybindRecording(event);
    });
  }

  private async showError(message: string, error?: unknown): Promise<void> {
    const options: Electron.MessageBoxOptions = {
      message,
      title: appName,
      type: "error"
    };

    if (error instanceof Error) {
      options.detail = error.message;
    }

    await dialog.showMessageBox(options);
  }

  private async showErrorSafely(message: string, error?: unknown): Promise<void> {
    try {
      await this.showError(message, error);
    } catch (showError) {
      this.debugLog(`could not show an error dialog: ${errorMessage(showError)}`);
    }
  }

  private reportBackgroundError(message: string, error: unknown): void {
    this.debugLog(`${message} ${errorMessage(error)}`);
    if (!this.isQuitting) {
      void this.showErrorSafely(message, error);
    }
  }

  private async showShortcutWarningWithErrorHandling(): Promise<void> {
    try {
      await this.showShortcutWarningIfNeeded();
    } catch (error) {
      await this.showErrorSafely("Could not show the capture shortcut warning.", error);
    }
  }

  private async openRecordingTempDirectoryWithErrorHandling(): Promise<void> {
    try {
      await this.openRecordingTempDirectory();
    } catch (error) {
      await this.showErrorSafely("Could not open recent recordings.", error);
    }
  }

  private async openSettingsWindowWithErrorHandling(): Promise<void> {
    try {
      await this.openSettingsWindow();
    } catch (error) {
      await this.showErrorSafely("Could not open settings.", error);
    }
  }

  private async showShortcutWarningIfNeeded(): Promise<void> {
    if (!this.isCaptureShortcutUnavailable || process.env.SOFTSHOT_SKIP_SHORTCUT_WARNING === "1") {
      return;
    }

    const shortcut = this.currentCaptureShortcut();
    const result = await dialog.showMessageBox({
      type: "warning",
      title: appName,
      message: `${appName} could not register ${shortcut}.`,
      detail: "Softshot is still running. Use Capture from the tray menu for now.\n\nTo let Softshot use PrintScreen, turn off Windows Settings > Accessibility > Keyboard > Use the Print screen key to open screen capture, close other screenshot apps, then restart Softshot.",
      buttons: ["Open settings", "OK"],
      defaultId: 1,
      cancelId: 1
    });

    if (result.response === 0) {
      await this.openKeyboardSettings();
    }
  }

  private timestamp(): string {
    const value = new Date();
    const year = String(value.getFullYear());
    const month = padDatePart(value.getMonth() + 1);
    const day = padDatePart(value.getDate());
    const hours = padDatePart(value.getHours());
    const minutes = padDatePart(value.getMinutes());
    const seconds = padDatePart(value.getSeconds());
    return `${year}-${month}-${day} ${hours}.${minutes}.${seconds}`;
  }

  private trayMenuTemplate(): Electron.MenuItemConstructorOptions[] {
    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: "Capture",
        accelerator: this.registeredShortcuts[0],
        click: (): void => {
          this.capture();
        }
      }
    ];

    if (this.isCaptureShortcutUnavailable) {
      template.push(
        {
          label: `${this.currentCaptureShortcut()} unavailable`,
          enabled: false
        },
        {
          label: "Open keyboard settings",
          click: (): void => {
            void this.openKeyboardSettings();
          }
        }
      );
    }

    template.push(
      { type: "separator" },
      {
        label: "Recent recordings",
        click: (): void => {
          void this.openRecordingTempDirectoryWithErrorHandling();
        }
      },
      {
        label: "Settings",
        click: (): void => {
          void this.openSettingsWindowWithErrorHandling();
        }
      },
      {
        label: "Quit",
        click: (): void => {
          app.quit();
        }
      }
    );

    return template;
  }

  private wireOverlayDiagnostics(overlay: BrowserWindow): void {
    if (process.env.SOFTSHOT_DEBUG !== "1") {
      return;
    }

    overlay.webContents.on("console-message", (details): void => {
      this.debugLog(
        `renderer console level=${details.level} ${details.sourceId}:${String(details.lineNumber)} ${details.message} observed=${String(details.defaultPrevented)}`
      );
    });

    overlay.webContents.on("did-fail-load", (event, errorCode, errorDescription, validatedUrl): void => {
      this.debugLog(
        `renderer did-fail-load code=${String(errorCode)} description=${errorDescription} url=${validatedUrl} observed=${String(event.defaultPrevented)}`
      );
    });

    overlay.webContents.on("render-process-gone", (event, details): void => {
      this.debugLog(`renderer gone reason=${details.reason} exitCode=${String(details.exitCode)} observed=${String(event.defaultPrevented)}`);
    });
  }

  private async cleanupEditorTempFiles(webContentsId: number, wasCompleted: boolean): Promise<void> {
    const temporaryFiles = this.editorTempFilesByWebContents.get(webContentsId);
    const sourceFilePath = this.editorSourceFilesByWebContents.get(webContentsId);
    const clipboardFilePath = this.editorClipboardFilesByWebContents.get(webContentsId);
    const savedFilePath = this.editorSavedFilesByWebContents.get(webContentsId);
    this.editorTempFilesByWebContents.delete(webContentsId);
    this.editorSourceFilesByWebContents.delete(webContentsId);
    this.editorClipboardFilesByWebContents.delete(webContentsId);
    this.editorSavedFilesByWebContents.delete(webContentsId);
    if (!temporaryFiles) {
      return;
    }

    const retainedCandidates: string[] = [];
    if (wasCompleted) {
      for (const filePath of [clipboardFilePath, savedFilePath]) {
        if (filePath && temporaryFiles.has(filePath)) {
          retainedCandidates.push(filePath);
        }
      }
      if (retainedCandidates.length === 0 && sourceFilePath && temporaryFiles.has(sourceFilePath)) {
        retainedCandidates.push(sourceFilePath);
      }
    } else if (sourceFilePath && temporaryFiles.has(sourceFilePath)) {
      retainedCandidates.push(sourceFilePath);
    }
    const retainedCandidateSet = new Set(retainedCandidates);

    await Promise.all([...temporaryFiles].map(async (filePath): Promise<void> => {
      if (retainedCandidateSet.has(filePath)) {
        return;
      }

      await rm(filePath, { force: true });
    }));

    const retainedFiles = wasCompleted
      ? await Promise.all([...retainedCandidateSet].map(async (filePath) => await this.moveToShortLivedFile(filePath)))
      : [...retainedCandidateSet];
    const retentionMs = wasCompleted ? shortLivedRecordingRetentionMs : standardRecordingRetentionMs;
    const retainedAt = new Date();
    for (const filePath of retainedFiles) {
      await utimes(filePath, retainedAt, retainedAt);
      this.scheduleTemporaryFileDeletion(filePath, retentionMs);
    }

    const notificationFilePath = retainedFiles[0];
    if (notificationFilePath) {
      this.notifyRecoverableRecording(notificationFilePath, wasCompleted ? "20 minutes" : "7 days");
    }
  }

  private async moveToShortLivedFile(filePath: string): Promise<string> {
    if (path.basename(filePath).startsWith(shortLivedRecordingFilePrefix)) {
      return filePath;
    }

    const fileExtension = videoFileExtensionFromUnknown(path.extname(filePath).slice(1));
    const targetFilePath = await this.createTemporaryVideoFilePath(fileExtension, shortLivedRecordingFilePrefix);
    await rename(filePath, targetFilePath);
    return targetFilePath;
  }

  private async completeEditorVideoFile(
    webContentsId: number,
    recordingId: string,
    mimeType: string
  ): Promise<PreparedVideoFile> {
    const editorData = this.editorDataByWebContents.get(webContentsId);
    if (!editorData) {
      throw new Error(missingEditorRecordingDataMessage);
    }

    const recordingFile = this.takeRecordingTempFile(recordingId, webContentsId);
    try {
      if (videoFileExtension(mimeType) !== videoFileExtension(editorData.mimeType)) {
        throw new Error("The prepared recording format does not match the source recording.");
      }

      if (!await this.hasUsableRecordingFile(recordingFile, mimeType)) {
        throw new Error("The prepared recording did not contain usable video data.");
      }

      this.registerEditorTempFile(webContentsId, recordingFile.filePath);
      return { filePath: recordingFile.filePath };
    } catch (error) {
      await rm(recordingFile.filePath, { force: true });
      throw error;
    }
  }

  private async savePreparedEditorVideo(webContentsId: number, preparedFilePath: string, targetFilePath: string): Promise<void> {
    this.assertEditorTempFile(webContentsId, preparedFilePath);
    this.assertEditorSavePath(webContentsId, targetFilePath);
    await mkdir(path.dirname(targetFilePath), { recursive: true });
    await this.replaceFileAtomically(targetFilePath, async (temporaryFilePath): Promise<void> => {
      await copyFile(preparedFilePath, temporaryFilePath);
    });
    this.completedEditorWebContents.add(webContentsId);
    this.editorSavedFilesByWebContents.set(webContentsId, preparedFilePath);
    this.editorSavePathsByWebContents.get(webContentsId)?.delete(targetFilePath);
    this.notifySaved("Recording saved", targetFilePath);
  }

  private async createTemporaryVideoFilePath(
    fileExtension: VideoFileExtension,
    filePrefix = `${appName} `
  ): Promise<string> {
    const targetDirectory = this.recordingTempDirectory();
    await mkdir(targetDirectory, { recursive: true });

    return path.join(targetDirectory, `${filePrefix}${this.timestamp()} ${randomUUID()}.${fileExtension}`);
  }

  private async trimEditorVideoEnd(webContentsId: number, endSeconds: number): Promise<PreparedVideoFile> {
    const editorData = this.editorDataByWebContents.get(webContentsId);
    const sourceFilePath = this.editorSourceFilesByWebContents.get(webContentsId);
    if (!editorData || !sourceFilePath) {
      throw new Error(missingEditorRecordingDataMessage);
    }

    if (!Number.isFinite(endSeconds) || endSeconds <= 0 || endSeconds >= editorData.durationSeconds) {
      throw new RangeError("The trim end must be within the source recording duration.");
    }

    const fileExtension = videoFileExtension(editorData.mimeType);
    const outputFilePath = await this.createTemporaryVideoFilePath(fileExtension);
    try {
      await remuxVideoEnd(sourceFilePath, outputFilePath, fileExtension, endSeconds);
      const outputStats = await stat(outputFilePath);
      const outputFile: RecordingTemporaryFile = {
        byteLength: outputStats.size,
        filePath: outputFilePath,
        ownerWebContentsId: webContentsId
      };
      if (!await this.hasUsableRecordingFile(outputFile, editorData.mimeType)) {
        throw new Error("The trimmed recording did not contain usable video data.");
      }

      this.registerEditorTempFile(webContentsId, outputFilePath);
      return { filePath: outputFilePath };
    } catch (error) {
      await rm(outputFilePath, { force: true });
      throw error;
    }
  }

  start(): void {
    if (!app.requestSingleInstanceLock()) {
      app.quit();
      return;
    }

    this.registerNavigationGuards();

    app.on("second-instance", (): void => {
      this.capture();
    });

    app.on("before-quit", (): void => {
      this.isQuitting = true;
    });

    app.on("will-quit", (): void => {
      this.clearCaptureShortcutRetry();
      globalShortcut.unregisterAll();
    });

    app.on("window-all-closed", (): void => {
      this.debugLog("Kept tray app running after overlay closed.");
    });

    void this.initializeWhenReady();
  }
}

function padDatePart(part: number): string {
  return part.toString().padStart(timestampPartWidth, "0");
}

function audioTrackLabel(kind: AudioSourceKind): string {
  return kind === "microphone" ? "Microphone audio" : "Desktop audio";
}

function recordingAudioTrackFromUnknown(value: unknown): RecordingAudioTrack {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Recording audio track must be an object.");
  }

  if (!("recordingId" in value)) {
    throw new TypeError("Recording audio track id must be a string.");
  }

  if (!("mimeType" in value) || typeof value.mimeType !== "string" || !isWebmAudioMimeType(value.mimeType)) {
    throw new TypeError("Recording audio track MIME type must be WebM audio.");
  }

  return {
    kind: recordingAudioTrackKindFromUnknown(value),
    mimeType: value.mimeType,
    recordingId: recordingIdFromUnknown(value.recordingId)
  };
}

function recordingAudioTrackKindFromUnknown(value: Record<string, unknown>): AudioSourceKind {
  return audioSourceKindFromUnknown(value.kind);
}

function audioSourceKindFromUnknown(value: unknown): AudioSourceKind {
  if (value === "microphone" || value === "system") {
    return value;
  }

  throw new TypeError("Audio track kind must be microphone or system.");
}

function recordingAudioTracksFromUnknown(value: unknown): RecordingAudioTrack[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Recording audio tracks must be an array.");
  }

  const audioTracks = value.map((audioTrack) => recordingAudioTrackFromUnknown(audioTrack));
  if (new Set(audioTracks.map((audioTrack) => audioTrack.kind)).size !== audioTracks.length) {
    throw new Error("Recording audio track kinds must be unique.");
  }

  return audioTracks;
}

function recordingDurationFromUnknown(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }

  throw new TypeError("Recording duration must be a positive finite number.");
}

function recordingIdFromUnknown(value: unknown): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  throw new TypeError("Recording file id must be a non-empty string.");
}

function recordingEncoderFromUnknown(value: unknown): RecordingEncoder {
  if (value === "hardware" || value === "compatibility") {
    return value;
  }

  throw new TypeError("Recording encoder must be hardware or compatibility.");
}

function capturePipelineFromUnknown(value: unknown): CapturePipeline {
  if (value === "composited" || value === "direct") {
    return value;
  }

  throw new TypeError("Recording capture pipeline must be composited or direct.");
}

function videoFileExtension(mimeType: string): VideoFileExtension {
  return mimeType.startsWith("video/mp4") ? "mp4" : "webm";
}

function videoMimeTypeFromUnknown(value: unknown): string {
  if (typeof value === "string" && (isMimeType(value, "video/mp4") || isMimeType(value, "video/webm"))) {
    return value;
  }

  throw new TypeError("Recording MIME type must be MP4 or WebM video.");
}

function videoFpsFromUnknown(value: unknown): VideoFps {
  if (value === videoFpsOptions.standard || value === videoFpsOptions.high) {
    return value;
  }

  throw new TypeError("Recording frame rate must be 30 or 60 FPS.");
}

function isMimeType(value: string, baseType: string): boolean {
  return value === baseType || value.startsWith(`${baseType};`);
}

function isWebmAudioMimeType(value: string): boolean {
  return isMimeType(value, "audio/webm");
}

function videoFileExtensionFromUnknown(value: unknown): VideoFileExtension {
  if (value === "mp4" || value === "webm") {
    return value;
  }

  throw new TypeError("Recording file extension must be mp4 or webm.");
}

function hasByteSignature(bytes: Uint8Array, signature: Uint8Array): boolean {
  if (bytes.byteLength < signature.byteLength) {
    return false;
  }

  const lastStartOffset = bytes.byteLength - signature.byteLength;
  for (let offset = 0; offset <= lastStartOffset; offset += 1) {
    if (hasByteSignatureAt(bytes, signature, offset)) {
      return true;
    }
  }

  return false;
}

function hasByteSignatureAt(bytes: Uint8Array, signature: Uint8Array, offset: number): boolean {
  return signature.every((expectedByte, byteIndex) => bytes[offset + byteIndex] === expectedByte);
}

function joinedBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(left.byteLength + right.byteLength);
  bytes.set(left);
  bytes.set(right, left.byteLength);
  return bytes;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve): void => {
    setTimeout(resolve, milliseconds);
  });
}

function isModifierOnlyShortcut(shortcut: string): boolean {
  return shortcut.split(keySeparator).every((key) => modifierKeys.has(key));
}

function keyFromInput(input: Electron.Input): string | null {
  if (modifierKeys.has(input.key)) {
    return input.key;
  }

  const namedKey = namedKeys.get(input.key);
  if (namedKey) {
    return namedKey;
  }

  const punctuationKey = punctuationKeys.get(input.key);
  if (punctuationKey) {
    return punctuationKey;
  }

  const numpadKey = numpadKeys.get(input.code);
  if (numpadKey) {
    return numpadKey;
  }

  if (input.code.startsWith("Key")) {
    return input.code.slice("Key".length);
  }

  if (input.code.startsWith("Digit")) {
    return input.code.slice("Digit".length);
  }

  if (input.key !== noKeyValue && !input.key.includes(keySeparator)) {
    return input.key;
  }

  return input.code && input.code !== noKeyValue ? input.code : null;
}

function pushModifierKey(keys: string[], key: string, isPressed: boolean): void {
  if (isPressed) {
    keys.push(key);
  }
}

function shortcutFromInput(input: Electron.Input): string | null {
  const keys: string[] = [];
  pushModifierKey(keys, "Control", input.control);
  pushModifierKey(keys, "Alt", input.alt);
  pushModifierKey(keys, "Shift", input.shift);
  pushModifierKey(keys, "Meta", input.meta);

  const key = keyFromInput(input);
  if (key && !modifierKeys.has(key)) {
    keys.push(key);
  }

  return keys.length > 0 ? keys.join(keySeparator) : null;
}

function shortcutKeyCount(shortcut: string): number {
  return shortcut.split(keySeparator).length;
}

function settingsKeybindBaseKeys(): string[] {
  return [
    ...globalShortcutSingleCharacterKeys,
    ...functionShortcutKeys(),
    ...globalShortcutBaseKeys,
    ...globalShortcutNumpadKeys,
    ...globalShortcutPunctuationKeys
  ];
}

function functionShortcutKeys(): string[] {
  const keys: string[] = [];
  for (let keyNumber = firstFunctionKey; keyNumber <= lastFunctionKey; keyNumber += 1) {
    keys.push(`F${String(keyNumber)}`);
  }

  return keys;
}

function settingsKeybindModifierCombinations(): string[][] {
  const combinations: string[][] = [[]];

  for (const modifier of modifierShortcutKeys) {
    const additions = combinations
      .filter((combination) => combination.length < maxShortcutModifierKeyCount)
      .map((combination) => [...combination, modifier]);
    combinations.push(...additions);
  }

  return combinations;
}

function settingsKeybindRecorderShortcuts(): string[] {
  const shortcuts: string[] = [];
  const modifierCombinations = settingsKeybindModifierCombinations();

  for (const key of settingsKeybindBaseKeys()) {
    for (const modifiers of modifierCombinations) {
      shortcuts.push([...modifiers, key].join(keySeparator));
    }
  }

  return shortcuts;
}

function trailingBytes(bytes: Uint8Array, maxByteLength: number): Uint8Array {
  const start = Math.max(0, bytes.byteLength - maxByteLength);
  return bytes.slice(start);
}

async function writeFileDropListToClipboard(filePath: string): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("Copying a recording as a file is only supported on Windows.");
  }

  await runPowershellClipboardScript(filePath);
}

async function runPowershellClipboardScript(filePath: string): Promise<void> {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$file = [Environment]::GetEnvironmentVariable("${clipboardFileEnvironmentName}")
if ([string]::IsNullOrWhiteSpace($file)) {
  throw "Missing ${clipboardFileEnvironmentName}."
}
$files = New-Object System.Collections.Specialized.StringCollection
[void] $files.Add($file)
[System.Windows.Forms.Clipboard]::SetFileDropList($files)
`;

  await new Promise<void>((resolve, reject) => {
    execFile(
      powershellExecutable,
      powershellArguments(script),
      {
        env: {
          ...process.env,
          [clipboardFileEnvironmentName]: filePath
        },
        timeout: powershellClipboardTimeoutMs,
        windowsHide: true
      },
      (error, standardOutput, standardError): void => {
        if (error) {
          reject(new Error(powershellClipboardErrorMessage(error, standardOutput, standardError)));
          return;
        }

        resolve();
      }
    );
  });
}

function powershellArguments(script: string): string[] {
  return ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script];
}

function powershellClipboardErrorMessage(error: Error, standardOutput: string, standardError: string): string {
  const output = [standardError.trim(), standardOutput.trim()].filter(Boolean).join("\n");
  if (!output) {
    return `Could not put the recording file on the clipboard.\n${error.message}`;
  }

  return `Could not put the recording file on the clipboard.\n${output}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const softshotApp = new SoftshotApp();
softshotApp.start();
