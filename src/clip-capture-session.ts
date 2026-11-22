import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { app, BrowserWindow } from "electron";

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
import { runWindowsCommand } from "./windows-command";

const recorderPageRelativePath = path.join("src", "clips-recorder.html");
const recorderWindowSizePx = 320;
const audioSnapshotRequestChannel = "clips:audio-snapshot-request";
const audioSnapshotTimeoutMs = 10_000;
const audioSnapshotLeadSeconds = 2;
const thumbnailWidthPx = 480;
const thumbnailHeightPx = 270;
const thumbnailJpegQuality = "3";
const thumbnailSeekFromEndSeconds = "-1";
const ffmpegLogContextPattern = /^\[[^\]]*\]\s*/u;

export interface ClipCaptureSessionOptions {
  audioCaptureSource: Electron.DesktopCapturerSource | null;
  bitrate: number;
  encoder: ClipVideoEncoder;
  ffmpegPath: string;
  height: number;
  microphoneDeviceId: string | null;
  preloadScriptPath: string;
  settings: ClipSettings;
  source: ResolvedClipSource;
  target: ClipCaptureTarget;
  width: number;
}

interface ClipCaptureSessionEvents {
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

  private isRecorderReady = false;

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
    this.video.onExit((exit): void => {
      this.handleVideoExit(exit);
    });
    if (this.hasAudio()) {
      this.openRecorder();
    }
  }

  private handleVideoExit(exit: ClipVideoExit): void {
    if (this.hasStopped) {
      return;
    }

    if (exit.code === 0) {
      this.events.ended();
      return;
    }

    const firstLine = exit.message
      .split(/\r?\n/u)
      .map((line) => line.replace(ffmpegLogContextPattern, "").trim())
      .find((line) => line.length > 0);
    this.events.failed(firstLine ? `FFmpeg stopped: ${firstLine}` : "FFmpeg stopped unexpectedly.");
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
      microphoneDeviceId: this.options.microphoneDeviceId,
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
    if (this.isRecorderReady || this.hasStopped) {
      return;
    }

    this.isRecorderReady = true;
    this.events.started();
  }

  isReady(): boolean {
    return this.isRecorderReady || !this.hasAudio();
  }

  hasAudio(): boolean {
    return this.options.audioCaptureSource !== null || this.options.microphoneDeviceId !== null;
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

  async thumbnail(videoFilePath: string): Promise<Buffer> {
    const thumbnailFilePath = path.join(os.tmpdir(), `softshot-clip-thumbnail-${randomUUID()}.jpg`);
    try {
      await runWindowsCommand(this.options.ffmpegPath, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-noaccurate_seek",
        "-sseof",
        thumbnailSeekFromEndSeconds,
        "-i",
        videoFilePath,
        "-an",
        "-vf",
        `scale=${String(thumbnailWidthPx)}:${String(thumbnailHeightPx)}:force_original_aspect_ratio=decrease:out_range=full`,
        "-c:v",
        "mjpeg",
        "-q:v",
        thumbnailJpegQuality,
        "-update",
        "1",
        "-y",
        thumbnailFilePath
      ], "Could not create the clip thumbnail.");
      return await readFile(thumbnailFilePath);
    } finally {
      await rm(thumbnailFilePath, { force: true });
    }
  }
}
