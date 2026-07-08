import { exportTrimmedVideo, type TrimRange } from "./editor-export.js";
import { getRequiredElement } from "./overlay-dom.js";
import type { EditorBootstrap, SoftshotApi, VideoFps } from "./shared.js";
import { videoFpsOptions } from "./shared.js";

const defaultMimeType = "video/webm";
const minimumTrimDurationSeconds = 0.05;
const rangeStepSeconds = 0.01;
const secondsPerMinute = 60;
const secondsTextLength = 5;
const timePartLength = 2;
const timePrecisionDigits = 2;
const timelinePercent = 100;
const trimToleranceSeconds = 0.04;
const transientStatusDurationMs = 1400;
const zeroSeconds = 0;

type SoftshotGlobal = typeof globalThis & {
  softshot: SoftshotApi;
};

class VideoEditorApp {
  private readonly closeButton = getRequiredElement("editor-close-button", HTMLButtonElement);
  private readonly copyButton = getRequiredElement("editor-copy-button", HTMLButtonElement);
  private readonly currentTimeText = getRequiredElement("current-time", HTMLSpanElement);
  private readonly endRange = getRequiredElement("trim-end", HTMLInputElement);
  private readonly playButton = getRequiredElement("play-button", HTMLButtonElement);
  private readonly saveButton = getRequiredElement("editor-save-button", HTMLButtonElement);
  private readonly startRange = getRequiredElement("trim-start", HTMLInputElement);
  private readonly statusText = getRequiredElement("editor-status", HTMLSpanElement);
  private readonly timeline = getRequiredElement("timeline", HTMLDivElement);
  private readonly totalTimeText = getRequiredElement("total-time", HTMLSpanElement);
  private readonly video = getRequiredElement("editor-video", HTMLVideoElement);
  private bytes = new Uint8Array();
  private durationSeconds = zeroSeconds;
  private fps: VideoFps = videoFpsOptions.high;
  private isBusy = false;
  private mimeType = defaultMimeType;
  private objectUrl: string | null = null;
  private statusHandle: ReturnType<typeof setTimeout> | null = null;
  private trimEndSeconds = zeroSeconds;
  private trimStartSeconds = zeroSeconds;

  private bindEvents(): void {
    this.closeButton.addEventListener("click", (): void => {
      this.runAsync(this.closeEditor(), "Could not close the editor.");
    });
    this.copyButton.addEventListener("click", (): void => {
      this.runAsync(this.copyVideo(), "Could not copy the recording.");
    });
    this.saveButton.addEventListener("click", (): void => {
      this.runAsync(this.saveVideo(), "Could not save the recording.");
    });
    this.playButton.addEventListener("click", (): void => {
      this.runAsync(this.togglePlayback(), "Could not preview the recording.");
    });
    this.startRange.addEventListener("input", (): void => {
      this.updateTrimStart(Number(this.startRange.value));
    });
    this.endRange.addEventListener("input", (): void => {
      this.updateTrimEnd(Number(this.endRange.value));
    });
    this.video.addEventListener("timeupdate", (): void => {
      this.syncPlaybackTime();
    });
    this.video.addEventListener("pause", (): void => {
      this.syncPlayButton();
    });
    this.video.addEventListener("play", (): void => {
      this.syncPlayButton();
    });
  }

  private async reportAsyncError(task: Promise<void>, message: string): Promise<void> {
    try {
      await task;
    } catch (error) {
      await this.reportError(message, error);
    }
  }

  private runAsync(task: Promise<void>, message: string): void {
    void this.reportAsyncError(task, message);
  }

  private async closeEditor(): Promise<void> {
    this.releaseObjectUrl();
    await getSoftshotApi().closeEditor();
  }

  private async copyVideo(): Promise<void> {
    const outputBytes = await this.exportCurrentVideo();
    if (outputBytes.byteLength === 0) {
      return;
    }

    await getSoftshotApi().copyEditorVideo(outputBytes);
    this.showStatus("Copied");
  }

  private async exportCurrentVideo(): Promise<Uint8Array> {
    if (this.isFullTrimRange()) {
      return this.bytes;
    }

    this.setBusy(true);
    try {
      return await exportTrimmedVideo(this.bytes, this.mimeType, this.fps, this.durationSeconds, this.trimRange());
    } finally {
      this.setBusy(false);
    }
  }

  private loadRecording(bootstrap: EditorBootstrap): void {
    this.bytes = new Uint8Array(bootstrap.bytes);
    this.durationSeconds = positiveDuration(bootstrap.durationSeconds);
    this.fps = bootstrap.fps;
    this.mimeType = bootstrap.mimeType;
    this.objectUrl = URL.createObjectURL(new Blob([this.bytes], { type: this.mimeType }));
    this.video.src = this.objectUrl;
  }

  private releaseObjectUrl(): void {
    if (!this.objectUrl) {
      return;
    }

    URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
  }

  private async reportError(message: string, error: unknown): Promise<void> {
    const detail = error instanceof Error ? `${message}\n\n${error.message}` : message;
    await getSoftshotApi().showError(detail);
  }

  private async saveVideo(): Promise<void> {
    const outputBytes = await this.exportCurrentVideo();
    if (outputBytes.byteLength === 0) {
      return;
    }

    const result = await getSoftshotApi().saveEditorVideo(outputBytes);
    if (result.filePath) {
      this.showStatus("Saved");
    }
  }

