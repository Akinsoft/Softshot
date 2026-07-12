import { audioAnalyzerFftSize, audioLevelFromTimeDomainSamples } from "./audio-level.js";
import { audioMixGain, recordingAudioSampleRate } from "./audio-quality.js";
import { type ExportAudioTrack, type ExportedVideo, exportTrimmedVideo, type TrimRange } from "./editor-export.js";
import { playMedia, waitForMediaMetadata } from "./media-element.js";
import { getRequiredElement } from "./overlay-dom.js";
import type { AudioSourceKind, EditorAudioTrack, EditorBootstrap, PreparedVideoFile, VideoFps } from "./shared.js";
import { videoFpsOptions } from "./shared.js";
import { getSoftshotApi } from "./softshot-api.js";
import { setTooltipLabel, TooltipController } from "./ui-tooltip.js";

const defaultMimeType = "video/webm";
const audioLevelCssProperty = "--audio-level";
const minimumTrimDurationSeconds = 0.05;
const rangeStepSeconds = 0.01;
const halfDivisor = 2;
const fullTrimToleranceSeconds = rangeStepSeconds / halfDivisor;
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

interface PreparedVideo {
  filePath: string;
  key: string;
}

interface AudioMeter {
  analyser: AnalyserNode;
  data: Uint8Array<ArrayBuffer>;
  gain: GainNode;
  row: HTMLElement | null;
  source: MediaElementAudioSourceNode;
}

class VideoEditorApp {
  private readonly closeButton = getRequiredElement("editor-close-button", HTMLButtonElement);
  private readonly copyButton = getRequiredElement("editor-copy-button", HTMLButtonElement);
  private readonly currentTimeText = getRequiredElement("current-time", HTMLSpanElement);
  private readonly audioTracksElement = getRequiredElement("audio-tracks", HTMLElement);
  private readonly endRange = getRequiredElement("trim-end", HTMLInputElement);
  private readonly playButton = getRequiredElement("play-button", HTMLButtonElement);
  private readonly saveButton = getRequiredElement("editor-save-button", HTMLButtonElement);
  private readonly startRange = getRequiredElement("trim-start", HTMLInputElement);
  private readonly statusText = getRequiredElement("editor-status", HTMLSpanElement);
  private readonly timeline = getRequiredElement("timeline", HTMLDivElement);
  private readonly timelineTrack = getRequiredElement("timeline-track", HTMLDivElement);
  private readonly totalTimeText = getRequiredElement("total-time", HTMLSpanElement);
  private readonly tooltips = new TooltipController(document.body);
  private readonly video = getRequiredElement("editor-video", HTMLVideoElement);
  private activeTimelinePointerId = noPointerId;
  private audioMeterFrame: number | null = null;
  private audioPreviewContext: AudioContext | null = null;
  private audioReady: Promise<void> = Promise.resolve();
  private audioTracks: EditorAudioTrack[] = [];
  private readonly audioElementsByKind = new Map<AudioSourceKind, HTMLAudioElement>();
  private readonly audioMetersByKind = new Map<AudioSourceKind, AudioMeter>();
  private durationSeconds = zeroSeconds;
  private fps: VideoFps = videoFpsOptions.high;
  private isBusy = false;
  private isClosing = false;
  private mimeType = defaultMimeType;
  private playbackFrameHandle: number | null = null;
  private preparedVideo: PreparedVideo | null = null;
  private sourceFilePath = "";
  private sourceUrl = "";
  private statusHandle: ReturnType<typeof setTimeout> | null = null;
  private trimEndSeconds = zeroSeconds;
  private trimStartSeconds = zeroSeconds;
  private readonly mutedAudioKinds = new Set<AudioSourceKind>();

