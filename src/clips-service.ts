import { access, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import { app, BrowserWindow, type Display, globalShortcut, ipcMain, screen, shell } from "electron";

import { errorMessage } from "./async-errors";
import { ClipCaptureSession, type ClipCaptureSessionOptions, type ClipCaptureSnapshot } from "./clip-capture-session";
import { muxClip } from "./clip-muxer";
import {
  clipSourceName,
  ClipSourceResolver,
  primaryScreenSource,
  type ResolvedClipSource,
  windowHandle
} from "./clip-sources";
import { type ClipCaptureTarget, type ClipVideoEncoder, epochSeconds, findClipVideoEncoder } from "./clip-video-capture";
import { ClipsLibrary } from "./clips-library";
import { captureGeometry, type MonitorGeometry, writeFileDropListToClipboard } from "./powershell";
import type {
  ClipEntry,
  ClipRecorderConfig,
  ClipSettings,
  ClipSourceOptions,
  ClipsState,
  ClipsStatus
} from "./shared";
import { clipDurationLabel, clipQualityDimensions, fileTimestamp } from "./shared";
import { TaskQueue } from "./task-queue";
import type { ToastOptions } from "./toast-window";
import { videoBitrate } from "./video-bitrate";
import { probeVideoFile } from "./video-file-probe";

const appName = "Softshot";
const clipsFolderName = "Clips";
const clipsLibraryFolderName = "clips";
const clipFileExtension = "mp4";
const ffmpegFolderName = "ffmpeg";
const ffmpegExecutableName = "ffmpeg.exe";
const sourcePollIntervalMs = 4000;
const firstCaptureRetryDelayMs = 5000;
const captureRetryBackoffFactor = 2;
const maxCaptureRetries = 5;
const maxClipFileNameLength = 80;
const maxClipFileNameAttempts = 100;
const minimumVideoDimension = 2;
const halfDivisor = 2;
const invalidFileNameCharacters = /[<>:"/\\|?*\p{Cc}]+/gu;
const repeatedSpaces = /\s+/gu;

export interface ClipsServiceHost {
  clipSettings(): ClipSettings;
  isAppWindowSender(sender: Electron.WebContents): boolean;
  libraryChanged(): void;
  openGallery(): void;
  openVideoFile(filePath: string): Promise<void>;
  preloadScriptPath(): string;
  recorderClosed(webContentsId: number): void;
  showToast(toast: ToastOptions): void;
  statusChanged(): void;
  takeClipRecording(recordingId: string, ownerWebContentsId: number): Promise<string>;
}

interface VideoSize {
  height: number;
  width: number;
}

export class ClipsService {
  private encoder: ClipVideoEncoder | null = null;

  private generation = 0;

  private isShortcutSuspended = false;

  private isShortcutUnavailable = false;

  private libraryInstance: ClipsLibrary | null = null;

  private pollTimeout: ReturnType<typeof setTimeout> | null = null;

  private registeredShortcut: string | null = null;

  private retryCount = 0;

  private readonly saves = new TaskQueue();

  private savingCount = 0;

  private session: ClipCaptureSession | null = null;

  private readonly sources = new ClipSourceResolver();

  private status: ClipsStatus = { isShortcutAvailable: true, message: null, sourceName: null, state: "off" };

  constructor(private readonly host: ClipsServiceHost) {}

  private get library(): ClipsLibrary {
    this.libraryInstance ??= new ClipsLibrary(path.join(app.getPath("userData"), clipsLibraryFolderName));
    return this.libraryInstance;
  }

  private setStatus(state: ClipsState, sourceName: string | null = null, message: string | null = null): void {
    this.status = { isShortcutAvailable: !this.isShortcutUnavailable, message, sourceName, state };
    this.host.statusChanged();
  }

  private refreshShortcutStatus(): void {
    this.setStatus(this.status.state, this.status.sourceName, this.status.message);
  }

  private syncShortcut(settings: ClipSettings): boolean {
    const desiredShortcut = settings.enabled && !this.isShortcutSuspended ? settings.shortcut : null;
    if (desiredShortcut !== null && desiredShortcut === this.registeredShortcut) {
      return true;
    }

    if (this.registeredShortcut !== null) {
      globalShortcut.unregister(this.registeredShortcut);
      this.registeredShortcut = null;
    }

    if (desiredShortcut === null) {
      this.isShortcutUnavailable = false;
      return true;
    }

    const isRegistered = globalShortcut.register(desiredShortcut, (): void => {
      this.saveClip();
    });
    this.registeredShortcut = isRegistered ? desiredShortcut : null;
    this.isShortcutUnavailable = !isRegistered;
    return isRegistered;
  }

  private clearPoll(): void {
    if (this.pollTimeout === null) {
      return;
    }

    clearTimeout(this.pollTimeout);
    this.pollTimeout = null;
  }

  private schedulePoll(delayMs = sourcePollIntervalMs): void {
    this.clearPoll();
    this.pollTimeout = setTimeout((): void => {
      this.pollTimeout = null;
      void this.startCaptureWhenAvailable();
    }, delayMs);
  }

  private failCapture(sourceName: string, message: string): void {
    this.setStatus("error", sourceName, message);
    if (this.retryCount >= maxCaptureRetries) {
      return;
    }

    this.schedulePoll(firstCaptureRetryDelayMs * captureRetryBackoffFactor ** this.retryCount);
    this.retryCount += 1;
  }

  private closeSession(): void {
    const { session } = this;
    this.session = null;
    session?.stop();
  }

  private hasSession(): boolean {
    return this.session !== null;
  }

  private restartCapture(): void {
    this.generation += 1;
    this.retryCount = 0;
    this.clearPoll();
    this.closeSession();
    void this.startCaptureWhenAvailable();
  }

  private async startCaptureWhenAvailable(): Promise<void> {
    const { generation } = this;
    const settings = this.host.clipSettings();
    if (!settings.enabled) {
      this.setStatus("off");
      return;
    }

    if (this.session) {
      return;
    }

    try {
      const resolvedSource = await this.sources.resolve(settings.source);
      const options = resolvedSource ? await this.sessionOptions(resolvedSource, settings) : null;
      if (generation !== this.generation || this.hasSession()) {
        return;
      }

      if (!resolvedSource || !options) {
        this.setStatus("waiting", clipSourceName(settings.source));
        this.schedulePoll();
        return;
      }

      this.openSession(options);
    } catch (error) {
      if (generation === this.generation) {
        this.failCapture(clipSourceName(settings.source), errorMessage(error));
      }
    }
  }

  private openSession(options: ClipCaptureSessionOptions): void {
    const sourceName = options.source.name;
    const session: ClipCaptureSession = new ClipCaptureSession(options, {
      ended: (): void => {
        if (this.session !== session) {
          return;
        }

        this.closeSession();
        this.setStatus("waiting", sourceName);
        this.schedulePoll();
      },
      failed: (message): void => {
        if (this.session !== session) {
          return;
        }

        this.closeSession();
        this.failCapture(sourceName, message);
      },
      recorderClosed: (webContentsId): void => {
        this.host.recorderClosed(webContentsId);
      },
      started: (): void => {
        if (this.session !== session) {
          return;
        }

        this.retryCount = 0;
        this.setStatus("recording", sourceName);
      }
    });
    this.session = session;
    this.setStatus("starting", sourceName);
  }

  private async sessionOptions(
    resolvedSource: ResolvedClipSource,
    settings: ClipSettings
  ): Promise<ClipCaptureSessionOptions | null> {
    const ffmpegPath = await this.ffmpegPath();
    this.encoder ??= await findClipVideoEncoder(ffmpegPath);
    const { display } = resolvedSource;
    const handle = display ? null : windowHandle(resolvedSource.source.id);
    const geometry = await captureGeometry(handle);
    const qualityBox = clipQualityDimensions[settings.quality];
    let target: ClipCaptureTarget;
    let size: VideoSize;
    if (display) {
      const monitor = monitorForDisplay(geometry.monitors, display);
      target = { handle: monitor.handle, kind: "display" };
      size = fitWithin({ height: monitor.bottom - monitor.top, width: monitor.right - monitor.left }, qualityBox);
    } else {
      if (!geometry.window || handle === null) {
        return null;
      }

      target = { handle, kind: "window" };
      const hasUsableSize = !geometry.window.isMinimized
        && geometry.window.width >= minimumVideoDimension
        && geometry.window.height >= minimumVideoDimension;
      size = fitWithin(hasUsableSize ? geometry.window : qualityBox, qualityBox);
    }

    return {
      audioCaptureSource: settings.systemAudioEnabled ? await primaryScreenSource() : null,
      bitrate: videoBitrate(size.width, size.height, settings.fps),
      encoder: this.encoder,
      ffmpegPath,
      height: size.height,
      preloadScriptPath: this.host.preloadScriptPath(),
      settings,
      source: resolvedSource,
      target,
      width: size.width
    };
  }

  private async ffmpegPath(): Promise<string> {
    const filePath = app.isPackaged
      ? path.join(process.resourcesPath, ffmpegFolderName, ffmpegExecutableName)
      : path.join(app.getAppPath(), "vendor", ffmpegFolderName, ffmpegExecutableName);
    try {
      await access(filePath);
    } catch {
      throw new Error(app.isPackaged
        ? "Softshot's FFmpeg component is missing. Reinstall Softshot to use Clips."
        : `FFmpeg is missing at ${filePath}. Run npm run build:ffmpeg to build it.`);
    }

    return filePath;
  }

  private sessionForSender(event: Electron.IpcMainInvokeEvent): ClipCaptureSession {
    const window = BrowserWindow.fromWebContents(event.sender);
    const { session } = this;
    if (!session?.isRecorderWindow(window)) {
      throw new Error("Only the active clip recorder can use clip recorder controls.");
    }

    return session;
  }

  private assertAppSender(event: Electron.IpcMainInvokeEvent): void {
    if (!this.host.isAppWindowSender(event.sender)) {
      throw new Error("Only the Softshot window can manage clips.");
    }
  }

  private async saveClipFrom(session: ClipCaptureSession, requestedAtEpochSeconds: number): Promise<void> {
    this.savingCount += 1;
    try {
      const thumbnailPromise = session.thumbnail();
      const capture = await session.snapshot(requestedAtEpochSeconds);
      try {
        await this.writeClip(capture, requestedAtEpochSeconds, session.clipName, await thumbnailPromise);
      } finally {
        if (capture.audioFilePath !== null) {
          await rm(capture.audioFilePath, { force: true });
        }
      }
    } finally {
      this.savingCount -= 1;
    }
  }

  private async writeClip(
    capture: ClipCaptureSnapshot,
    endEpochSeconds: number,
    clipName: string,
    thumbnail: Uint8Array
  ): Promise<void> {
    const createdAt = new Date();
    const directory = this.clipsDirectory();
    await mkdir(directory, { recursive: true });
    const filePath = await availableClipFilePath(directory, clipName, createdAt);
    const { durationSeconds } = this.host.clipSettings();
    let savedDurationSeconds: number;
    try {
      await muxClip({
        audioFilePath: capture.audioFilePath,
        durationSeconds,
        endEpochSeconds,
        outputFilePath: filePath,
        video: capture.video
      });
      const probe = await probeVideoFile(filePath);
      await this.library.add({
        createdAt,
        durationSeconds: probe.durationSeconds,
        filePath,
        height: probe.height,
        sourceName: clipName,
        width: probe.width
      }, thumbnail);
      savedDurationSeconds = Math.min(durationSeconds, Math.round(probe.durationSeconds));
    } catch (error) {
      await rm(filePath, { force: true });
      throw error;
    }

    this.host.libraryChanged();
    this.host.showToast({
      detail: null,
      onClick: (): void => {
        this.host.openGallery();
      },
      title: `Last ${clipDurationLabel(savedDurationSeconds)} clipped!`,
      tone: "info"
    });
  }

  private notifyClipNotSaved(message: string): void {
    this.host.showToast({ detail: message, onClick: null, title: "Clip not saved", tone: "error" });
  }

  private async clipFilePath(clipId: unknown): Promise<string> {
    const clip = await this.library.find(clipIdFromUnknown(clipId));
    return clip.filePath;
  }

  private async deleteClip(clipId: string): Promise<void> {
    const filePath = await this.clipFilePath(clipId);
    if (await fileExists(filePath)) {
      await shell.trashItem(filePath);
    }

    await this.library.remove(clipId);
    this.host.libraryChanged();
  }

  private async openClipsDirectory(): Promise<void> {
    const directory = this.clipsDirectory();
    await mkdir(directory, { recursive: true });
    const error = await shell.openPath(directory);
    if (error) {
      throw new Error(error);
    }
  }

  private registerRecorderIpcHandlers(): void {
    ipcMain.handle("clips:get-recorder-config", (event): ClipRecorderConfig =>
      this.sessionForSender(event).recorderConfig()
    );

    ipcMain.handle("clips:recorder-started", (event): void => {
      this.sessionForSender(event).handleRecorderStarted();
    });

    ipcMain.handle("clips:recorder-ended", (event): void => {
      const session = this.sessionForSender(event);
      this.closeSession();
      this.setStatus("waiting", session.sourceName);
      this.schedulePoll();
    });

    ipcMain.handle("clips:recorder-failed", (event, message: unknown): void => {
      const session = this.sessionForSender(event);
      this.closeSession();
      this.setStatus("error", session.sourceName, nonEmptyMessage(message, "The clip audio recorder failed."));
    });

    ipcMain.handle("clips:audio-snapshot-ready", async (event, requestId: unknown, recordingId: unknown): Promise<void> => {
      const session = this.sessionForSender(event);
      const filePath = await this.host.takeClipRecording(identifierFromUnknown(recordingId), event.sender.id);
      await session.resolveAudioSnapshot(identifierFromUnknown(requestId), filePath);
    });

    ipcMain.handle("clips:audio-snapshot-failed", (event, requestId: unknown, message: unknown): void => {
      this.sessionForSender(event).rejectAudioSnapshot(
        identifierFromUnknown(requestId),
        nonEmptyMessage(message, "The clip audio could not be saved.")
      );
    });
  }

  private registerAppIpcHandlers(): void {
    ipcMain.handle("clips:get-status", (event): ClipsStatus => {
      this.assertAppSender(event);
      return this.currentStatus();
    });

    ipcMain.handle("clips:list-sources", async (event): Promise<ClipSourceOptions> => {
      this.assertAppSender(event);
      return await this.sources.listOptions();
    });

    ipcMain.handle("clips:save", (event): void => {
      this.assertAppSender(event);
      this.saveClip();
    });

    ipcMain.handle("clips:restart", (event): void => {
      this.assertAppSender(event);
      this.restartCapture();
    });

    ipcMain.handle("clips:get-directory", (event): string => {
      this.assertAppSender(event);
      return this.clipsDirectory();
    });

    ipcMain.handle("clips:open-directory", async (event): Promise<void> => {
      this.assertAppSender(event);
      await this.openClipsDirectory();
    });

    this.registerLibraryIpcHandlers();
  }

  private registerLibraryIpcHandlers(): void {
    ipcMain.handle("clips:list", async (event): Promise<ClipEntry[]> => {
      this.assertAppSender(event);
      return await this.library.list();
    });

    ipcMain.handle("clips:open", async (event, clipId: unknown): Promise<void> => {
      this.assertAppSender(event);
      await this.host.openVideoFile(await this.clipFilePath(clipId));
    });

    ipcMain.handle("clips:copy", async (event, clipId: unknown): Promise<void> => {
      this.assertAppSender(event);
      await writeFileDropListToClipboard(await this.clipFilePath(clipId));
    });

    ipcMain.handle("clips:show-in-folder", async (event, clipId: unknown): Promise<void> => {
      this.assertAppSender(event);
      shell.showItemInFolder(await this.clipFilePath(clipId));
    });

    ipcMain.handle("clips:delete", async (event, clipId: unknown): Promise<void> => {
      this.assertAppSender(event);
      await this.deleteClip(clipIdFromUnknown(clipId));
    });
  }

  applySettings(previous: ClipSettings, next: ClipSettings): void {
    const isRegistered = this.syncShortcut(next);
    this.refreshShortcutStatus();
    if (!isRegistered) {
      throw new Error(`Could not register ${next.shortcut}. Another app may be using it.`);
    }

    if (haveCaptureSettingsChanged(previous, next)) {
      this.restartCapture();
    }
  }

  clipsDirectory(): string {
    return this.host.clipSettings().directory ?? path.join(app.getPath("videos"), appName, clipsFolderName);
  }

  currentStatus(): ClipsStatus {
    return { ...this.status };
  }

  displayMediaSource(webContentsId: number): Electron.DesktopCapturerSource | null {
    return this.session?.displayMediaSource(webContentsId) ?? null;
  }

  isBusy(): boolean {
    return this.savingCount > 0;
  }

  isRecorderWindow(window: BrowserWindow | null): boolean {
    return this.session?.isRecorderWindow(window) ?? false;
  }

  isRecording(): boolean {
    return this.status.state === "recording";
  }

  registeredShortcutAccelerator(): string | null {
    return this.registeredShortcut;
  }

  saveClip(): void {
    const { session } = this;
    if (!session || this.status.state !== "recording") {
      this.notifyClipNotSaved(clipsUnavailableMessage(this.status));
      return;
    }

    const requestedAtEpochSeconds = epochSeconds();
    void this.saves.run(async (): Promise<void> => {
      try {
        await this.saveClipFrom(session, requestedAtEpochSeconds);
      } catch (error) {
        this.notifyClipNotSaved(errorMessage(error));
      }
    });
  }

  setShortcutSuspended(isSuspended: boolean): void {
    this.isShortcutSuspended = isSuspended;
    this.syncShortcut(this.host.clipSettings());
    this.refreshShortcutStatus();
  }

  start(): void {
    this.registerRecorderIpcHandlers();
    this.registerAppIpcHandlers();
    this.syncShortcut(this.host.clipSettings());
    this.restartCapture();
  }

  stop(): void {
    this.generation += 1;
    this.clearPoll();
    this.closeSession();
  }
}

function haveCaptureSettingsChanged(previous: ClipSettings, next: ClipSettings): boolean {
  return previous.enabled !== next.enabled
    || previous.durationSeconds !== next.durationSeconds
    || previous.fps !== next.fps
    || previous.microphoneDeviceId !== next.microphoneDeviceId
    || previous.quality !== next.quality
    || previous.systemAudioEnabled !== next.systemAudioEnabled
    || JSON.stringify(previous.source) !== JSON.stringify(next.source);
}

function fitWithin(size: VideoSize, box: VideoSize): VideoSize {
  const scale = Math.min(1, box.width / size.width, box.height / size.height);
  return {
    height: evenDimension(size.height * scale),
    width: evenDimension(size.width * scale)
  };
}

function evenDimension(value: number): number {
  return Math.max(minimumVideoDimension, Math.floor(value / minimumVideoDimension) * minimumVideoDimension);
}

function monitorForDisplay(monitors: readonly MonitorGeometry[], display: Display): MonitorGeometry {
  const bounds = screen.dipToScreenRect(null, display.bounds);
  const centerX = bounds.x + bounds.width / halfDivisor;
  const centerY = bounds.y + bounds.height / halfDivisor;
  const monitor = monitors.find((candidate) =>
    centerX >= candidate.left && centerX < candidate.right && centerY >= candidate.top && centerY < candidate.bottom
  );
  if (!monitor) {
    throw new Error("Could not find the selected monitor.");
  }

  return monitor;
}

function identifierFromUnknown(value: unknown): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  throw new TypeError("Clip recorder ids must be non-empty strings.");
}

function nonEmptyMessage(value: unknown, fallbackMessage: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallbackMessage;
}

function clipIdFromUnknown(value: unknown): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  throw new TypeError("Clip id must be a non-empty string.");
}