  private setBusy(isBusy: boolean): void {
    this.isBusy = isBusy;
    document.body.classList.toggle("busy", isBusy);
    this.copyButton.disabled = isBusy;
    this.saveButton.disabled = isBusy;
    this.startRange.disabled = isBusy;
    this.endRange.disabled = isBusy;
    this.playButton.disabled = isBusy;
  }

  private showStatus(message: string): void {
    if (this.statusHandle !== null) {
      clearTimeout(this.statusHandle);
    }

    this.statusText.textContent = message;
    this.statusHandle = setTimeout((): void => {
      this.statusText.textContent = "";
      this.statusHandle = null;
    }, transientStatusDurationMs);
  }

  private syncPlayButton(): void {
    this.playButton.dataset.state = this.video.paused ? "play" : "pause";
    this.playButton.setAttribute("aria-label", this.video.paused ? "Play" : "Pause");
    this.playButton.title = this.video.paused ? "Play" : "Pause";
  }

  private syncPlaybackTime(): void {
    if (this.video.currentTime >= this.trimEndSeconds) {
      this.video.pause();
      this.video.currentTime = this.trimEndSeconds;
    }

    this.currentTimeText.textContent = formatTime(this.video.currentTime);
    this.syncPlayButton();
  }

  private syncTimeline(): void {
    this.startRange.max = String(this.durationSeconds);
    this.endRange.max = String(this.durationSeconds);
    this.startRange.step = String(rangeStepSeconds);
    this.endRange.step = String(rangeStepSeconds);
    this.startRange.value = String(this.trimStartSeconds);
    this.endRange.value = String(this.trimEndSeconds);

    const startPercent = percentOf(this.trimStartSeconds, this.durationSeconds);
    const endPercent = percentOf(this.trimEndSeconds, this.durationSeconds);
    this.timeline.style.setProperty("--trim-start", `${String(startPercent)}%`);
    this.timeline.style.setProperty("--trim-end", `${String(endPercent)}%`);
  }

  private async togglePlayback(): Promise<void> {
    if (this.isBusy) {
      return;
    }

    if (!this.video.paused) {
      this.video.pause();
      return;
    }

    if (this.video.currentTime < this.trimStartSeconds || this.video.currentTime >= this.trimEndSeconds) {
      this.video.currentTime = this.trimStartSeconds;
    }

    await this.video.play();
  }

  private isFullTrimRange(): boolean {
    return this.trimStartSeconds <= trimToleranceSeconds
      && Math.abs(this.trimEndSeconds - this.durationSeconds) <= trimToleranceSeconds;
  }

  private trimRange(): TrimRange {
    return {
      end: this.trimEndSeconds,
      start: this.trimStartSeconds
    };
  }

  private updateTrimEnd(value: number): void {
    const minimumDuration = Math.min(minimumTrimDurationSeconds, this.durationSeconds);
    this.trimEndSeconds = clamp(value, this.trimStartSeconds + minimumDuration, this.durationSeconds);

    if (this.video.currentTime > this.trimEndSeconds) {
      this.video.currentTime = this.trimEndSeconds;
    }

    this.syncTimeline();
    this.syncPlaybackTime();
  }

  private updateTrimStart(value: number): void {
    const minimumDuration = Math.min(minimumTrimDurationSeconds, this.durationSeconds);
    this.trimStartSeconds = clamp(value, zeroSeconds, this.trimEndSeconds - minimumDuration);

    if (this.video.currentTime < this.trimStartSeconds) {
      this.video.currentTime = this.trimStartSeconds;
    }

    this.syncTimeline();
    this.syncPlaybackTime();
  }

  async initialize(): Promise<void> {
    try {
      this.bindEvents();
      const bootstrap = await getSoftshotApi().getEditorBootstrap();
      this.loadRecording(bootstrap);
      await waitForVideoMetadata(this.video);
      this.trimEndSeconds = this.durationSeconds;
      this.totalTimeText.textContent = formatTime(this.durationSeconds);
      this.syncTimeline();
      this.syncPlaybackTime();
    } catch (error) {
      await this.reportError("Could not open the editor.", error);
      await this.closeEditor();
    }
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function formatTime(value: number): string {
  const safeValue = Math.max(zeroSeconds, value);
  const minutes = Math.floor(safeValue / secondsPerMinute);
  const seconds = safeValue % secondsPerMinute;
  return `${String(minutes).padStart(timePartLength, "0")}:${seconds.toFixed(timePrecisionDigits).padStart(secondsTextLength, "0")}`;
}

function getSoftshotApi(): SoftshotApi {
  return (globalThis as SoftshotGlobal).softshot;
}

function percentOf(value: number, total: number): number {
  if (total <= zeroSeconds) {
    return zeroSeconds;
  }

  return (value / total) * timelinePercent;
}

function positiveDuration(value: number): number {
  if (!Number.isFinite(value) || value <= zeroSeconds) {
    throw new Error("The recording has no usable duration.");
  }

  return value;
}

async function waitForVideoMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
    return;
  }

  await new Promise<void>((resolve) => {
    video.addEventListener("loadedmetadata", () => {
      resolve();
    }, { once: true });
  });
}

const editorApp = new VideoEditorApp();
await editorApp.initialize();
