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
  ipcMain,
  Menu,
  nativeImage,
  screen,
  session,
  shell,
  Tray,
  webContents as electronWebContents
} from "electron";

import {
  clipSettingsWithUpdate,
  editorShortcutsWithUpdate,
  isTrueSetting,
  loadAppSettings,
  saveAppSettings,
  validateCaptureShortcut,
  validateExportDirectory,
  validateExportPresetId,
  validateMicrophoneDeviceId,
  validatePlaybackVolume
} from "./app-settings";
import { installUpdate, startUpdateChecks } from "./app-updater";
import { type AppWindowState, isTitleBarOnScreen, loadAppWindowState, saveAppWindowState } from "./app-window-state";
import { combinedError, errorMessage, rejectedReasons, throwCollectedErrors } from "./async-errors";
import { desktopBounds } from "./capture-layout";
import { ClipsService } from "./clips-service";
import { EditingSession, type UnsavedEditingWork } from "./editing-session";
import { remuxVideoEnd, remuxVideoToZeroStart } from "./editor-remux";
import { KeyboardHook } from "./keyboard-hook";
import { characterKeyLabels } from "./keyboard-layout";
import { writeFileDropListToClipboard } from "./powershell";
import type {
  AppInfo,
  AppPage,
  AppSettings,
  AudioSourceKind,
  CapturedDisplay,
  CaptureDisplay,
  CapturePipeline,
  CompletedOutputFile,
  EditorAudioTrack,
  EditorBootstrap,
  OutputFileExtension,
  OverlayBootstrap,
  PreparedVideoFile,
  RecordingAudioSourceKind,
  RecordingAudioTrack,
  RecordingEncoder,
  RecordingFile,
  SaveDialogResult,
  SaveResult,
  ShortcutKeyLabels,
  ShortcutRecordingEvent,
  ShortcutTarget,
  VideoFileExtension,
  VideoFps
} from "./shared";
import {
  fileTimestamp,
  isAudioSourceKind,
  isOutputFileExtension,
  isRecordingAudioSourceKind,
  videoFileExtension,
  videoFpsOptions
} from "./shared";
import { shortcutAccelerator } from "./shortcut-keys";
import { ShortcutRecorder, type ShortcutRecorderEvent } from "./shortcut-recorder";
import { currentWindowsAccount, syncElevatedStartupTask } from "./startup-task";
import { TaskQueue } from "./task-queue";
import {
  recordingRetentionMs,
  shortLivedRecordingFilePrefix,
  shortLivedRecordingRetentionMs,
  standardRecordingRetentionMs
} from "./temporary-retention";
import { ToastWindow } from "./toast-window";
import { probeVideoFile, type VideoFileProbe } from "./video-file-probe";
import { hasWebmCluster, webmClusterSignatureLength } from "./webm";

const appName = "Softshot";
const appId = "com.akinsoft.softshot";
const developmentAppId = `${appId}.dev`;
const overlayReadyTimeoutMs = 15_000;
const captureOnReadyDelayMs = 300;
const pngSignature = Buffer.from("89504e470d0a1a0a", "hex");
const clipboardFolderName = "clipboard";
const transparentWindowBackground = "#00000000";
const appWindowWidthPx = 980;
const appWindowHeightPx = 680;
const appWindowMinWidthPx = 820;
const appWindowMinHeightPx = 560;
const appWindowTitleBarHeightPx = 44;
const appWindowBackground = "#131417";
const appWindowSymbolColor = "#f3f5f8";
const appIconRelativePath = path.join("src", "assets", "app-logo.ico");
const appLogoRelativePath = path.join("src", "assets", "app-logo.png");
const preloadScriptRelativePath = path.join("dist", "main", "preload.js");
const trayIconLogicalSizePx = 16;
const trayIconScaleFactor2x = 2;
const trayIconScaleFactor3x = 3;
const trayIconScaleFactors = [1, trayIconScaleFactor2x, trayIconScaleFactor3x] as const;
const minimumRecordingByteLength = 1;
const webmScanChunkSizeBytes = 65_536;
const webmSignatureCarryByteLength = webmClusterSignatureLength - 1;
const mp4FileTypeSignature = new TextEncoder().encode("ftyp");
const mp4MediaDataSignature = new TextEncoder().encode("mdat");
const gifFileSignature = new TextEncoder().encode("GIF89a");
const wavRiffSignature = new TextEncoder().encode("RIFF");
const wavWaveSignature = new TextEncoder().encode("WAVE");
const wavWaveSignatureOffset = 8;
const fileHeaderByteLength = 12;
const exportFileLabelPattern = /^[\w ]{1,40}$/u;
const clipAudioTrackMimeType = "audio/mp4";
const outputFileFilterNames: Record<OutputFileExtension, string> = {
  gif: "GIF image",
  m4a: "M4A audio",
  mp4: "MP4 video",
  wav: "WAV audio",
  webm: "WebM video"
};
const missingEditingSessionMessage = "This video is no longer open in the editor.";
const busyEditorMessage = "Wait for the editor to finish saving or exporting, then try again.";
const discardEditingWorkButtonIndex = 0;
const keepEditingButtonIndex = 1;
const mediaPermissionName = "media";
const defaultSystemAudioLoopbackDevice = "loopback";
const fallbackSystemAudioLoopbackDevice = "loopbackWithoutChrome";
type SystemAudioLoopbackDevice = typeof defaultSystemAudioLoopbackDevice | typeof fallbackSystemAudioLoopbackDevice;
const shortcutRecordingEventChannel = "app:shortcut-recording-event";
const settingsChangedEventChannel = "settings:changed";
const appNavigateEventChannel = "app:navigate";
const appUpdateReadyEventChannel = "app:update-ready";
const clipsStatusChangedEventChannel = "clips:status-changed";
const clipsLibraryChangedEventChannel = "clips:library-changed";
const editorOpenedEventChannel = "editor:opened";
const appSettingsUpdateKeys = new Set([
  "captureShortcut",
  "clips",
  "editorShortcuts",
  "exportDirectory",
  "exportPresetId",
  "launchAtStartup",
  "microphoneDeviceId",
  "playbackMuted",
  "playbackVolume",
  "recentClipsExpanded",
  "sidebarCollapsed",
  "systemAudioEnabled"
]);
const openableVideoFileExtensions: ReadonlySet<string> = new Set(["mkv", "mov", "mp4", "webm"]);

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

class SoftshotApp {
  private activeOverlay: BrowserWindow | null = null;

  private readonly editingSessions = new Map<string, EditingSession>();

  private currentEditingSession: EditingSession | null = null;

  private readonly editorOpenings = new TaskQueue();

  private settings: AppSettings | null = null;

  private readonly settingsUpdates = new TaskQueue();

  private shortcutRecordingWebContentsId: number | null = null;

  private shortcutRecordingTarget: ShortcutTarget = "capture";

  private isShortcutRecordingSaving = false;

  private appWindow: BrowserWindow | null = null;

  private appWindowState: AppWindowState | null = null;

  private systemAudioLoopbackDevice: SystemAudioLoopbackDevice = defaultSystemAudioLoopbackDevice;

  private isUpdateReady = false;

  private readonly keyboard = new KeyboardHook((error): void => {
    this.reportBackgroundError("Keyboard shortcuts stopped working.", error);
  });

  private readonly shortcutRecorder = new ShortcutRecorder(this.keyboard, (event): void => {
    this.handleShortcutRecorderEvent(event);
  });

  private readonly clips = this.createClipsService();

  private readonly toasts = new ToastWindow(
    () => this.preloadScriptPath(),
    (error): void => {
      this.reportBackgroundError("Could not show a Softshot notification.", error);
    }
  );

  private readonly displayMediaDisplayIdsByWebContents = new Map<number, number>();

  private readonly captureDisplaysByWebContents = new Map<number, CaptureDisplay[]>();

  private isQuitting = false;

  private liveCaptureOverlayWebContentsId: number | null = null;

  private readonly overlayDataByWebContents = new Map<number, OverlayBootstrap>();

  private readonly overlayBootstrapConsumedWebContents = new Set<number>();

  private overlayOpenPromise: Promise<boolean> | null = null;

  private readonly pendingOverlayBootstrapsByWebContents = new Map<number, PendingOverlayBootstrap>();

  private isOverlayPreparationUnavailable = false;

  private preparedOverlay: BrowserWindow | null = null;

  private readonly recordingTempFilesById = new Map<string, RecordingTemporaryFile>();

  private readonly temporaryFileDeletionTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  private tray: Tray | null = null;

  private initialization: Promise<void> = Promise.resolve();

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