function clipsUnavailableMessage(status: ClipsStatus): string {
  switch (status.state) {
    case "starting": {
      return "Clips is still starting. Try again in a moment.";
    }

    case "waiting": {
      return `Clips is waiting for ${status.sourceName ?? "the selected source"}.`;
    }

    case "error": {
      return status.message ?? "Clips stopped because of an error.";
    }

    case "off":
    case "recording": {
      return "Turn on Clips in Softshot to save clips.";
    }

    default: {
      throw new Error(`Unexpected clips state: ${String(status.state)}`);
    }
  }
}

async function availableClipFilePath(directory: string, sourceName: string, createdAt: Date): Promise<string> {
  const baseName = `${clipFileBaseName(sourceName)} ${fileTimestamp(createdAt)}`;
  for (let attempt = 1; attempt <= maxClipFileNameAttempts; attempt += 1) {
    const suffix = attempt === 1 ? "" : ` ${String(attempt)}`;
    const filePath = path.join(directory, `${baseName}${suffix}.${clipFileExtension}`);
    if (!await fileExists(filePath)) {
      return filePath;
    }
  }

  throw new Error("Could not find a free file name for the clip.");
}

function clipFileBaseName(sourceName: string): string {
  const cleanName = sourceName
    .replaceAll(invalidFileNameCharacters, " ")
    .replaceAll(repeatedSpaces, " ")
    .trim()
    .slice(0, maxClipFileNameLength)
    .trim();
  return cleanName || appName;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}
