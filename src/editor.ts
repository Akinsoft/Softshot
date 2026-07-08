import { exportTrimmedVideo, type TrimRange } from "./editor-export.js";
import { getRequiredElement } from "./overlay-dom.js";
import type { EditorBootstrap, PreparedVideoFile, SoftshotApi, VideoFps } from "./shared.js";
import { videoFpsOptions } from "./shared.js";

const defaultMimeType = "video/webm";
const minimumTrimDurationSeconds = 0.05;
const prepareDebounceMs = 350;
const rangeStepSeconds = 0.01;
const secondsPerMinute = 60;
const secondsTextLength = 5;
const spaceKey = " ";
const timePartLength = 2;
const timePrecisionDigits = 2;
const trimKeyPrecisionDigits = 3;
const timelinePercent = 100;
const trimToleranceSeconds = 0.04;
const transientStatusDurationMs = 1400;
const zeroSeconds = 0;
const noPointerId = -1;

type SoftshotGlobal = typeof globalThis & {
  softshot: SoftshotApi;
};

interface PreparedVideo {
  filePath: string;
  key: string;
}

interface PendingPreparation {
  key: string;
  promise: Promise<PreparedVideo>;
}

interface PreparationFailure {
  error: unknown;
  key: string;
}

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
  private readonly timelineTrack = getRequiredElement("timeline-track", HTMLDivElement);
  private readonly totalTimeText = getRequiredElement("total-time", HTMLSpanElement);
  private readonly video = getRequiredElement("editor-video", HTMLVideoElement);
  private activeTimelinePointerId = noPointerId;
  private bytes = new Uint8Array();
  private durationSeconds = zeroSeconds;
  private fps: VideoFps = videoFpsOptions.high;
  private isBusy = false;
  private mimeType = defaultMimeType;
  private objectUrl: string | null = null;
  private pendingPreparation: PendingPreparation | null = null;
  private playbackFrameHandle: number | null = null;
  private preparationFailure: PreparationFailure | null = null;
  private preparationHandle: ReturnType<typeof setTimeout> | null = null;
  private preparationRunId = 0;
  private preparedVideo: PreparedVideo | null = null;
  private statusHandle: ReturnType<typeof setTimeout> | null = null;
  private trimEndSeconds = zeroSeconds;
  private trimStartSeconds = zeroSeconds;

  private bindEvents(): void {
    this.bindKeyboardEvents();
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
    this.timelineTrack.addEventListener("pointerdown", (event): void => {
      this.beginTimelineScrub(event);
    });
    this.timelineTrack.addEventListener("pointermove", (event): void => {
      this.updateTimelineScrub(event);
    });
    this.timelineTrack.addEventListener("pointerup", (event): void => {
      this.endTimelineScrub(event);
    });
    this.timelineTrack.addEventListener("pointercancel", (event): void => {
      this.endTimelineScrub(event);
    });
    this.video.addEventListener("timeupdate", (): void => {
      this.syncPlaybackTime();
    });
    this.video.addEventListener("pause", (): void => {
      this.stopPlaybackFrameSync();
      this.syncPlayButton();
    });
    this.video.addEventListener("play", (): void => {
      this.startPlaybackFrameSync();
      this.syncPlayButton();
    });
  }

  private bindKeyboardEvents(): void {
    addEventListener("keydown", (event): void => {
      if (event.key !== spaceKey) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      this.blurFocusedElement();

      if (!event.repeat) {
        this.runAsync(this.togglePlayback(), "Could not preview the recording.");
      }
    }, { capture: true });
  }

  private blurFocusedElement(): void {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
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
    this.clearPreparationTimer();
    this.stopPlaybackFrameSync();
    this.releaseObjectUrl();
    await getSoftshotApi().closeEditor();
  }

  private beginTimelineScrub(event: PointerEvent): void {
    if (this.isBusy) {
      return;
    }

    this.activeTimelinePointerId = event.pointerId;
    this.timelineTrack.setPointerCapture(event.pointerId);
    this.seekToTimelinePoint(event.clientX);
    event.preventDefault();
  }

  private clearPreparationTimer(): void {
    if (this.preparationHandle === null) {
      return;
    }

    clearTimeout(this.preparationHandle);
    this.preparationHandle = null;
  }

  private clearPendingPreparation(promise: Promise<PreparedVideo>): void {
    if (this.pendingPreparation?.promise === promise) {
      this.pendingPreparation = null;
    }
  }

  private clampedPlaybackTime(value: number): number {
    return clamp(value, this.trimStartSeconds, this.trimEndSeconds);
  }

  private async copyVideo(): Promise<void> {
    const preparedVideo = await this.preparedVideoForCurrentTrim(true);
    await getSoftshotApi().copyPreparedEditorVideo(preparedVideo.filePath);
    this.showStatus("Copied");
  }

  private async createPreparedVideo(key: string, trimRange: TrimRange): Promise<PreparedVideo> {
    const outputBytes = await this.exportVideoForTrimRange(trimRange);
    if (outputBytes.byteLength === 0) {
      throw new Error("Cannot prepare an empty recording.");
    }

    const preparedFile = await getSoftshotApi().prepareEditorVideoFile(outputBytes);
    return preparedVideoFromFile(key, preparedFile);
  }

  private endTimelineScrub(event: PointerEvent): void {
    if (this.activeTimelinePointerId !== event.pointerId) {
      return;
    }

    this.activeTimelinePointerId = noPointerId;
    if (this.timelineTrack.hasPointerCapture(event.pointerId)) {
      this.timelineTrack.releasePointerCapture(event.pointerId);
    }
  }

  private async exportVideoForTrimRange(trimRange: TrimRange): Promise<Uint8Array> {
    if (this.isFullTrimRange(trimRange)) {
      return this.bytes;
    }

    return await exportTrimmedVideo(this.bytes, this.mimeType, this.fps, this.durationSeconds, trimRange);
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

  private async prepareVideo(key: string, trimRange: TrimRange): Promise<PreparedVideo> {
    this.preparationFailure = null;
    const runId = this.preparationRunId + 1;
    this.preparationRunId = runId;
    const promise = this.createPreparedVideo(key, trimRange);
    this.pendingPreparation = { key, promise };

    try {
      const preparedVideo = await promise;
      if (runId === this.preparationRunId && key === this.trimKey()) {
        this.preparedVideo = preparedVideo;
      }

      return preparedVideo;
    } finally {
      this.clearPendingPreparation(promise);
    }
  }

  private async preparedVideoForCurrentTrim(shouldShowBusy: boolean): Promise<PreparedVideo> {
    const key = this.trimKey();
    if (this.preparedVideo?.key === key) {
      return this.preparedVideo;
    }

    if (this.preparationFailure?.key === key) {
      this.preparationFailure = null;
    }

    if (shouldShowBusy) {
      this.setBusy(true);
    }

    try {
      if (this.pendingPreparation?.key === key) {
        return await this.pendingPreparation.promise;
      }

      return await this.prepareVideo(key, this.trimRange());
    } finally {
      if (shouldShowBusy) {
        this.setBusy(false);
      }
    }
  }

  private async reportError(message: string, error: unknown): Promise<void> {
    const detail = error instanceof Error ? `${message}\n\n${error.message}` : message;
    await getSoftshotApi().showError(detail);
  }

  private async saveVideo(): Promise<void> {
    const result = await getSoftshotApi().chooseEditorVideoSavePath();
    if (!result.filePath) {
      return;
    }

    const preparedVideo = await this.preparedVideoForCurrentTrim(true);
    await getSoftshotApi().savePreparedEditorVideo(preparedVideo.filePath, result.filePath);
    this.showStatus("Saved");
  }

  private seekTo(value: number): void {
    this.video.currentTime = this.clampedPlaybackTime(value);
    this.syncPlaybackTime();
  }

  private seekToTimelinePoint(clientX: number): void {
    const rect = this.timelineTrack.getBoundingClientRect();
    const progress = clamp((clientX - rect.left) / rect.width, zeroSeconds, 1);
    this.seekTo(progress * this.durationSeconds);
  }

  private schedulePreparedVideoRefresh(): void {
    this.clearPreparationTimer();
    this.preparationHandle = setTimeout((): void => {
      this.preparationHandle = null;
      this.startBackgroundPreparation(this.trimKey(), this.trimRange());
    }, prepareDebounceMs);
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
    const currentTime = this.clampedPlaybackTime(this.video.currentTime);
    if (currentTime !== this.video.currentTime) {
      this.video.currentTime = currentTime;
    }

    if (!this.video.paused && currentTime >= this.trimEndSeconds) {
      this.video.pause();
    }

    this.currentTimeText.textContent = formatTime(currentTime);
    this.timeline.style.setProperty("--playhead", `${String(percentOf(currentTime, this.durationSeconds))}%`);
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

  private startBackgroundPreparation(key: string, trimRange: TrimRange): void {
    void this.prepareVideo(key, trimRange).catch((error: unknown): void => {
      if (key === this.trimKey()) {
        this.preparationFailure = { error, key };
      }
    });
  }

  private startPlaybackFrameSync(): void {
    if (this.playbackFrameHandle !== null) {
      return;
    }

    const syncFrame = (): void => {
      this.syncPlaybackTime();
      if (this.video.paused) {
        this.playbackFrameHandle = null;
        return;
      }

      this.playbackFrameHandle = requestAnimationFrame(syncFrame);
    };

    this.playbackFrameHandle = requestAnimationFrame(syncFrame);
  }

  private stopPlaybackFrameSync(): void {
    if (this.playbackFrameHandle === null) {
      return;
    }

    cancelAnimationFrame(this.playbackFrameHandle);
    this.playbackFrameHandle = null;
    this.syncPlaybackTime();
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

  private updateTimelineScrub(event: PointerEvent): void {
    if (this.activeTimelinePointerId !== event.pointerId) {
      return;
    }

    this.seekToTimelinePoint(event.clientX);
  }

  private isFullTrimRange(trimRange: TrimRange): boolean {
    return trimRange.start <= trimToleranceSeconds
      && Math.abs(trimRange.end - this.durationSeconds) <= trimToleranceSeconds;
  }

  private trimRange(): TrimRange {
    return {
      end: this.trimEndSeconds,
      start: this.trimStartSeconds
    };
  }

  private trimKey(): string {
    return trimKeyFromRange(this.trimRange());
  }

  private updateTrimEnd(value: number): void {
    const minimumDuration = Math.min(minimumTrimDurationSeconds, this.durationSeconds);
    this.trimEndSeconds = clamp(value, this.trimStartSeconds + minimumDuration, this.durationSeconds);

    this.syncTimeline();
    this.seekTo(this.video.currentTime);
    this.schedulePreparedVideoRefresh();
  }

  private updateTrimStart(value: number): void {
    const minimumDuration = Math.min(minimumTrimDurationSeconds, this.durationSeconds);
    this.trimStartSeconds = clamp(value, zeroSeconds, this.trimEndSeconds - minimumDuration);

    this.syncTimeline();
    this.seekTo(this.video.currentTime);
    this.schedulePreparedVideoRefresh();
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
      this.schedulePreparedVideoRefresh();
    } catch (error) {
      await this.reportError("Could not open the editor.", error);
      await this.closeEditor();
    }
  }
}

function preparedVideoFromFile(key: string, file: PreparedVideoFile): PreparedVideo {
  return {
    filePath: file.filePath,
    key
  };
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

function trimKeyFromRange(trimRange: TrimRange): string {
  return `${trimRange.start.toFixed(trimKeyPrecisionDigits)}:${trimRange.end.toFixed(trimKeyPrecisionDigits)}`;
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