  private async createRecordingFile(ownerWebContentsId: number, fileExtension: OutputFileExtension): Promise<RecordingFile> {
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

  private async hasUsableOutputFile(outputFile: RecordingTemporaryFile, fileExtension: OutputFileExtension): Promise<boolean> {
    if (outputFile.byteLength < minimumRecordingByteLength) {
      return false;
    }

    if (fileExtension === "webm") {
      return await this.fileHasWebmCluster(outputFile.filePath);
    }

    if (fileExtension === "mp4" || fileExtension === "m4a") {
      return await this.fileHasMp4Media(outputFile.filePath);
    }

    const header = await readFileHeader(outputFile.filePath);
    return fileExtension === "gif"
      ? hasByteSignatureAt(header, gifFileSignature, 0)
      : hasByteSignatureAt(header, wavRiffSignature, 0) && hasByteSignatureAt(header, wavWaveSignature, wavWaveSignatureOffset);
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
    return ownerWindow === this.activeOverlay
      || this.clips.isRecorderWindow(ownerWindow)
      || this.isEditingWindow(ownerWindow);
  }

  private isEditingWindow(window: BrowserWindow | null): boolean {
    return window !== null && window === this.appWindow && this.editingSessions.size > 0;
  }

  private async cleanupAbandonedRecordingFiles(ownerWebContentsId: number, shouldPreserveData: boolean): Promise<void> {
    await this.cleanupRecordingFiles(this.takeRecordingTempFilesForOwner(ownerWebContentsId), shouldPreserveData);
  }

  private async cleanupRecordingFiles(files: RecordingTemporaryFile[], shouldPreserveData: boolean): Promise<void> {
    const cleanupResults = await Promise.allSettled(files.map(async (file): Promise<void> => {
      if (shouldPreserveData && file.byteLength > 0) {
        if (!this.isQuitting) {
          this.notifyRecoverableRecording(file.filePath);
        }

        return;
      }

      await rm(file.filePath, { force: true });
    }));
    throwCollectedErrors(rejectedReasons(cleanupResults), "Could not clean up all abandoned recording files.");
  }

  private createOverlayWindow(): BrowserWindow {
    const overlay = new BrowserWindow({
      frame: false,
      thickFrame: false,
      roundedCorners: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreen: false,
      fullscreenable: false,
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
    this.positionOverlayWindow(overlay, this.availableCaptureDisplays());
    overlay.setAlwaysOnTop(true, "screen-saver");
    overlay.setContentProtection(true);
    return overlay;
  }

  private availableCaptureDisplays(): CaptureDisplay[] {
    return screen.getAllDisplays().map((display) => ({
      id: display.id,
      bounds: screen.dipToScreenRect(null, display.bounds)
    }));
  }

  private positionOverlayWindow(overlay: BrowserWindow, displays: CaptureDisplay[]): void {
    overlay.setBounds(screen.screenToDipRect(null, desktopBounds(displays)));
  }

  private createAppWindow(): BrowserWindow {
    return this.createTaskbarWindow({
      ...this.restoredAppWindowBounds(),
      minWidth: appWindowMinWidthPx,
      minHeight: appWindowMinHeightPx,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: appWindowBackground,
      icon: this.appIconPath(),
      title: appName,
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: appWindowBackground,
        height: appWindowTitleBarHeightPx,
        symbolColor: appWindowSymbolColor
      },
      webPreferences: {
        preload: this.preloadScriptPath(),
        contextIsolation: true,
        nodeIntegration: false
      }
    });
  }

  private restoredAppWindowBounds(): Partial<Electron.Rectangle> {
    const savedBounds = this.appWindowState?.bounds;
    const workAreas = screen.getAllDisplays().map((display) => display.workArea);
    if (!savedBounds || !isTitleBarOnScreen(savedBounds, appWindowTitleBarHeightPx, workAreas)) {
      return { width: appWindowWidthPx, height: appWindowHeightPx };
    }

    return savedBounds;
  }

  private rememberAppWindowState(appWindow: BrowserWindow): void {
    const state: AppWindowState = { bounds: appWindow.getNormalBounds(), isMaximized: appWindow.isMaximized() };
    this.appWindowState = state;
    try {
      saveAppWindowState(app.getPath("userData"), state);
    } catch (error) {
      this.reportBackgroundError("Could not save the Softshot window size.", error);
    }
  }

  private createTaskbarWindow(options: Electron.BrowserWindowConstructorOptions): BrowserWindow {
    const window = new BrowserWindow(options);
    window.setAppDetails(this.taskbarAppDetails());
    return window;
  }

  private taskbarAppDetails(): Electron.AppDetailsOptions {
    if (!app.isPackaged) {
      return {
        appIconPath: this.appIconPath(),
        appId: developmentAppId,
        relaunchCommand: `"${process.execPath}" "${app.getAppPath()}"`,
        relaunchDisplayName: appName
      };
    }

    return {
      appIconIndex: 0,
      appIconPath: process.execPath,
      appId,
      relaunchCommand: `"${process.execPath}"`,
      relaunchDisplayName: appName
    };
  }

  private createTray(): Tray {
    const currentTray = new Tray(this.createTrayImage());
    currentTray.setToolTip(appName);
    currentTray.setContextMenu(Menu.buildFromTemplate(this.trayMenuTemplate()));
    currentTray.on("click", (): void => {
      void this.openAppWindowWithErrorHandling(null);
    });
    return currentTray;
  }

  private createClipsService(): ClipsService {
    return new ClipsService({
      isAppWindowSender: (sender) => this.isAppWindowWebContents(sender),
      libraryChanged: (): void => {
        this.sendToAppWindow(clipsLibraryChangedEventChannel);
      },
      openClips: (): void => {
        void this.openAppWindowWithErrorHandling("clips");
      },
      openVideoFile: async (filePath): Promise<boolean> => await this.openVideoFileEditor(filePath),
      preloadScriptPath: () => this.preloadScriptPath(),
      recorderClosed: (webContentsId): void => {
        void this.cleanupAbandonedRecordingFiles(webContentsId, false).catch((error: unknown): void => {
          this.reportBackgroundError("Could not clean up unfinished clip audio.", error);
        });
      },
      settings: () => this.currentSettings(),
      showToast: (toast): void => {
        this.toasts.show(toast);
      },
      statusChanged: (): void => {
        this.sendToAppWindow(clipsStatusChangedEventChannel, this.clips.currentStatus());
        this.refreshTrayMenu();
      },
      takeClipRecording: async (recordingId, ownerWebContentsId) =>
        await this.takeClipRecording(recordingId, ownerWebContentsId)
    }, this.keyboard);
  }

  private async takeClipRecording(recordingId: string, ownerWebContentsId: number): Promise<string> {
    const recordingFile = this.takeRecordingTempFile(recordingId, ownerWebContentsId);
    if (!await this.hasUsableRecordingFile(recordingFile, "video/mp4")) {
      await rm(recordingFile.filePath, { force: true });
      throw new Error("The clip audio did not contain usable data.");
    }

    return recordingFile.filePath;
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

  private loginItemSettingsOptions(): Electron.LoginItemSettingsOptions {
    return {
      path: app.getPath("exe"),
      args: app.isPackaged ? [] : [app.getAppPath()]
    };
  }

  private async applyLaunchAtStartup(isEnabled: boolean): Promise<void> {
    if (!app.isPackaged) {
      return;
    }

    const account = await currentWindowsAccount();
    const isStartupTaskEnabled = await syncElevatedStartupTask(account, app.getPath("exe"), isEnabled);
    const isLoginItemEnabled = isEnabled && !isStartupTaskEnabled;
    const options = this.loginItemSettingsOptions();
    app.setLoginItemSettings({
      ...options,
      openAtLogin: isLoginItemEnabled
    });

    const loginItemSettings = app.getLoginItemSettings(options);
    if (loginItemSettings.openAtLogin !== isLoginItemEnabled) {
      throw new Error("Could not update launch at startup.");
    }
  }

  private debugLog(message: string): void {
    if (process.env.SOFTSHOT_DEBUG !== "1") {
      return;
    }

    process.stdout.write(`[softshot] ${message}\n`);
  }

  private async getDesktopSourceForDisplay(displayId: number): Promise<Electron.DesktopCapturerSource> {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      fetchWindowIcons: false,
      thumbnailSize: { height: 0, width: 0 }
    });

    const source = sources.find((candidate) => candidate.display_id === String(displayId));
    if (source) {
      return source;
    }

    const availableIds = sources.map((candidate) => candidate.display_id || "(empty)").join(", ");
    throw new Error(`Could not match display ${String(displayId)} to a screen source. Available display ids: ${availableIds}.`);
  }

  private async captureFrozenDisplays(displays: CaptureDisplay[]): Promise<CapturedDisplay[]> {
    const groups = Object.groupBy(displays, (display) => `${String(display.bounds.width)}x${String(display.bounds.height)}`);
    const captures = await Promise.all(Object.values(groups).map(async (group): Promise<CapturedDisplay[]> => {
      if (!group?.length) {
        throw new Error("No monitors are available to capture.");
      }

      const { width, height } = group[0].bounds;
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        fetchWindowIcons: false,
        thumbnailSize: { width, height }
      });
      const sourcesByDisplayId = new Map(sources.map((source) => [source.display_id, source]));
      return group.map((display) => {
        const source = sourcesByDisplayId.get(String(display.id));
        if (!source || source.thumbnail.isEmpty()) {
          throw new Error(`Could not capture monitor ${String(display.id)}.`);
        }

        const size = source.thumbnail.getSize();
        if (size.width !== width || size.height !== height) {
          throw new Error("The monitor resolution changed. Please capture again.");
        }

        return { ...display, imageBytes: source.thumbnail.toBitmap() };
      });
    }));
    return captures.flat();
  }

  private useSystemAudioFallback(event: Electron.IpcMainInvokeEvent): boolean {
    if (!this.isManagedMediaWebContents(event.sender)) {
      throw new Error("Only capture windows can change how desktop audio is captured.");
    }

    if (this.systemAudioLoopbackDevice === fallbackSystemAudioLoopbackDevice) {
      return false;
    }

    this.systemAudioLoopbackDevice = fallbackSystemAudioLoopbackDevice;
    this.debugLog("desktop audio switched to process loopback");
    return true;
  }

  private selectCaptureDisplay(event: Electron.IpcMainInvokeEvent, displayId: unknown): void {
    this.getSenderOverlay(event);
    if (typeof displayId !== "number"
      || !this.captureDisplaysByWebContents.get(event.sender.id)?.some((display) => display.id === displayId)) {
      throw new TypeError("The selected monitor is not part of this capture.");
    }

    this.displayMediaDisplayIdsByWebContents.set(event.sender.id, displayId);
  }

  private displayMediaRequestWebContentsId(request: Electron.DisplayMediaRequestHandlerHandlerRequest): number {
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

    return requestWebContents.id;
  }

  private async displayMediaSource(webContentsId: number): Promise<Electron.DesktopCapturerSource> {
    const clipSource = this.clips.displayMediaSource(webContentsId);
    if (clipSource) {
      return clipSource;
    }

    const displayId = this.displayMediaDisplayIdsByWebContents.get(webContentsId);
    if (typeof displayId !== "number") {
      throw new TypeError("Softshot received an unexpected display capture request.");
    }

    return await this.getDesktopSourceForDisplay(displayId);
  }

  private async handleDisplayMediaRequest(
    request: Electron.DisplayMediaRequestHandlerHandlerRequest,
    callback: (streams: Electron.Streams) => void
  ): Promise<void> {
    try {
      const source = await this.displayMediaSource(this.displayMediaRequestWebContentsId(request));
      const streams: Electron.Streams = { video: source };
      if (request.audioRequested) {
        streams.audio = this.systemAudioLoopbackDevice as Electron.Streams["audio"];
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

    if (this.activeOverlay === senderWindow
      || this.isEditingWindow(senderWindow)
      || this.clips.isRecorderWindow(senderWindow)) {
      return senderWindow;
    }

    throw new Error("Only an active capture, clip, or editor can write recording files.");
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
    const loadPromise = this.loadOverlayWindowFile(overlay);
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

    const overlay = this.createOverlayWindow();
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
      this.settings = await loadAppSettings(
        app.getPath("userData"),
        app.getLoginItemSettings(this.loginItemSettingsOptions()).openAtLogin
      );
      this.appWindowState = await loadAppWindowState(app.getPath("userData"));
      const { launchAtStartup } = this.settings;
      void this.settingsUpdates.run(async () => {
        await this.applyLaunchAtStartup(launchAtStartup);
      }).catch((error: unknown): void => {
        this.reportBackgroundError("Could not update launch at startup.", error);
      });
      this.registerPermissionRequestHandler();
      this.registerDisplayMediaRequestHandler();
      this.registerIpcHandlers();
      this.toasts.bind();
      this.keyboard.start();
      this.bindCaptureShortcut();
      this.tray = this.createTray();
      this.clips.start();
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
    this.toasts.show({
      detail: null,
      onClick: (): void => {
        shell.showItemInFolder(filePath);
      },
      title,
      tone: "info"
    });
  }

  private notifyRecoverableRecording(filePath: string, retentionDescription = "7 days"): void {
    this.toasts.show({
      detail: "Click to show it in its folder.",
      onClick: (): void => {
        shell.showItemInFolder(filePath);
      },
      title: `Recording kept for ${retentionDescription}`,
      tone: "info"
    });
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

  private isCaptureWorkActive(): boolean {
    return this.activeOverlay !== null || this.editingSessions.size > 0 || this.clips.isBusy();
  }

  private canInstallUpdatesNow(): boolean {
    return !this.isCaptureWorkActive() && (!this.appWindow || this.appWindow.isDestroyed());
  }

  private installReadyUpdate(event: Electron.IpcMainInvokeEvent): void {
    this.getSenderAppWindow(event);
    if (!this.isUpdateReady) {
      throw new Error("No Softshot update is ready to install.");
    }

    if (this.isCaptureWorkActive()) {
      throw new Error("Finish the current capture, editor or clip save first, then update.");
    }

    installUpdate();
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
      },
      updateReady: (): void => {
        this.isUpdateReady = true;
        this.sendToAppWindow(appUpdateReadyEventChannel);
        this.toasts.show({
          detail: "It finishes installing when Softshot closes.",
          onClick: null,
          title: "Softshot update ready",
          tone: "info"
        });
      }
    });
  }

  private preparedOverlayForCapture(displays: CaptureDisplay[]): BrowserWindow {
    if (!this.preparedOverlay || this.preparedOverlay.isDestroyed()) {
      this.isOverlayPreparationUnavailable = false;
      this.prepareNextOverlay();
    }

    const overlay = this.preparedOverlay;
    if (!overlay || overlay.isDestroyed()) {
      throw new Error("Could not prepare the capture overlay.");
    }

    this.positionOverlayWindow(overlay, displays);
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
      this.captureDisplaysByWebContents.delete(overlayWebContentsId);
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
      defaultPath: path.join(targetDirectory, `${appName} ${fileTimestamp(new Date())}.png`),
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

  private async editorDefaultSaveDirectory(editorData: EditorBootstrap): Promise<string> {
    if (editorData.source.kind === "file") {
      return path.dirname(editorData.source.filePath);
    }

    const targetDirectory = path.join(app.getPath("videos"), appName);
    await mkdir(targetDirectory, { recursive: true });
    return targetDirectory;
  }

  private editorOutputBaseName(editorData: EditorBootstrap): string {
    const { source } = editorData;
    return source.kind === "file"
      ? path.basename(source.filePath, path.extname(source.filePath))
      : `${appName} ${fileTimestamp(new Date())}`;
  }

  private async editorVideoDefaultSavePath(editorData: EditorBootstrap, fileExtension: VideoFileExtension): Promise<string> {
    const fileNameSuffix = editorData.source.kind === "file" ? " edited" : "";
    return path.join(
      await this.editorDefaultSaveDirectory(editorData),
      `${this.editorOutputBaseName(editorData)}${fileNameSuffix}.${fileExtension}`
    );
  }

  private editingSessionForSender(event: Electron.IpcMainInvokeEvent, sessionId: unknown): EditingSession {
    this.getSenderAppWindow(event);
    if (typeof sessionId !== "string") {
      throw new TypeError(missingEditingSessionMessage);
    }

    const editingSession = this.editingSessions.get(sessionId);
    if (!editingSession) {
      throw new Error(missingEditingSessionMessage);
    }

    return editingSession;
  }

  private async showEditorSaveDialog(
    editingSession: EditingSession,
    defaultPath: string,
    fileExtension: OutputFileExtension,
    title: string
  ): Promise<string | null> {
    const options: Electron.SaveDialogOptions = {
      defaultPath,
      filters: [
        {
          name: outputFileFilterNames[fileExtension],
          extensions: [fileExtension]
        }
      ],
      title
    };
    const { appWindow } = this;
    const result = appWindow && !appWindow.isDestroyed()
      ? await dialog.showSaveDialog(appWindow, options)
      : await dialog.showSaveDialog(options);

    if (result.canceled || !result.filePath) {
      return null;
    }

    editingSession.registerSavePath(result.filePath);
    return result.filePath;
  }

  private async chooseEditorVideoSavePath(editingSession: EditingSession): Promise<SaveDialogResult> {
    const editorData = editingSession.data;
    const fileExtension = videoFileExtension(editorData.mimeType);
    const filePath = await this.showEditorSaveDialog(
      editingSession,
      await this.editorVideoDefaultSavePath(editorData, fileExtension),
      fileExtension,
      editorData.source.kind === "file" ? "Save video" : "Save recording"
    );
    return { filePath };
  }

  private async chooseEditorExportPath(
    editingSession: EditingSession,
    fileExtension: OutputFileExtension,
    fileLabel: string
  ): Promise<SaveDialogResult> {
    const filePath = await this.showEditorSaveDialog(
      editingSession,
      await this.editorExportDefaultPath(editingSession.data, fileExtension, fileLabel),
      fileExtension,
      "Export"
    );
    if (filePath) {
      await this.applySettingsUpdate({ exportDirectory: path.dirname(filePath) });
    }

    return { filePath };
  }

  private async editorExportDefaultPath(
    editorData: EditorBootstrap,
    fileExtension: OutputFileExtension,
    fileLabel: string
  ): Promise<string> {
    const targetDirectory = this.currentSettings().exportDirectory ?? await this.editorDefaultSaveDirectory(editorData);
    return path.join(targetDirectory, `${this.editorOutputBaseName(editorData)} ${fileLabel}.${fileExtension}`);
  }

  private editorSavedNotificationTitle(editingSession: EditingSession, fileExtension: OutputFileExtension): string {
    if (fileExtension === "gif") {
      return "GIF saved";
    }

    if (fileExtension === "m4a" || fileExtension === "wav") {
      return "Audio saved";
    }

    return editingSession.data.source.kind === "file" ? "Video saved" : "Recording saved";
  }

  private async openOverlay(): Promise<void> {
    if (this.activeOverlay && !this.activeOverlay.isDestroyed()) {
      this.debugLog("focusing existing overlay");
      this.activeOverlay.focus();
      return;
    }

    this.debugLog("creating overlay");
    const startedAt = performance.now();
    const displays = this.availableCaptureDisplays();
    const toolbarDisplayId = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id;
    const overlay = this.preparedOverlayForCapture(displays);
    this.activeOverlay = overlay;
    const overlayWebContentsId = overlay.webContents.id;
    this.captureDisplaysByWebContents.set(overlayWebContentsId, displays);
    const readinessTimeout = setTimeout((): void => {
      this.handleOverlayReadinessTimeout(overlay);
    }, overlayReadyTimeoutMs);

    overlay.once("show", (): void => {
      clearTimeout(readinessTimeout);
    });
    overlay.once("closed", (): void => {
      clearTimeout(readinessTimeout);
    });

    try {
      const capturedDisplays = await this.captureFrozenDisplays(displays);
      if (overlay.isDestroyed() || this.activeOverlay !== overlay) {
        return;
      }

      const elapsedMs = Math.round(performance.now() - startedAt);
      this.debugLog(`desktop pixels ready in ${String(elapsedMs)} ms`);
      this.provideOverlayBootstrap(overlayWebContentsId, { displays: capturedDisplays, toolbarDisplayId });
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

  private showAppWindow(appWindow: BrowserWindow): void {
    if (appWindow.isDestroyed()) {
      return;
    }

    if (appWindow.isMinimized()) {
      appWindow.restore();
    }

    if (!appWindow.isVisible()) {
      appWindow.show();
    }

    appWindow.focus();
  }

  private getSenderAppWindow(event: Electron.IpcMainInvokeEvent): BrowserWindow {
    const appWindow = BrowserWindow.fromWebContents(event.sender);
    if (!appWindow || appWindow.isDestroyed()) {
      throw new Error("Missing Softshot window.");
    }

    if (this.appWindow !== appWindow) {
      throw new Error("Only the Softshot window can change settings.");
    }

    return appWindow;
  }

  private isAppWindowWebContents(sender: Electron.WebContents): boolean {
    const { appWindow } = this;
    return appWindow !== null && !appWindow.isDestroyed() && appWindow.webContents === sender;
  }

  private sendToAppWindow(channel: string, ...values: unknown[]): void {
    const { appWindow } = this;
    if (!appWindow || appWindow.isDestroyed() || appWindow.webContents.isDestroyed()) {
      return;
    }

    appWindow.webContents.send(channel, ...values);
  }

  private showOverlayWindow(overlay: BrowserWindow): void {
    if (overlay.isDestroyed() || this.activeOverlay !== overlay) {
      return;
    }

    if (!overlay.isVisible()) {
      overlay.show();
    }

    overlay.focus();
  }

  private assertSenderWindow(event: Electron.IpcMainInvokeEvent): void {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (!senderWindow || senderWindow.isDestroyed()) {
      throw new Error("Missing Softshot window.");
    }
  }

  private async openAppWindow(page: AppPage | null): Promise<BrowserWindow> {
    if (this.appWindow && !this.appWindow.isDestroyed()) {
      if (page) {
        this.sendToAppWindow(appNavigateEventChannel, page);
      }

      this.showAppWindow(this.appWindow);
      return this.appWindow;
    }

    const appWindow = this.createAppWindow();
    const appWebContentsId = appWindow.webContents.id;
    let isCloseConfirmed = false;
    this.appWindow = appWindow;
    appWindow.webContents.on("before-input-event", (event): void => {
      this.handleShortcutRecordingInput(appWindow, event);
    });

    appWindow.on("blur", (): void => {
      this.cancelShortcutRecording(appWindow);
    });

    appWindow.once("ready-to-show", (): void => {
      if (this.appWindowState?.isMaximized) {
        appWindow.maximize();
      }

      this.showAppWindow(appWindow);
    });

    appWindow.on("close", (closeEvent): void => {
      this.rememberAppWindowState(appWindow);
      if (isCloseConfirmed || this.isQuitting || appWindow.webContents.isCrashed() || !this.hasEditingWorkToProtect()) {
        return;
      }

      closeEvent.preventDefault();
      void this.confirmCurrentEditingDiscard(appWindow).then((isConfirmed): void => {
        if (!isConfirmed || appWindow.isDestroyed()) {
          return;
        }

        isCloseConfirmed = true;
        appWindow.close();
      }, async (error: unknown): Promise<void> => {
        await this.showErrorSafely("Could not close Softshot.", error);
      });
    });

    appWindow.on("closed", (): void => {
      if (this.shortcutRecordingWebContentsId === appWebContentsId) {
        this.stopShortcutRecording();
      }

      if (this.appWindow === appWindow) {
        this.appWindow = null;
      }

      for (const editingSession of this.editingSessions.values()) {
        this.releaseEditingSession(editingSession);
      }

      void this.cleanupAbandonedRecordingFiles(appWebContentsId, false).catch((error: unknown): void => {
        this.reportBackgroundError("Could not clean up an unfinished video export.", error);
      });
    });

    try {
      await appWindow.loadFile(
        path.join(app.getAppPath(), "src", "app-window.html"),
        page ? { query: { page } } : {}
      );
      this.showAppWindow(appWindow);
      return appWindow;
    } catch (error) {
      if (!appWindow.isDestroyed()) {
        appWindow.close();
      }

      throw error;
    }
  }

  private hasEditingWorkToProtect(): boolean {
    return this.isEditorBusy() || (this.currentEditingSession?.unsavedWork() ?? null) !== null;
  }

  private isEditorBusy(): boolean {
    for (const editingSession of this.editingSessions.values()) {
      if (editingSession.isBusy) {
        return true;
      }
    }

    const { appWindow } = this;
    return (appWindow !== null && !appWindow.isDestroyed() && this.hasRecordingTempFilesForOwner(appWindow.webContents.id));
  }

  private async confirmCurrentEditingDiscard(appWindow: BrowserWindow): Promise<boolean> {
    if (this.isEditorBusy()) {
      throw new Error(busyEditorMessage);
    }

    const unsavedWork = this.currentEditingSession?.unsavedWork() ?? null;
    if (unsavedWork === null) {
      return true;
    }

    this.showAppWindow(appWindow);
    const { response } = await dialog.showMessageBox(appWindow, {
      ...unsavedEditingWorkPrompt(unsavedWork),
      buttons: ["Discard", "Keep editing"],
      cancelId: keepEditingButtonIndex,
      defaultId: keepEditingButtonIndex,
      noLink: true,
      title: appName,
      type: "warning"
    });
    return response === discardEditingWorkButtonIndex;
  }

  private async openEditor(data: Omit<EditorBootstrap, "sessionId">, temporaryFilePaths: readonly string[]): Promise<boolean> {
    return await this.editorOpenings.run(async (): Promise<boolean> => {
      const appWindow = await this.openAppWindow(null);
      if (!await this.confirmCurrentEditingDiscard(appWindow)) {
        return false;
      }

      const editingSession = new EditingSession({ ...data, sessionId: randomUUID() }, temporaryFilePaths);
      this.editingSessions.set(editingSession.id, editingSession);
      this.currentEditingSession = editingSession;
      this.sendToAppWindow(editorOpenedEventChannel);
      this.showAppWindow(appWindow);
      return true;
    });
  }

  private releaseEditingSession(editingSession: EditingSession): void {
    this.editingSessions.delete(editingSession.id);
    if (this.currentEditingSession === editingSession) {
      this.currentEditingSession = null;
    }

    void this.cleanupEditingSessionFiles(editingSession).catch((error: unknown): void => {
      this.reportBackgroundError("Could not clean up temporary editor files.", error);
    });
  }

  private emitShortcutRecordingEvent(appWindow: BrowserWindow, data: ShortcutRecordingEvent): void {
    if (appWindow.isDestroyed() || appWindow.webContents.isDestroyed()) {
      return;
    }

    appWindow.webContents.send(shortcutRecordingEventChannel, data);
  }

  private handleShortcutRecordingInput(appWindow: BrowserWindow, event: Electron.Event): void {
    if (this.shortcutRecordingWebContentsId === appWindow.webContents.id) {
      event.preventDefault();
    }
  }

  private cancelShortcutRecording(appWindow: BrowserWindow): void {
    if (this.shortcutRecordingWebContentsId !== appWindow.webContents.id || this.isShortcutRecordingSaving) {
      return;
    }

    this.stopShortcutRecording();
    this.emitShortcutRecordingEvent(appWindow, { target: this.shortcutRecordingTarget, type: "cancelled" });
  }

  private handleShortcutRecorderEvent(event: ShortcutRecorderEvent): void {
    const { appWindow } = this;
    if (!appWindow || appWindow.isDestroyed() || this.shortcutRecordingWebContentsId !== appWindow.webContents.id) {
      return;
    }

    const target = this.shortcutRecordingTarget;
    switch (event.type) {
      case "cancelled": {
        this.cancelShortcutRecording(appWindow);
        break;
      }

      case "error": {
        this.emitShortcutRecordingEvent(appWindow, { message: event.message, target, type: "error" });
        break;
      }

      case "preview": {
        this.emitShortcutRecordingEvent(appWindow, { shortcut: event.shortcut, target, type: "preview" });
        break;
      }

      case "recorded": {
        void this.saveRecordedShortcut(appWindow, event.shortcut);
        break;
      }

      default: {
        throw new Error(`Unexpected shortcut recorder event: ${JSON.stringify(event)}`);
      }
    }
  }

  private async saveRecordedShortcut(appWindow: BrowserWindow, shortcut: string): Promise<void> {
    if (this.isShortcutRecordingSaving) {
      return;
    }

    this.isShortcutRecordingSaving = true;
    const target = this.shortcutRecordingTarget;
    try {
      const settings = await this.applySettingsUpdate(
        target === "capture" ? { captureShortcut: shortcut } : { clips: { shortcut } }
      );
      this.stopShortcutRecording();
      this.emitShortcutRecordingEvent(appWindow, { settings, target, type: "saved" });
    } catch (error) {
      this.emitShortcutRecordingEvent(appWindow, { message: errorMessage(error), target, type: "error" });
    } finally {
      this.isShortcutRecordingSaving = false;
    }
  }

  private startShortcutRecording(event: Electron.IpcMainInvokeEvent, target: ShortcutTarget): void {
    const appWindow = this.getSenderAppWindow(event);
    if (this.shortcutRecordingWebContentsId === event.sender.id && this.shortcutRecordingTarget !== target) {
      this.emitShortcutRecordingEvent(appWindow, { target: this.shortcutRecordingTarget, type: "cancelled" });
    }

    this.shortcutRecordingWebContentsId = event.sender.id;
    this.shortcutRecordingTarget = target;
    this.shortcutRecorder.start();
  }

  private stopShortcutRecording(): void {
    if (this.shortcutRecordingWebContentsId === null) {
      return;
    }

    this.shortcutRecordingWebContentsId = null;
    this.shortcutRecorder.stop();
  }

  private settingsSnapshot(): AppSettings {
    return { ...this.currentSettings() };
  }

  private broadcastSettingsChanged(settings: AppSettings): void {
    const windows = [this.activeOverlay, this.preparedOverlay, this.appWindow];
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
        throw new TypeError("Quick Capture shortcut must be a string.");
      }

      nextSettings.captureShortcut = validateCaptureShortcut(update.captureShortcut);
    }

    if ("clips" in update) {
      nextSettings.clips = clipSettingsWithUpdate(currentSettings.clips, update.clips);
    }

    if ("editorShortcuts" in update) {
      nextSettings.editorShortcuts = editorShortcutsWithUpdate(currentSettings.editorShortcuts, update.editorShortcuts);
    }

    if ("exportDirectory" in update) {
      nextSettings.exportDirectory = validateExportDirectory(update.exportDirectory);
    }

    if ("exportPresetId" in update) {
      nextSettings.exportPresetId = validateExportPresetId(update.exportPresetId);
    }

    if ("launchAtStartup" in update) {
      nextSettings.launchAtStartup = isTrueSetting(update.launchAtStartup, "Launch at startup");
    }

    if ("microphoneDeviceId" in update) {
      nextSettings.microphoneDeviceId = validateMicrophoneDeviceId(update.microphoneDeviceId);
    }

    if ("playbackMuted" in update) {
      nextSettings.playbackMuted = isTrueSetting(update.playbackMuted, "Playback muted");
    }

    if ("playbackVolume" in update) {
      nextSettings.playbackVolume = validatePlaybackVolume(update.playbackVolume);
    }

    if ("recentClipsExpanded" in update) {
      nextSettings.recentClipsExpanded = isTrueSetting(update.recentClipsExpanded, "Recently viewed expanded");
    }

    if ("sidebarCollapsed" in update) {
      nextSettings.sidebarCollapsed = isTrueSetting(update.sidebarCollapsed, "Sidebar collapsed");
    }

    if ("systemAudioEnabled" in update) {
      nextSettings.systemAudioEnabled = isTrueSetting(update.systemAudioEnabled, "Desktop audio");
    }

    if (nextSettings.clips.shortcut === nextSettings.captureShortcut) {
      throw new Error(`${nextSettings.captureShortcut} is already used. Quick Capture and Clips need different shortcuts.`);
    }

    return nextSettings;
  }

  private async applySettingsUpdate(update: unknown): Promise<AppSettings> {
    return await this.settingsUpdates.run(async () => await this.applySettingsUpdateNow(update));
  }

  private async applySettingsUpdateNow(update: unknown): Promise<AppSettings> {
    const previousSettings = this.settingsSnapshot();
    const nextSettings = this.settingsWithUpdate(update);

    try {
      this.settings = nextSettings;
      if (nextSettings.captureShortcut !== previousSettings.captureShortcut) {
        this.bindCaptureShortcut();
      }

      this.clips.applySettings(previousSettings, nextSettings);
      if (nextSettings.launchAtStartup !== previousSettings.launchAtStartup) {
        await this.applyLaunchAtStartup(nextSettings.launchAtStartup);
      }

      await saveAppSettings(app.getPath("userData"), nextSettings);
      const savedSettings = this.settingsSnapshot();
      this.broadcastSettingsChanged(savedSettings);
      return savedSettings;
    } catch (error) {
      this.settings = previousSettings;
      const restoreErrors = await this.restoreAppliedSettings(nextSettings, previousSettings);
      if (restoreErrors.length > 0) {
        throw new AggregateError(
          [error, ...restoreErrors],
          "The settings update failed and the previous settings could not be fully restored.",
          { cause: error }
        );
      }

      throw error;
    } finally {
      this.refreshTrayMenu();
    }
  }

  private async restoreAppliedSettings(failedSettings: AppSettings, previousSettings: AppSettings): Promise<unknown[]> {
    const restoreErrors: unknown[] = [];
    if (failedSettings.captureShortcut !== previousSettings.captureShortcut) {
      this.bindCaptureShortcut();
    }

    try {
      this.clips.applySettings(failedSettings, previousSettings);
    } catch (restoreError) {
      restoreErrors.push(restoreError);
    }

    if (failedSettings.launchAtStartup !== previousSettings.launchAtStartup) {
      try {
        await this.applyLaunchAtStartup(previousSettings.launchAtStartup);
      } catch (restoreError) {
        restoreErrors.push(restoreError);
      }
    }

    return restoreErrors;
  }

  private async updateSettings(event: Electron.IpcMainInvokeEvent, update: unknown): Promise<AppSettings> {
    this.assertSenderWindow(event);
    return await this.applySettingsUpdate(update);
  }

  private async chooseClipsDirectory(event: Electron.IpcMainInvokeEvent): Promise<AppSettings | null> {
    const appWindow = this.getSenderAppWindow(event);
    const result = await dialog.showOpenDialog(appWindow, {
      defaultPath: this.clips.clipsDirectory(),
      properties: ["openDirectory", "createDirectory"],
      title: "Choose clips folder"
    });
    const [directory] = result.filePaths;
    if (result.canceled || !directory) {
      return null;
    }

    return await this.applySettingsUpdate({ clips: { directory } });
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

  private editorAudioTrack(editingSession: EditingSession, kind: AudioSourceKind): EditorAudioTrack {
    const audioTrack = editingSession.data.audioTracks.find((candidate) => candidate.kind === kind);
    if (!audioTrack) {
      throw new Error("The requested audio track does not belong to this editor.");
    }

    return audioTrack;
  }

  private async editorAudioFileSize(editingSession: EditingSession, kind: AudioSourceKind): Promise<number> {
    const fileStats = await stat(this.editorAudioTrack(editingSession, kind).sourceFilePath);
    return fileStats.size;
  }

  private async editorVideoFileSize(editingSession: EditingSession): Promise<number> {
    const fileStats = await stat(editingSession.data.sourceFilePath);
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

  private async readEditorVideoFile(editingSession: EditingSession, start: number, end: number): Promise<Uint8Array> {
    return await this.readEditorFile(editingSession.data.sourceFilePath, start, end, "video");
  }

  private async readEditorAudioFile(
    editingSession: EditingSession,
    kind: AudioSourceKind,
    start: number,
    end: number
  ): Promise<Uint8Array> {
    const audioTrack = this.editorAudioTrack(editingSession, kind);
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
    const overlay = BrowserWindow.fromWebContents(event.sender);
    let isOpened: boolean;
    try {
      if (!await this.hasUsableRecordingFile(recordingFile, mimeType)) {
        throw new Error("The recording did not contain usable video data.");
      }

      const editorAudioTracks = await this.editorAudioTracksFromRecordingFiles(audioTrackFiles);
      overlay?.hide();
      isOpened = await this.openEditor(
        {
          audioTracks: editorAudioTracks,
          canReuseSourceFile: true,
          durationSeconds,
          fps,
          mimeType,
          source: { capturePipeline, encoder, kind: "recording" },
          sourceFilePath: recordingFile.filePath,
          sourceUrl: pathToFileURL(recordingFile.filePath).toString()
        },
        recordingFiles.map((file) => file.filePath)
      );
    } catch (error) {
      if (overlay && !overlay.isDestroyed()) {
        overlay.show();
      }

      try {
        await this.cleanupRecordingFiles(recordingFiles, true);
      } catch (cleanupError) {
        throw combinedError("Could not open the editor or preserve its recording files.", [error, cleanupError]);
      }

      throw error;
    }

    if (!isOpened) {
      await this.cleanupRecordingFiles(recordingFiles, true);
    }

    if (overlay && !overlay.isDestroyed()) {
      overlay.close();
    }
  }

  private async openVideoFileEditor(filePath: string): Promise<boolean> {
    await this.initialization;
    if (this.currentEditingSession?.isEditingFile(filePath)) {
      await this.openAppWindow(null);
      return true;
    }

    const editedFileExtension = editedVideoFileExtension(fileExtensionName(filePath));
    const probe = await probeVideoFile(filePath);
    if (probe.startSeconds <= 0) {
      return await this.openEditorForVideoFile(filePath, filePath, editedFileExtension, probe, []);
    }

    const zeroStartFilePath = await this.createTemporaryVideoFilePath(editedFileExtension);
    let zeroStartProbe: VideoFileProbe;
    try {
      await remuxVideoToZeroStart(filePath, zeroStartFilePath, editedFileExtension);
      zeroStartProbe = await probeVideoFile(zeroStartFilePath);
    } catch (error) {
      await rm(zeroStartFilePath, { force: true });
      throw error;
    }

    let isOpened = false;
    try {
      isOpened = await this.openEditorForVideoFile(
        filePath,
        zeroStartFilePath,
        editedFileExtension,
        zeroStartProbe,
        [zeroStartFilePath]
      );
    } finally {
      if (!isOpened) {
        await rm(zeroStartFilePath, { force: true });
      }
    }

    return isOpened;
  }

  private async openEditorForVideoFile(
    originalFilePath: string,
    editorFilePath: string,
    editedFileExtension: VideoFileExtension,
    probe: VideoFileProbe,
    temporaryFilePaths: readonly string[]
  ): Promise<boolean> {
    const mimeType = `video/${editedFileExtension}`;
    const sourceUrl = pathToFileURL(editorFilePath).toString();
    const audioTracks = await this.videoFileAudioTracks(originalFilePath, editorFilePath, sourceUrl, mimeType, probe);
    return await this.openEditor(
      {
        audioTracks,
        canReuseSourceFile: fileExtensionName(editorFilePath) === editedFileExtension,
        durationSeconds: probe.durationSeconds,
        fps: probe.fps,
        mimeType,
        source: { fileName: path.basename(originalFilePath), filePath: originalFilePath, kind: "file" },
        sourceFilePath: editorFilePath,
        sourceUrl
      },
      temporaryFilePaths
    );
  }

  private async videoFileAudioTracks(
    originalFilePath: string,
    editorFilePath: string,
    sourceUrl: string,
    mimeType: string,
    probe: VideoFileProbe
  ): Promise<EditorAudioTrack[]> {
    const clipAudioTrackFiles = await this.clips.clipAudioTrackFiles(originalFilePath);
    if (clipAudioTrackFiles.length > 0) {
      return clipAudioTrackFiles.map((file): EditorAudioTrack => ({
        kind: file.kind,
        mimeType: clipAudioTrackMimeType,
        sourceFilePath: file.filePath,
        sourceUrl: pathToFileURL(file.filePath).toString()
      }));
    }

    return probe.hasAudio ? [{ kind: "clip", mimeType, sourceFilePath: editorFilePath, sourceUrl }] : [];
  }

  private async openVideoFileEditorWithErrorHandling(filePath: string): Promise<void> {
    try {
      await this.openVideoFileEditor(filePath);
    } catch (error) {
      await this.showErrorSafely(`Could not open ${path.basename(filePath)} in the editor.`, error);
    }
  }

  private openFirstVideoFileEditor(filePaths: readonly string[]): void {
    const filePath = filePaths.at(0);
    if (filePath) {
      void this.openVideoFileEditorWithErrorHandling(filePath);
    }
  }

  private async chooseVideoFileToOpenWithErrorHandling(): Promise<void> {
    try {
      const result = await dialog.showOpenDialog({
        filters: [
          {
            name: "Videos",
            extensions: [...openableVideoFileExtensions]
          }
        ],
        properties: ["openFile"],
        title: "Open video"
      });
      if (!result.canceled) {
        this.openFirstVideoFileEditor(result.filePaths);
      }
    } catch (error) {
      await this.showErrorSafely("Could not choose a video to open.", error);
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

  private refreshTrayMenu(): void {
    if (!this.tray) {
      return;
    }

    this.tray.setContextMenu(Menu.buildFromTemplate(this.trayMenuTemplate()));
  }

  private bindCaptureShortcut(): void {
    this.keyboard.bindShortcut("capture", this.currentCaptureShortcut(), (): void => {
      this.capture();
    });
  }

  private registerPermissionRequestHandler(): void {
    session.defaultSession.setPermissionCheckHandler((webContents, permission): boolean =>
      permission === mediaPermissionName
        && (this.isManagedMediaWebContents(webContents)
          || (webContents !== null && this.isAppWindowWebContents(webContents)))
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
    return window === this.activeOverlay || this.clips.isRecorderWindow(window);
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
      this.showOverlayWindow(overlay);
    });

    ipcMain.handle("overlay:select-capture-display", (event, displayId: unknown): void => {
      this.selectCaptureDisplay(event, displayId);
    });

    ipcMain.handle("capture:use-system-audio-fallback", (event): boolean => this.useSystemAudioFallback(event));

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
    this.registerAppIpcHandlers();
  }

  private registerRecordingIpcHandlers(): void {
    ipcMain.handle("recording:create-file", async (event, fileExtension: unknown): Promise<RecordingFile> => {
      this.getRecordingFileSender(event);
      return await this.createRecordingFile(event.sender.id, outputFileExtensionFromUnknown(fileExtension));
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

  private registerEditorSourceIpcHandlers(): void {
    ipcMain.handle("editor:get-video-file-size", async (event, sessionId: unknown): Promise<number> => {
      return await this.editorVideoFileSize(this.editingSessionForSender(event, sessionId));
    });

    ipcMain.handle(
      "editor:read-video-file",
      async (event, sessionId: unknown, start: unknown, end: unknown): Promise<Uint8Array> => {
        if (typeof start !== "number" || typeof end !== "number") {
          throw new TypeError("The video file byte range must contain numbers.");
        }

        return await this.readEditorVideoFile(this.editingSessionForSender(event, sessionId), start, end);
      }
    );

    ipcMain.handle("editor:get-audio-file-size", async (event, sessionId: unknown, kind: unknown): Promise<number> => {
      return await this.editorAudioFileSize(this.editingSessionForSender(event, sessionId), audioSourceKindFromUnknown(kind));
    });

    ipcMain.handle(
      "editor:read-audio-file",
      async (event, sessionId: unknown, kind: unknown, start: unknown, end: unknown): Promise<Uint8Array> => {
        if (typeof start !== "number" || typeof end !== "number") {
          throw new TypeError("The audio file byte range must contain numbers.");
        }

        return await this.readEditorAudioFile(
          this.editingSessionForSender(event, sessionId),
          audioSourceKindFromUnknown(kind),
          start,
          end
        );
      }
    );
  }

  private registerEditorSessionIpcHandlers(): void {
    ipcMain.handle("editor:get-bootstrap", (event): EditorBootstrap | null => {
      this.getSenderAppWindow(event);
      return this.currentEditingSession?.data ?? null;
    });

    ipcMain.handle("editor:set-unsaved-edits", (event, sessionId: unknown, hasUnsavedEdits: unknown): void => {
      this.editingSessionForSender(event, sessionId).setUnsavedEdits(isTrueSetting(hasUnsavedEdits, "Unsaved edits"));
    });

    ipcMain.handle("editor:confirm-close", async (event, sessionId: unknown): Promise<boolean> => {
      const editingSession = this.editingSessionForSender(event, sessionId);
      return editingSession !== this.currentEditingSession || await this.confirmCurrentEditingDiscard(this.getSenderAppWindow(event));
    });

    ipcMain.handle("editor:close", (event, sessionId: unknown): void => {
      this.releaseEditingSession(this.editingSessionForSender(event, sessionId));
    });
  }

  private registerEditorIpcHandlers(): void {
    this.registerEditorSourceIpcHandlers();
    this.registerEditorSessionIpcHandlers();

    ipcMain.handle("editor:choose-save-path", async (event, sessionId: unknown): Promise<SaveDialogResult> => {
      const editingSession = this.editingSessionForSender(event, sessionId);
      return await editingSession.runOperation(async () => await this.chooseEditorVideoSavePath(editingSession));
    });

    ipcMain.handle(
      "editor:choose-export-path",
      async (event, sessionId: unknown, fileExtension: unknown, fileLabel: unknown): Promise<SaveDialogResult> => {
        const editingSession = this.editingSessionForSender(event, sessionId);
        return await editingSession.runOperation(async () => await this.chooseEditorExportPath(
          editingSession,
          outputFileExtensionFromUnknown(fileExtension),
          exportFileLabelFromUnknown(fileLabel)
        ));
      }
    );

    ipcMain.handle(
      "editor:complete-output-file",
      async (event, sessionId: unknown, recordingId: unknown, fileExtension: unknown): Promise<CompletedOutputFile> => {
        const editingSession = this.editingSessionForSender(event, sessionId);
        return await editingSession.runOperation(async () => await this.completeEditorOutputFile(
          editingSession,
          event.sender.id,
          recordingIdFromUnknown(recordingId),
          outputFileExtensionFromUnknown(fileExtension)
        ));
      }
    );

    ipcMain.handle("editor:trim-video-end", async (event, sessionId: unknown, endSeconds: unknown): Promise<PreparedVideoFile> => {
      if (typeof endSeconds !== "number") {
        throw new TypeError("The trim end must be a number.");
      }

      const editingSession = this.editingSessionForSender(event, sessionId);
      return await editingSession.runOperation(async () => await this.trimEditorVideoEnd(editingSession, event.sender.id, endSeconds));
    });

    ipcMain.handle(
      "editor:save-prepared-video",
      async (event, sessionId: unknown, preparedFilePath: unknown, targetFilePath: unknown): Promise<SaveResult> => {
        const editingSession = this.editingSessionForSender(event, sessionId);
        const preparedPath = filePathFromUnknown(preparedFilePath);
        const targetPath = filePathFromUnknown(targetFilePath);
        return await editingSession.runOperation(async (): Promise<SaveResult> => {
          await this.savePreparedEditorVideo(editingSession, preparedPath, targetPath);
          return { filePath: targetPath };
        });
      }
    );

    ipcMain.handle("editor:copy-prepared-video", async (event, sessionId: unknown, filePath: unknown): Promise<void> => {
      const editingSession = this.editingSessionForSender(event, sessionId);
      const preparedPath = filePathFromUnknown(filePath);
      await editingSession.runOperation(async (): Promise<void> => {
        editingSession.assertPreparedFile(preparedPath);
        await (editingSession.hasTemporaryFile(preparedPath)
          ? this.copyEditorTempVideoToClipboard(editingSession, preparedPath)
          : writeFileDropListToClipboard(preparedPath));
        this.getSenderAppWindow(event).focus();
      });
    });
  }

  private async copyEditorTempVideoToClipboard(editingSession: EditingSession, filePath: string): Promise<void> {
    const clipboardFilePath = await this.createTemporaryVideoFilePath(
      outputFileExtensionFromUnknown(fileExtensionName(filePath)),
      shortLivedRecordingFilePrefix
    );
    try {
      await link(filePath, clipboardFilePath);
      await writeFileDropListToClipboard(clipboardFilePath);
    } catch (error) {
      await rm(clipboardFilePath, { force: true });
      throw error;
    }

    const previousClipboardFilePath = editingSession.replaceClipboardFile(clipboardFilePath);
    if (previousClipboardFilePath !== null) {
      await rm(previousClipboardFilePath, { force: true });
    }
  }

  private registerAppIpcHandlers(): void {
    ipcMain.handle("settings:get", (event): AppSettings => {
      this.assertSenderWindow(event);
      return this.settingsSnapshot();
    });

    ipcMain.handle("settings:update", async (event, settings: unknown): Promise<AppSettings> => {
      return await this.updateSettings(event, settings);
    });

    ipcMain.handle("app:ready-to-show", (event): void => {
      this.showAppWindow(this.getSenderAppWindow(event));
    });

    ipcMain.handle("app:get-info", (event): AppInfo => {
      this.getSenderAppWindow(event);
      return { isUpdateReady: this.isUpdateReady, version: app.getVersion() };
    });

    ipcMain.handle("app:install-update", (event): void => {
      this.installReadyUpdate(event);
    });

    ipcMain.handle("app:begin-shortcut-recording", (event, target: unknown): void => {
      this.startShortcutRecording(event, shortcutTargetFromUnknown(target));
    });

    ipcMain.handle("app:get-key-labels", (event): ShortcutKeyLabels => {
      this.getSenderAppWindow(event);
      return characterKeyLabels();
    });

    ipcMain.handle("clips:choose-directory", async (event): Promise<AppSettings | null> => {
      return await this.chooseClipsDirectory(event);
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

  private async openRecordingTempDirectoryWithErrorHandling(): Promise<void> {
    try {
      await this.openRecordingTempDirectory();
    } catch (error) {
      await this.showErrorSafely("Could not open recent recordings.", error);
    }
  }

  private async openAppWindowWithErrorHandling(page: AppPage | null): Promise<void> {
    try {
      await this.openAppWindow(page);
    } catch (error) {
      await this.showErrorSafely("Could not open Softshot.", error);
    }
  }

  private trayMenuTemplate(): Electron.MenuItemConstructorOptions[] {
    const captureAccelerator = shortcutAccelerator(this.currentCaptureShortcut());
    const template: Electron.MenuItemConstructorOptions[] = [
      {
        ...(captureAccelerator !== null && { accelerator: captureAccelerator }),
        click: (): void => {
          this.capture();
        },
        label: "Quick Capture"
      }
    ];

    const { clips } = this.currentSettings();
    if (clips.enabled) {
      const clipAccelerator = shortcutAccelerator(clips.shortcut);
      template.push({
        ...(clipAccelerator !== null && { accelerator: clipAccelerator }),
        click: (): void => {
          this.clips.saveClip();
        },
        enabled: this.clips.isRecording(),
        label: "Save clip"
      });
    }

    template.push(
      { type: "separator" },
      {
        label: "Open Softshot",
        click: (): void => {
          void this.openAppWindowWithErrorHandling(null);
        }
      },
      {
        label: "Open video...",
        click: (): void => {
          void this.chooseVideoFileToOpenWithErrorHandling();
        }
      },
      {
        label: "Recent recordings",
        click: (): void => {
          void this.openRecordingTempDirectoryWithErrorHandling();
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

  private async cleanupEditingSessionFiles(editingSession: EditingSession): Promise<void> {
    const { deletedFiles, isCompleted, retainedFiles } = editingSession.fileCleanup();
    await Promise.all(deletedFiles.map(async (filePath): Promise<void> => {
      await rm(filePath, { force: true });
    }));

    const keptFiles = isCompleted
      ? await Promise.all(retainedFiles.map(async (filePath) => await this.moveToShortLivedFile(filePath)))
      : retainedFiles;
    const retentionMs = isCompleted ? shortLivedRecordingRetentionMs : standardRecordingRetentionMs;
    const retainedAt = new Date();
    for (const filePath of keptFiles) {
      await utimes(filePath, retainedAt, retainedAt);
      this.scheduleTemporaryFileDeletion(filePath, retentionMs);
    }

    const notificationFilePath = keptFiles[0];
    if (notificationFilePath) {
      this.notifyRecoverableRecording(notificationFilePath, isCompleted ? "20 minutes" : "7 days");
    }
  }

  private async moveToShortLivedFile(filePath: string): Promise<string> {
    if (path.basename(filePath).startsWith(shortLivedRecordingFilePrefix)) {
      return filePath;
    }

    const fileExtension = outputFileExtensionFromUnknown(fileExtensionName(filePath));
    const targetFilePath = await this.createTemporaryVideoFilePath(fileExtension, shortLivedRecordingFilePrefix);
    await rename(filePath, targetFilePath);
    return targetFilePath;
  }

  private async completeEditorOutputFile(
    editingSession: EditingSession,
    ownerWebContentsId: number,
    recordingId: string,
    fileExtension: OutputFileExtension
  ): Promise<CompletedOutputFile> {
    const recordingFile = this.takeRecordingTempFile(recordingId, ownerWebContentsId);
    try {
      if (fileExtensionName(recordingFile.filePath) !== fileExtension) {
        throw new Error("The prepared file format does not match its output file.");
      }

      if (!await this.hasUsableOutputFile(recordingFile, fileExtension)) {
        throw new Error("The prepared file did not contain usable media data.");
      }

      editingSession.registerTemporaryFile(recordingFile.filePath);
      return { byteLength: recordingFile.byteLength, filePath: recordingFile.filePath };
    } catch (error) {
      await rm(recordingFile.filePath, { force: true });
      throw error;
    }
  }

  private async savePreparedEditorVideo(editingSession: EditingSession, preparedFilePath: string, targetFilePath: string): Promise<void> {
    editingSession.assertPreparedFile(preparedFilePath);
    editingSession.assertSavePath(targetFilePath);
    const fileExtension = outputFileExtensionFromUnknown(fileExtensionName(preparedFilePath));
    if (fileExtensionName(targetFilePath) !== fileExtension) {
      throw new Error(`Save the file with the .${fileExtension} extension.`);
    }

    await mkdir(path.dirname(targetFilePath), { recursive: true });
    await this.replaceFileAtomically(targetFilePath, async (temporaryFilePath): Promise<void> => {
      await copyFile(preparedFilePath, temporaryFilePath);
    });
    editingSession.markSaved(preparedFilePath, targetFilePath);
    this.notifySaved(this.editorSavedNotificationTitle(editingSession, fileExtension), targetFilePath);
  }

  private async createTemporaryVideoFilePath(
    fileExtension: OutputFileExtension,
    filePrefix = `${appName} `
  ): Promise<string> {
    const targetDirectory = this.recordingTempDirectory();
    await mkdir(targetDirectory, { recursive: true });

    return path.join(targetDirectory, `${filePrefix}${fileTimestamp(new Date())} ${randomUUID()}.${fileExtension}`);
  }

  private async trimEditorVideoEnd(
    editingSession: EditingSession,
    ownerWebContentsId: number,
    endSeconds: number
  ): Promise<PreparedVideoFile> {
    const editorData = editingSession.data;
    if (!Number.isFinite(endSeconds) || endSeconds <= 0 || endSeconds >= editorData.durationSeconds) {
      throw new RangeError("The trim end must be within the source recording duration.");
    }

    const fileExtension = videoFileExtension(editorData.mimeType);
    const outputFilePath = await this.createTemporaryVideoFilePath(fileExtension);
    try {
      await remuxVideoEnd(editorData.sourceFilePath, outputFilePath, fileExtension, endSeconds);
      const outputStats = await stat(outputFilePath);
      const outputFile: RecordingTemporaryFile = {
        byteLength: outputStats.size,
        filePath: outputFilePath,
        ownerWebContentsId
      };
      if (!await this.hasUsableRecordingFile(outputFile, editorData.mimeType)) {
        throw new Error("The trimmed recording did not contain usable video data.");
      }

      editingSession.registerTemporaryFile(outputFilePath);
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

    app.on("second-instance", (...eventArguments): void => {
      const [, argv, workingDirectory] = eventArguments;
      const videoFilePaths = videoFilePathsFromArguments(argv, workingDirectory);
      if (videoFilePaths.length === 0) {
        void this.openAppWindowWithErrorHandling(null);
        return;
      }

      this.openFirstVideoFileEditor(videoFilePaths);
    });

    app.on("before-quit", (): void => {
      this.isQuitting = true;
    });

    app.on("will-quit", (): void => {
      this.clips.stop();
      this.keyboard.stop();
    });

    app.on("window-all-closed", (): void => {
      this.debugLog("Kept tray app running after overlay closed.");
    });

    this.initialization = this.initializeWhenReady();
    this.openFirstVideoFileEditor(videoFilePathsFromArguments(process.argv, process.cwd()));
  }
}

function unsavedEditingWorkPrompt(unsavedWork: UnsavedEditingWork): Pick<Electron.MessageBoxOptions, "detail" | "message"> {
  return unsavedWork === "edits"
    ? { detail: "Your changes to this video haven't been saved.", message: "Discard your edits?" }
    : { detail: "This recording hasn't been saved. Softshot keeps a copy in Recent recordings for 7 days.", message: "Discard this recording?" };
}

function audioTrackLabel(kind: RecordingAudioSourceKind): string {
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

function recordingAudioTrackKindFromUnknown(value: Record<string, unknown>): RecordingAudioSourceKind {
  if (isRecordingAudioSourceKind(value.kind)) {
    return value.kind;
  }

  throw new TypeError("Recording audio track kind must be microphone or system.");
}

function audioSourceKindFromUnknown(value: unknown): AudioSourceKind {
  if (isAudioSourceKind(value)) {
    return value;
  }

  throw new TypeError("Audio track kind must be microphone, system, or clip.");
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

function editedVideoFileExtension(sourceFileExtension: string): VideoFileExtension {
  if (!openableVideoFileExtensions.has(sourceFileExtension)) {
    throw new Error("Only MP4, MOV, MKV, and WebM videos can be opened in the editor.");
  }

  return sourceFileExtension === "webm" ? "webm" : "mp4";
}

function videoFilePathsFromArguments(argv: readonly string[], workingDirectory: string): string[] {
  return argv
    .slice(1)
    .filter((argument) => !argument.startsWith("-")
      && openableVideoFileExtensions.has(fileExtensionName(argument)))
    .map((argument) => path.resolve(workingDirectory, argument));
}

function fileExtensionName(filePath: string): string {
  return path.extname(filePath).slice(1).toLowerCase();
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

function outputFileExtensionFromUnknown(value: unknown): OutputFileExtension {
  if (isOutputFileExtension(value)) {
    return value;
  }

  throw new TypeError("Output file extension must be mp4, webm, gif, m4a, or wav.");
}

function filePathFromUnknown(value: unknown): string {
  if (typeof value === "string" && path.isAbsolute(value)) {
    return value;
  }

  throw new TypeError("File path must be an absolute path.");
}

function exportFileLabelFromUnknown(value: unknown): string {
  if (typeof value === "string" && exportFileLabelPattern.test(value)) {
    return value;
  }

  throw new TypeError("Export file label must be a short name of letters, digits, and spaces.");
}

async function readFileHeader(filePath: string): Promise<Uint8Array> {
  const fileHandle = await open(filePath, "r");
  try {
    const header = new Uint8Array(fileHeaderByteLength);
    const { bytesRead } = await fileHandle.read(header, 0, fileHeaderByteLength, 0);
    return header.subarray(0, bytesRead);
  } finally {
    await fileHandle.close();
  }
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

function trailingBytes(bytes: Uint8Array, maxByteLength: number): Uint8Array {
  const start = Math.max(0, bytes.byteLength - maxByteLength);
  return bytes.slice(start);
}

function shortcutTargetFromUnknown(value: unknown): ShortcutTarget {
  if (value === "capture" || value === "clips") {
    return value;
  }

  throw new TypeError("Shortcut target must be capture or clips.");
}

const softshotApp = new SoftshotApp();
softshotApp.start();
