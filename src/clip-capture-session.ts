import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";

import { app, BrowserWindow, desktopCapturer } from "electron";

import { errorMessage } from "./async-errors";
import type { ResolvedClipSource } from "./clip-sources";
import {
  type ClipCaptureTarget,
  ClipVideoCapture,
  type ClipVideoEncoder,
  type ClipVideoExit,
  type ClipVideoSnapshot
} from "./clip-video-capture";
import type { ClipRecorderConfig, ClipSettings } from "./shared";

const recorderPageRelativePath = path.join("src", "clips-recorder.html");
const recorderWindowSizePx = 320;
const audioSnapshotRequestChannel = "clips:audio-snapshot-request";
const audioSnapshotTimeoutMs = 10_000;
const audioSnapshotLeadSeconds = 2;
const thumbnailWidthPx = 480;
const thumbnailHeightPx = 270;
const thumbnailJpegQuality = 82;
const sourceGoneMessages = ["Failed to find capture source", "Failed to setup graphics capture"];

export interface ClipCaptureSessionOptions {
  audioCaptureSource: Electron.DesktopCapturerSource | null;
  bitrate: number;
  encoder: ClipVideoEncoder;
  ffmpegPath: string;
  height: number;
  preloadScriptPath: string;
  settings: ClipSettings;
  source: ResolvedClipSource;
  target: ClipCaptureTarget;
  width: number;
}

export interface ClipCaptureSessionEvents {
  ended(): void;
  failed(message: string): void;
  recorderClosed(webContentsId: number): void;
  started(): void;
}

export interface ClipCaptureSnapshot {
  audioFilePath: string | null;
  video: ClipVideoSnapshot;
}

interface PendingAudioSnapshot {
  reject(error: Error): void;
  resolve(filePath: string): void;
  timeout: ReturnType<typeof setTimeout>;
}

export class ClipCaptureSession {
  private hasStopped = false;

  private isAudioReady = false;

  private isVideoReady = false;

  private readonly pendingAudioSnapshots = new Map<string, PendingAudioSnapshot>();

  private recorder: BrowserWindow | null = null;

  private readonly video: ClipVideoCapture;

  constructor(private readonly options: ClipCaptureSessionOptions, private readonly events: ClipCaptureSessionEvents) {
    this.video = ClipVideoCapture.start({
      bitrate: options.bitrate,
      durationSeconds: options.settings.durationSeconds,
      encoder: options.encoder,
      ffmpegPath: options.ffmpegPath,
      fps: options.settings.fps,
      height: options.height,
      target: options.target,
      width: options.width
    });
    this.video.onFirstVideo((): void => {
      this.isVideoReady = true;
      this.reportStartedWhenReady();
    });
    this.video.onExit((exit): void => {
      this.handleVideoExit(exit);
    });
    this.isAudioReady = !this.hasAudio();
    if (this.hasAudio()) {
      this.openRecorder();
    }
  }

  private reportStartedWhenReady(): void {
    if (this.isAudioReady && this.isVideoReady && !this.hasStopped) {
      this.events.started();
    }
  }

  private handleVideoExit(exit: ClipVideoExit): void {
    if (this.hasStopped) {
      return;
    }

    if (exit.code === 0 || sourceGoneMessages.some((message) => exit.message.includes(message))) {
      this.events.ended();
      return;
    }

    const lastLine = exit.message.split(/\r?\n/u).findLast((line) => line.trim().length > 0);
    this.events.failed(lastLine ? `FFmpeg stopped: ${lastLine.trim()}` : "FFmpeg stopped unexpectedly.");
  }

  private openRecorder(): void {
    const recorder = new BrowserWindow({
      focusable: false,
      height: recorderWindowSizePx,
      show: false,
      skipTaskbar: true,
      width: recorderWindowSizePx,
      webPreferences: {
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        preload: this.options.preloadScriptPath
      }
    });
    const webContentsId = recorder.webContents.id;
    this.recorder = recorder;
    recorder.on("closed", (): void => {
      if (this.recorder === recorder) {
        this.recorder = null;
      }

      this.events.recorderClosed(webContentsId);
    });
    recorder.webContents.on("render-process-gone", (...eventArguments): void => {
      if (!this.hasStopped) {
        this.events.failed(`The clip audio recorder stopped unexpectedly (${eventArguments[1].reason}).`);
      }
    });
    void this.loadRecorder(recorder);
  }