  private bindEvents(): void {
    this.tooltips.bind();
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
    this.audioTracksElement.addEventListener("click", (event): void => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-audio-kind]");
      if (!button) {
        return;
      }

      this.toggleAudioTrackMute(audioSourceKindFromString(button.dataset.audioKind));
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
      this.pauseAudioPreview();
      this.stopPlaybackFrameSync();
      this.syncPlayButton();
    });
    this.video.addEventListener("play", (): void => {
      this.startPlaybackFrameSync();
      this.startAudioMeterLoop();
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
    if (this.isBusy || this.isClosing) {
      return;
    }

    this.isClosing = true;
    try {
      try {
        await this.disposeAudioPreview();
      } finally {
        this.stopPlaybackFrameSync();
        await getSoftshotApi().closeEditor();
      }
    } finally {
      this.isClosing = false;
    }
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

  private clampedPlaybackTime(value: number): number {
    return clamp(value, this.trimStartSeconds, this.trimEndSeconds);
  }

  private async copyVideo(): Promise<void> {
    if (this.isBusy) {
      return;
    }

    this.setBusy(true);
    try {
      const preparedVideo = await this.preparedVideoForCurrentTrim();
      await getSoftshotApi().copyPreparedEditorVideo(preparedVideo.filePath);
      this.showStatus("Copied");
    } finally {
      this.setBusy(false);
    }
  }

  private async createPreparedVideo(key: string, trimRange: TrimRange): Promise<PreparedVideo> {
    if (this.mutedAudioKinds.size === 0 && trimRange.start <= fullTrimToleranceSeconds) {
      if (this.isFullTrimRange(trimRange)) {
        return {
          filePath: this.sourceFilePath,
          key
        };
      }

      const trimmedFile = await getSoftshotApi().trimEditorVideoEnd(trimRange.end);
      return preparedVideoFromFile(key, trimmedFile);
    }

    const exportedVideo = await this.exportVideoForTrimRange(trimRange);
    const preparedFile = await getSoftshotApi().completeEditorVideoFile(
      exportedVideo.recordingId,
      exportedVideo.mimeType
    );
    return preparedVideoFromFile(key, preparedFile);
  }

  private audioTracksForExport(): ExportAudioTrack[] {
    return this.audioTracks
      .filter((audioTrack) => !this.mutedAudioKinds.has(audioTrack.kind))
      .map((audioTrack) => ({
        sourceUrl: audioTrack.sourceUrl
      }));
  }

  private createAudioPreviewElements(): void {
    this.audioElementsByKind.clear();
    this.audioMetersByKind.clear();
    this.audioPreviewContext = this.audioTracks.length > 0
      ? new AudioContext({ sampleRate: recordingAudioSampleRate })
      : null;
    const audioReadyPromises = this.audioTracks.map(async (audioTrack): Promise<void> => {
      const audio = new Audio();
      audio.preload = "auto";
      audio.src = audioTrack.sourceUrl;
      this.audioElementsByKind.set(audioTrack.kind, audio);
      this.audioMetersByKind.set(audioTrack.kind, this.createAudioMeter(audio));
      await waitForMediaMetadata(audio);
    });
    this.syncAudioMuteStates();
    this.audioReady = waitForAudioReady(audioReadyPromises);
  }

  private createAudioMeter(audio: HTMLAudioElement): AudioMeter {
    const context = this.audioPreviewContext;
    if (!context) {
      throw new Error("Audio preview context is unavailable.");
    }

    const source = context.createMediaElementSource(audio);
    const analyser = context.createAnalyser();
    const gain = context.createGain();
    analyser.fftSize = audioAnalyzerFftSize;
    gain.gain.value = 0;
    source.connect(analyser);
    analyser.connect(gain);
    gain.connect(context.destination);
    return {
      analyser,
      data: new Uint8Array(analyser.fftSize),
      gain,
      row: null,
      source
    };
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

  private async exportVideoForTrimRange(trimRange: TrimRange): Promise<ExportedVideo> {
    return await exportTrimmedVideo(this.sourceUrl, this.mimeType, this.fps, trimRange, this.audioTracksForExport());
  }

  private loadRecording(bootstrap: EditorBootstrap): void {
    this.audioTracks = bootstrap.audioTracks;
    this.durationSeconds = positiveDuration(bootstrap.durationSeconds);
    this.fps = bootstrap.fps;
    this.mimeType = bootstrap.mimeType;
    this.sourceFilePath = bootstrap.sourceFilePath;
    this.sourceUrl = bootstrap.sourceUrl;
    this.video.muted = this.audioTracks.length > 0;
    this.video.src = this.sourceUrl;
    this.createAudioPreviewElements();
    this.renderAudioTracks();
    const encoderLabel = bootstrap.encoder === "hardware" ? "Hardware encoded" : "Compatibility encoding";
    const pipelineLabel = bootstrap.capturePipeline === "direct" ? "Direct capture" : "Composited capture";
    this.showStatus(`${encoderLabel} · ${pipelineLabel}`);
  }

  private async preparedVideoForCurrentTrim(): Promise<PreparedVideo> {
    const key = this.trimKey();
    if (this.preparedVideo?.key === key) {
      return this.preparedVideo;
    }

    const preparedVideo = await this.createPreparedVideo(key, this.trimRange());
    if (key === this.trimKey()) {
      this.preparedVideo = preparedVideo;
    }

    return preparedVideo;
  }

  private async reportError(message: string, error: unknown): Promise<void> {
    const detail = error instanceof Error ? `${message}\n\n${error.message}` : message;
    await getSoftshotApi().showError(detail);
  }

  private renderAudioTracks(): void {
    this.audioTracksElement.hidden = this.audioTracks.length === 0;
    this.audioTracksElement.replaceChildren(...this.audioTracks.map((audioTrack) => this.audioTrackElement(audioTrack)));
  }

  private audioTrackElement(audioTrack: EditorAudioTrack): HTMLElement {
    const row = document.createElement("div");
    row.className = "audio-track";
    row.classList.toggle("muted", this.mutedAudioKinds.has(audioTrack.kind));
    row.style.setProperty(audioLevelCssProperty, "0");
    this.assignAudioMeterRow(audioTrack.kind, row);

    const icon = document.createElement("span");
    const label = audioTrackLabel(audioTrack.kind);
    icon.className = "audio-track-icon";
    setTooltipLabel(icon, label);
    icon.innerHTML = audioTrackIcon(audioTrack.kind);

    const line = document.createElement("span");
    line.className = "audio-track-line";

    row.append(icon, line, this.audioTrackMuteButton(audioTrack.kind));
    return row;
  }

  private assignAudioMeterRow(kind: AudioSourceKind, row: HTMLElement): void {
    const meter = this.audioMetersByKind.get(kind);
    if (meter) {
      meter.row = row;
    }
  }

  private audioTrackMuteButton(kind: AudioSourceKind): HTMLButtonElement {
    const isMuted = this.mutedAudioKinds.has(kind);
    const button = document.createElement("button");
    button.className = "audio-track-mute";
    button.type = "button";
    button.dataset.audioKind = kind;
    setTooltipLabel(button, isMuted ? `Unmute ${audioTrackLabel(kind)}` : `Mute ${audioTrackLabel(kind)}`);
    button.innerHTML = audioTrackMuteIcon(isMuted);
    return button;
  }

  private async saveVideo(): Promise<void> {
    if (this.isBusy) {
      return;
    }

    this.setBusy(true);
    try {
      const result = await getSoftshotApi().chooseEditorVideoSavePath();
      if (!result.filePath) {
        return;
      }

      const preparedVideo = await this.preparedVideoForCurrentTrim();
      await getSoftshotApi().savePreparedEditorVideo(preparedVideo.filePath, result.filePath);
      this.showStatus("Saved");
    } finally {
      this.setBusy(false);
    }
  }

  private seekTo(value: number): void {
    const currentTime = this.clampedPlaybackTime(value);
    this.video.currentTime = currentTime;
    this.syncAudioPreviewTime(currentTime);
    this.syncPlaybackTime();
  }

  private seekToTimelinePoint(clientX: number): void {
    const rect = this.timelineTrack.getBoundingClientRect();
    const progress = clamp((clientX - rect.left) / rect.width, zeroSeconds, 1);
    this.seekTo(progress * this.durationSeconds);
  }

  private setBusy(isBusy: boolean): void {
    this.isBusy = isBusy;
    document.body.classList.toggle("busy", isBusy);
    this.copyButton.disabled = isBusy;
    this.closeButton.disabled = isBusy;
    this.saveButton.disabled = isBusy;
    this.startRange.disabled = isBusy;
    this.endRange.disabled = isBusy;
    this.playButton.disabled = isBusy;
    for (const button of this.audioTracksElement.querySelectorAll<HTMLButtonElement>("[data-audio-kind]")) {
      button.disabled = isBusy;
    }
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

  private pauseAudioPreview(): void {
    for (const audio of this.audioElementsByKind.values()) {
      audio.pause();
    }

    this.stopAudioMeterLoop();
    this.resetAudioMeterLevels();
  }

  private async disposeAudioPreview(): Promise<void> {
    this.stopAudioMeterLoop();
    for (const audio of this.audioElementsByKind.values()) {
      audio.pause();
      audio.removeAttribute("src");
    }

    for (const meter of this.audioMetersByKind.values()) {
      meter.source.disconnect();
      meter.gain.disconnect();
    }

    if (this.audioPreviewContext) {
      if (this.audioPreviewContext.state !== "closed") {
        await this.audioPreviewContext.close();
      }

      this.audioPreviewContext = null;
    }

    this.audioElementsByKind.clear();
    this.audioMetersByKind.clear();
  }

  private resetAudioMeterLevels(): void {
    for (const meter of this.audioMetersByKind.values()) {
      meter.row?.style.setProperty(audioLevelCssProperty, "0");
    }
  }

  private async resumeAudioMeters(): Promise<void> {
    if (this.audioPreviewContext?.state === "suspended") {
      await this.audioPreviewContext.resume();
    }
  }

  private startAudioMeterLoop(): void {
    if (this.audioMeterFrame !== null) {
      return;
    }

    const updateFrame = (): void => {
      this.updateAudioMeterLevels();
      if (this.video.paused) {
        this.audioMeterFrame = null;
        return;
      }

      this.audioMeterFrame = requestAnimationFrame(updateFrame);
    };

    this.audioMeterFrame = requestAnimationFrame(updateFrame);
  }

  private stopAudioMeterLoop(): void {
    if (this.audioMeterFrame === null) {
      return;
    }

    cancelAnimationFrame(this.audioMeterFrame);
    this.audioMeterFrame = null;
  }

  private updateAudioMeterLevels(): void {
    for (const [kind, meter] of this.audioMetersByKind) {
      meter.analyser.getByteTimeDomainData(meter.data);
      const level = this.mutedAudioKinds.has(kind) ? 0 : audioLevelFromTimeDomainSamples(meter.data);
      meter.row?.style.setProperty(audioLevelCssProperty, String(level));
    }
  }

  private syncAudioPreviewTime(currentTime: number): void {
    for (const audio of this.audioElementsByKind.values()) {
      if (Math.abs(audio.currentTime - currentTime) > trimToleranceSeconds) {
        audio.currentTime = currentTime;
      }
    }
  }

  private syncPlayButton(): void {
    this.playButton.dataset.state = this.video.paused ? "play" : "pause";
    setTooltipLabel(this.playButton, this.video.paused ? "Play" : "Pause");
  }

  private syncPlaybackTime(): void {
    const currentTime = this.clampedPlaybackTime(this.video.currentTime);
    if (currentTime !== this.video.currentTime) {
      this.video.currentTime = currentTime;
    }

    this.syncAudioPreviewTime(currentTime);

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
      this.syncAudioPreviewTime(this.trimStartSeconds);
    }

    await this.audioReady;
    await this.resumeAudioMeters();
    this.syncAudioPreviewTime(this.video.currentTime);
    try {
      await Promise.all([
        playMedia(this.video),
        ...Array.from(this.audioElementsByKind.values(), async (audio) => await playMedia(audio))
      ]);
    } catch (error) {
      this.video.pause();
      this.pauseAudioPreview();
      throw error;
    }
  }

  private updateTimelineScrub(event: PointerEvent): void {
    if (this.activeTimelinePointerId !== event.pointerId) {
      return;
    }

    this.seekToTimelinePoint(event.clientX);
  }

  private isFullTrimRange(trimRange: TrimRange): boolean {
    return trimRange.start <= fullTrimToleranceSeconds
      && Math.abs(trimRange.end - this.durationSeconds) <= fullTrimToleranceSeconds;
  }

  private trimRange(): TrimRange {
    return {
      end: this.trimEndSeconds,
      start: this.trimStartSeconds
    };
  }

  private trimKey(): string {
    return `${trimKeyFromRange(this.trimRange())}:${this.audioExportKey()}`;
  }

  private audioExportKey(): string {
    return this.audioTracks
      .map((audioTrack) => `${audioTrack.kind}=${String(!this.mutedAudioKinds.has(audioTrack.kind))}`)
      .join(",");
  }

  private toggleAudioTrackMute(kind: AudioSourceKind): void {
    if (this.mutedAudioKinds.has(kind)) {
      this.mutedAudioKinds.delete(kind);
    } else {
      this.mutedAudioKinds.add(kind);
    }

    this.syncAudioMuteStates();

    this.renderAudioTracks();
    this.preparedVideo = null;
  }

  private syncAudioMuteStates(): void {
    const activeTrackCount = this.audioTracks.filter((audioTrack) => !this.mutedAudioKinds.has(audioTrack.kind)).length;
    const activeGain = activeTrackCount > 0 ? audioMixGain(activeTrackCount) : 0;
    for (const [kind, meter] of this.audioMetersByKind) {
      meter.gain.gain.value = this.mutedAudioKinds.has(kind) ? 0 : activeGain;
    }
  }

  private updateTrimEnd(value: number): void {
    const minimumDuration = Math.min(minimumTrimDurationSeconds, this.durationSeconds);
    this.trimEndSeconds = clamp(value, this.trimStartSeconds + minimumDuration, this.durationSeconds);

    this.syncTimeline();
    this.seekTo(this.video.currentTime);
    this.preparedVideo = null;
  }

  private updateTrimStart(value: number): void {
    const minimumDuration = Math.min(minimumTrimDurationSeconds, this.durationSeconds);
    this.trimStartSeconds = clamp(value, zeroSeconds, this.trimEndSeconds - minimumDuration);

    this.syncTimeline();
    this.seekTo(this.video.currentTime);
    this.preparedVideo = null;
  }

  async initialize(): Promise<void> {
    try {
      this.bindEvents();
      const bootstrap = await getSoftshotApi().getEditorBootstrap();
      this.loadRecording(bootstrap);
      await Promise.all([
        waitForMediaMetadata(this.video),
        this.audioReady
      ]);
      if (this.video.videoWidth < 1 || this.video.videoHeight < 1) {
        throw new Error("The recording does not contain a usable video track.");
      }

      if (Number.isFinite(this.video.duration) && this.video.duration > zeroSeconds) {
        this.durationSeconds = this.video.duration;
      }

      this.trimEndSeconds = this.durationSeconds;
      this.totalTimeText.textContent = formatTime(this.durationSeconds);
      this.syncTimeline();
      this.syncPlaybackTime();
    } catch (error) {
      try {
        await this.reportError("Could not open the editor.", error);
      } finally {
        await this.closeEditor();
      }
    }
  }
}

function preparedVideoFromFile(key: string, file: PreparedVideoFile): PreparedVideo {
  return {
    filePath: file.filePath,
    key
  };
}

function audioSourceKindFromString(value: string | undefined): AudioSourceKind {
  if (value === "microphone" || value === "system") {
    return value;
  }

  throw new Error("Unexpected audio track type.");
}

function audioTrackLabel(kind: AudioSourceKind): string {
  return kind === "microphone" ? "Mic" : "Desktop";
}

function audioTrackIcon(kind: AudioSourceKind): string {
  if (kind === "microphone") {
    return microphoneTrackIcon();
  }

  return speakerTrackIcon(`<path d="M16.5 9.5a4 4 0 0 1 0 5" />`);
}

function audioTrackMuteIcon(isMuted: boolean): string {
  if (isMuted) {
    return speakerTrackIcon(`<path d="M19 5 5 19" />`);
  }

  return speakerTrackIcon(`<path d="M16.5 9.5a4 4 0 0 1 0 5" />`);
}

function microphoneTrackIcon(): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V7a3 3 0 0 0-3-3Z" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" /><path d="M12 18v3" /></svg>`;
}

function speakerTrackIcon(detailPath: string): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4h4l5 4V6l-5 4H4Z" />${detailPath}</svg>`;
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

async function waitForAudioReady(audioReadyPromises: Array<Promise<void>>): Promise<void> {
  await Promise.all(audioReadyPromises);
}

const editorApp = new VideoEditorApp();
await editorApp.initialize();