  private async loadRecorder(recorder: BrowserWindow): Promise<void> {
    try {
      await recorder.loadFile(path.join(app.getAppPath(), recorderPageRelativePath));
    } catch (error) {
      if (!this.hasStopped) {
        this.events.failed(errorMessage(error));
      }
    }
  }

  private async requestAudioSnapshot(requestedAtEpochSeconds: number): Promise<string | null> {
    const { recorder } = this;
    if (!recorder) {
      return null;
    }

    const requestId = randomUUID();
    const { promise, reject, resolve } = Promise.withResolvers<string>();
    const timeout = setTimeout((): void => {
      this.pendingAudioSnapshots.delete(requestId);
      reject(new Error("The clip audio did not arrive in time."));
    }, audioSnapshotTimeoutMs);
    this.pendingAudioSnapshots.set(requestId, { reject, resolve, timeout });
    recorder.webContents.send(audioSnapshotRequestChannel, {
      fromEpochSeconds: requestedAtEpochSeconds - this.options.settings.durationSeconds - audioSnapshotLeadSeconds,
      id: requestId,
      untilEpochSeconds: requestedAtEpochSeconds
    });
    return await promise;
  }

  get clipName(): string {
    return this.options.source.clipName;
  }

  get sourceName(): string {
    return this.options.source.name;
  }

  displayMediaSource(webContentsId: number): Electron.DesktopCapturerSource | null {
    return this.recorder?.webContents.id === webContentsId ? this.options.audioCaptureSource : null;
  }

  isRecorderWindow(window: BrowserWindow | null): boolean {
    return window !== null && window === this.recorder;
  }

  recorderConfig(): ClipRecorderConfig {
    return {
      durationSeconds: this.options.settings.durationSeconds,
      microphoneDeviceId: this.options.settings.microphoneDeviceId,
      systemAudioEnabled: this.options.audioCaptureSource !== null
    };
  }

  rejectAudioSnapshot(requestId: string, message: string): void {
    const pending = this.pendingAudioSnapshots.get(requestId);
    if (!pending) {
      return;
    }

    this.pendingAudioSnapshots.delete(requestId);
    clearTimeout(pending.timeout);
    pending.reject(new Error(message));
  }

  async resolveAudioSnapshot(requestId: string, filePath: string): Promise<void> {
    const pending = this.pendingAudioSnapshots.get(requestId);
    if (!pending) {
      await rm(filePath, { force: true });
      return;
    }

    this.pendingAudioSnapshots.delete(requestId);
    clearTimeout(pending.timeout);
    pending.resolve(filePath);
  }

  async snapshot(requestedAtEpochSeconds: number): Promise<ClipCaptureSnapshot> {
    const [audioResult, videoResult] = await Promise.allSettled([
      this.requestAudioSnapshot(requestedAtEpochSeconds),
      this.video.snapshot(requestedAtEpochSeconds)
    ]);
    if (videoResult.status === "rejected") {
      if (audioResult.status === "fulfilled" && audioResult.value !== null) {
        await rm(audioResult.value, { force: true });
      }

      throw videoResult.reason;
    }

    if (audioResult.status === "rejected") {
      throw audioResult.reason;
    }

    return { audioFilePath: audioResult.value, video: videoResult.value };
  }

  handleRecorderStarted(): void {
    this.isAudioReady = true;
    this.reportStartedWhenReady();
  }

  hasAudio(): boolean {
    return this.options.audioCaptureSource !== null || this.options.settings.microphoneDeviceId !== null;
  }

  stop(): void {
    this.hasStopped = true;
    this.video.stop();
    for (const [requestId, pending] of this.pendingAudioSnapshots) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Clips stopped before the clip was saved."));
      this.pendingAudioSnapshots.delete(requestId);
    }

    const { recorder } = this;
    this.recorder = null;
    if (recorder && !recorder.isDestroyed()) {
      recorder.destroy();
    }
  }

  async thumbnail(): Promise<Buffer> {
    const sources = await desktopCapturer.getSources({
      fetchWindowIcons: false,
      thumbnailSize: { height: thumbnailHeightPx, width: thumbnailWidthPx },
      types: [this.options.source.display ? "screen" : "window"]
    });
    const source = sources.find((candidate) => candidate.id === this.options.source.source.id);
    if (!source || source.thumbnail.isEmpty()) {
      throw new Error("Could not capture the clip thumbnail.");
    }

    return source.thumbnail.toJPEG(thumbnailJpegQuality);
  }
}
