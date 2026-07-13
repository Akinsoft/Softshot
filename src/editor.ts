import { audioAnalyzerFftSize, audioLevelFromTimeDomainSamples } from "./audio-level.js";
import { audioMixGain, recordingAudioSampleRate } from "./audio-quality.js";
import { audioWaveformPeaks } from "./audio-waveform.js";
import { type ExportAudioTrack, exportEditedVideo, type ExportedVideo, type TrimRange } from "./editor-export.js";
import {
  deleteTimelineSegment,
  sourceRangesForTimelineRange,
  splitTimelineAt,
  timelineDuration,
  type TimelineLocation,
  timelineLocationAt,
  type TimelineSegment,
  timelineSegmentBounds,
  timelineSegmentDuration,
  timelineTimeAfterDeletion
} from "./editor-timeline.js";
import { drawTimelineWaveform } from "./editor-waveform-view.js";
import { playMedia, waitForMediaMetadata } from "./media-element.js";
import { getRequiredElement } from "./overlay-dom.js";
import type { AudioSourceKind, EditorAudioTrack, EditorBootstrap, PreparedVideoFile, VideoFps } from "./shared.js";
import { videoFpsOptions } from "./shared.js";
import { getSoftshotApi } from "./softshot-api.js";
import { setTooltipLabel, TooltipController } from "./ui-tooltip.js";

const defaultMimeType = "video/webm";
const audioLevelCssProperty = "--audio-level";
const audioWaveformPeakCount = 640;
const minimumTrimDurationSeconds = 0.05;
const rangeStepSeconds = 0.01;
const halfDivisor = 2;
const fullTrimToleranceSeconds = rangeStepSeconds / halfDivisor;
const playbackBoundaryToleranceSeconds = fullTrimToleranceSeconds;
const secondsPerMinute = 60;
const secondsTextLength = 5;
const spaceKey = " ";
const backspaceKey = "Backspace";
const cutKey = "c";
const keyboardDeleteKey = "Delete";
const initialSegmentId = 1;
const timePartLength = 2;
const timePrecisionDigits = 2;
const trimKeyPrecisionDigits = 3;
const timelinePercent = 100;
const trimToleranceSeconds = 0.04;
const transientStatusDurationMs = 1400;
const timelineReflowDurationMs = 220;
const timelineReflowEasing = "cubic-bezier(0.22, 1, 0.36, 1)";
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
  private readonly cutButton = getRequiredElement("cut-button", HTMLButtonElement);
  private readonly currentTimeText = getRequiredElement("current-time", HTMLSpanElement);
  private readonly audioTracksElement = getRequiredElement("audio-tracks", HTMLElement);
  private readonly audioWaveformResizeObserver = new ResizeObserver((): void => {
    this.renderAudioWaveforms();
  });
  private readonly endRange = getRequiredElement("trim-end", HTMLInputElement);
  private readonly playButton = getRequiredElement("play-button", HTMLButtonElement);
  private readonly saveButton = getRequiredElement("editor-save-button", HTMLButtonElement);
  private readonly startRange = getRequiredElement("trim-start", HTMLInputElement);
  private readonly statusText = getRequiredElement("editor-status", HTMLSpanElement);
  private readonly timeline = getRequiredElement("timeline", HTMLDivElement);
  private readonly timelineTrack = getRequiredElement("timeline-track", HTMLDivElement);
  private readonly timelineSegmentsElement = getRequiredElement("timeline-segments", HTMLDivElement);
  private readonly totalTimeText = getRequiredElement("total-time", HTMLSpanElement);
  private readonly tooltips = new TooltipController(document.body);
  private readonly video = getRequiredElement("editor-video", HTMLVideoElement);
  private activeTimelinePointerId = noPointerId;
  private audioMeterFrame: number | null = null;
  private audioPreviewContext: AudioContext | null = null;
  private audioReady: Promise<void> = Promise.resolve();
  private audioTracks: EditorAudioTrack[] = [];
  private readonly audioWaveformsByKind = new Map<AudioSourceKind, number[]>();
  private readonly audioElementsByKind = new Map<AudioSourceKind, HTMLAudioElement>();
  private readonly audioMetersByKind = new Map<AudioSourceKind, AudioMeter>();
  private durationSeconds = zeroSeconds;
  private fps: VideoFps = videoFpsOptions.high;
  private isBusy = false;
  private isClosing = false;
  private mimeType = defaultMimeType;
  private playbackFrameHandle: number | null = null;
  private playheadSeconds = zeroSeconds;
  private preparedVideo: PreparedVideo | null = null;
  private selectedSegmentId: number | null = null;
  private sourceFilePath = "";
  private sourceUrl = "";
  private statusHandle: ReturnType<typeof setTimeout> | null = null;
  private trimEndSeconds = zeroSeconds;
  private trimStartSeconds = zeroSeconds;
  private activeSegmentId: number | null = null;
  private nextSegmentId = initialSegmentId + 1;
  private readonly timelineSegmentElements = new Map<number, HTMLButtonElement>();
  private timelineSegments: TimelineSegment[] = [];
  private readonly mutedAudioKinds = new Set<AudioSourceKind>();

  private bindEvents(): void {
    this.tooltips.bind();
    this.bindKeyboardEvents();
    this.audioWaveformResizeObserver.observe(this.audioTracksElement);
    this.closeButton.addEventListener("click", (): void => {
      this.runAsync(this.closeEditor(), "Could not close the editor.");
    });
    this.copyButton.addEventListener("click", (): void => {
      this.runAsync(this.copyVideo(), "Could not copy the recording.");
    });
    this.cutButton.addEventListener("click", (): void => {
      this.run((): void => {
        this.cutAtPlayhead();
      }, "Could not cut the recording.");
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
      if (event.key === spaceKey) {
        event.preventDefault();
        event.stopPropagation();
        this.blurFocusedElement();

        if (!event.repeat) {
          this.runAsync(this.togglePlayback(), "Could not preview the recording.");
        }
        return;
      }

      if (event.key.toLowerCase() === cutKey && !hasCommandModifier(event)) {
        event.preventDefault();
        event.stopPropagation();
        this.blurFocusedElement();
        if (!event.repeat) {
          this.run((): void => {
            this.cutAtPlayhead();
          }, "Could not cut the recording.");
        }
        return;
      }

      if ((event.key === keyboardDeleteKey || event.key === backspaceKey)
        && !hasCommandModifier(event)
        && this.selectedSegmentId !== null) {
        event.preventDefault();
        event.stopPropagation();
        this.blurFocusedElement();
        if (!event.repeat) {
          this.run((): void => {
            this.deleteSelectedSegment();
          }, "Could not delete the selected segment.");
        }
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

  private run(task: () => void, message: string): void {
    try {
      task();
    } catch (error) {
      const actualError = error instanceof Error ? error : new Error(String(error));
      this.runAsync(Promise.reject(actualError), message);
    }
  }

  private async closeEditor(): Promise<void> {
    if (this.isBusy || this.isClosing) {
      return;
    }

    this.isClosing = true;
    this.audioWaveformResizeObserver.disconnect();
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
    const timelineTime = this.timelineTimeAtClientX(event.clientX);
    this.selectSegmentAt(timelineTime);
    this.seekTo(timelineTime);
    event.preventDefault();
  }

  private clampedPlaybackTime(value: number): number {
    return clamp(value, this.trimStartSeconds, this.trimEndSeconds);
  }

  private editedDurationSeconds(): number {
    return timelineDuration(this.timelineSegments);
  }

  private timelineTimeAtClientX(clientX: number): number {
    const rect = this.timelineTrack.getBoundingClientRect();
    if (rect.width <= 0) {
      throw new Error("The editor timeline has no usable width.");
    }

    const progress = clamp((clientX - rect.left) / rect.width, zeroSeconds, 1);
    return progress * this.editedDurationSeconds();
  }

  private selectSegmentAt(timelineTime: number): void {
    this.selectedSegmentId = timelineLocationAt(this.timelineSegments, timelineTime).segment.id;
    this.renderTimelineSegments();
  }

  private cutAtPlayhead(): void {
    if (this.isBusy) {
      return;
    }

    let split;
    try {
      split = splitTimelineAt(
        this.timelineSegments,
        this.playheadSeconds,
        this.nextSegmentId,
        minimumTrimDurationSeconds
      );
    } catch (error) {
      if (error instanceof RangeError) {
        this.showStatus(error.message);
        return;
      }

      throw error;
    }

    this.video.pause();
    this.timelineSegments = split.segments;
    this.nextSegmentId += 1;
    this.selectedSegmentId = split.rightSegmentId;
    this.activeSegmentId = split.rightSegmentId;
    this.preparedVideo = null;
    this.syncTimeline();
    this.syncPlaybackTime();
    this.showStatus("Cut added");
  }

  private deleteSelectedSegment(): void {
    if (this.isBusy || this.selectedSegmentId === null) {
      return;
    }

    if (this.timelineSegments.length === 1) {
      this.showStatus("At least one segment must remain");
      return;
    }

    const { selectedSegmentId } = this;
    const selectedSegmentIndex = this.timelineSegments.findIndex((segment) => segment.id === selectedSegmentId);
    const deletedRange = timelineSegmentBounds(this.timelineSegments, selectedSegmentId);
    const previousSegmentRects = this.timelineSegmentRects();
    const selectedElement = this.timelineSegmentElements.get(selectedSegmentId);
    if (!selectedElement) {
      throw new Error("The selected timeline section is not rendered.");
    }

    const removingElement = selectedElement.cloneNode(true) as HTMLButtonElement;
    this.video.pause();
    this.timelineSegments = deleteTimelineSegment(this.timelineSegments, selectedSegmentId);
    this.trimStartSeconds = timelineTimeAfterDeletion(this.trimStartSeconds, deletedRange);
    this.trimEndSeconds = timelineTimeAfterDeletion(this.trimEndSeconds, deletedRange);
    this.playheadSeconds = timelineTimeAfterDeletion(this.playheadSeconds, deletedRange);
    this.normalizeTrimRange();

    const nextSelectedIndex = Math.min(selectedSegmentIndex, this.timelineSegments.length - 1);
    this.selectedSegmentId = this.timelineSegments[nextSelectedIndex]?.id ?? null;
    this.activeSegmentId = null;
    this.preparedVideo = null;
    this.syncTimeline();
    this.animateTimelineDeletion(previousSegmentRects, removingElement);
    this.seekTo(this.playheadSeconds);
    this.showStatus("Segment deleted");
  }

  private normalizeTrimRange(): void {
    const editedDuration = this.editedDurationSeconds();
    const minimumDuration = Math.min(minimumTrimDurationSeconds, editedDuration);
    this.trimStartSeconds = clamp(this.trimStartSeconds, zeroSeconds, editedDuration - minimumDuration);
    this.trimEndSeconds = clamp(this.trimEndSeconds, this.trimStartSeconds + minimumDuration, editedDuration);
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

  private async createPreparedVideo(key: string, sourceRanges: readonly TrimRange[]): Promise<PreparedVideo> {
    const singleSourceRange = sourceRanges.length === 1 ? sourceRanges[0] : null;
    if (this.mutedAudioKinds.size === 0 && singleSourceRange && singleSourceRange.start <= fullTrimToleranceSeconds) {
      if (this.isFullSourceRange(singleSourceRange)) {
        return {
          filePath: this.sourceFilePath,
          key
        };
      }

      const trimmedFile = await getSoftshotApi().trimEditorVideoEnd(singleSourceRange.end);
      return preparedVideoFromFile(key, trimmedFile);
    }

    const exportedVideo = await this.exportVideoForSourceRanges(sourceRanges);
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
        kind: audioTrack.kind
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

  private async exportVideoForSourceRanges(sourceRanges: readonly TrimRange[]): Promise<ExportedVideo> {
    return await exportEditedVideo(this.mimeType, this.fps, sourceRanges, this.audioTracksForExport());
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

  private async loadAudioWaveforms(): Promise<void> {
    const waveforms = await Promise.all(this.audioTracks.map(async (audioTrack) => ({
      kind: audioTrack.kind,
      peaks: await audioWaveformPeaks(audioTrack.kind, this.durationSeconds, audioWaveformPeakCount)
    })));
    this.audioWaveformsByKind.clear();
    for (const waveform of waveforms) {
      this.audioWaveformsByKind.set(waveform.kind, waveform.peaks);
    }
  }

  private async preparedVideoForCurrentTrim(): Promise<PreparedVideo> {
    const key = this.trimKey();
    if (this.preparedVideo?.key === key) {
      return this.preparedVideo;
    }

    const preparedVideo = await this.createPreparedVideo(key, this.sourceRangesForExport());
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
    this.renderAudioWaveforms();
  }

  private renderAudioWaveforms(): void {
    if (this.timelineSegments.length === 0) {
      return;
    }

    for (const canvas of this.audioTracksElement.querySelectorAll<HTMLCanvasElement>("canvas[data-audio-kind]")) {
      const kind = audioSourceKindFromString(canvas.dataset.audioKind);
      if (this.audioTracks.every((candidate) => candidate.kind !== kind)) {
        throw new Error("The audio waveform track is missing.");
      }

      const waveformPeaks = this.audioWaveformsByKind.get(kind);
      if (!waveformPeaks) {
        throw new Error("The audio waveform data is missing.");
      }

      drawTimelineWaveform(
        canvas,
        waveformPeaks,
        this.durationSeconds,
        this.timelineSegments,
        this.mutedAudioKinds.has(kind)
      );
    }
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
    const waveform = document.createElement("canvas");
    waveform.className = "audio-waveform";
    waveform.dataset.audioKind = audioTrack.kind;
    line.append(waveform);

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
    const location = timelineLocationAt(this.timelineSegments, currentTime);
    this.activeSegmentId = location.segment.id;
    this.playheadSeconds = currentTime;
    this.video.currentTime = location.sourceTime;
    this.syncAudioPreviewTime(location.sourceTime);
    this.syncPlaybackTime();
  }

  private seekToTimelinePoint(clientX: number): void {
    this.seekTo(this.timelineTimeAtClientX(clientX));
  }

  private setBusy(isBusy: boolean): void {
    this.isBusy = isBusy;
    document.body.classList.toggle("busy", isBusy);
    this.copyButton.disabled = isBusy;
    this.closeButton.disabled = isBusy;
    this.cutButton.disabled = isBusy;
    this.saveButton.disabled = isBusy;
    this.startRange.disabled = isBusy;
    this.endRange.disabled = isBusy;
    this.playButton.disabled = isBusy;
    for (const button of this.audioTracksElement.querySelectorAll<HTMLButtonElement>("[data-audio-kind]")) {
      button.disabled = isBusy;
    }
    for (const button of this.timelineSegmentElements.values()) {
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

  private activePlaybackLocation(): TimelineLocation {
    const { activeSegmentId } = this;
    if (activeSegmentId === null) {
      return timelineLocationAt(this.timelineSegments, this.playheadSeconds);
    }

    const segmentIndex = this.timelineSegments.findIndex((segment) => segment.id === activeSegmentId);
    const segment = this.timelineSegments.at(segmentIndex);
    if (!segment) {
      throw new Error("The active timeline segment no longer exists.");
    }

    const bounds = timelineSegmentBounds(this.timelineSegments, activeSegmentId);
    return {
      segment,
      segmentIndex,
      sourceTime: this.video.currentTime,
      ...bounds
    };
  }

  private renderTimelineSegments(): void {
    const editedDuration = this.editedDurationSeconds();
    let timelineStart = zeroSeconds;
    const renderedSegmentIds = new Set<number>();
    const elements = this.timelineSegments.map((segment, segmentIndex) => {
      let element = this.timelineSegmentElements.get(segment.id);
      if (!element) {
        element = document.createElement("button");
        element.className = "timeline-segment";
        element.type = "button";
        element.tabIndex = -1;
        element.dataset.segmentId = String(segment.id);
        this.timelineSegmentElements.set(segment.id, element);
      }

      const segmentDuration = timelineSegmentDuration(segment);
      const isSelected = segment.id === this.selectedSegmentId;
      renderedSegmentIds.add(segment.id);
      element.disabled = this.isBusy;
      element.setAttribute("aria-label", `Select section ${String(segmentIndex + 1)}`);
      element.setAttribute("aria-pressed", String(isSelected));
      element.classList.toggle("selected", isSelected);
      element.style.left = `${String(percentOf(timelineStart, editedDuration))}%`;
      element.style.width = `${String(percentOf(segmentDuration, editedDuration))}%`;
      timelineStart += segmentDuration;
      return element;
    });
    for (const segmentId of this.timelineSegmentElements.keys()) {
      if (!renderedSegmentIds.has(segmentId)) {
        this.timelineSegmentElements.delete(segmentId);
      }
    }

    this.timelineSegmentsElement.replaceChildren(...elements);
  }

  private timelineSegmentRects(): Map<number, DOMRect> {
    return new Map(Array.from(
      this.timelineSegmentElements,
      ([segmentId, element]) => [segmentId, element.getBoundingClientRect()]
    ));
  }

  private animateTimelineDeletion(
    previousSegmentRects: ReadonlyMap<number, DOMRect>,
    removingElement: HTMLButtonElement
  ): void {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }

    for (const [segmentId, element] of this.timelineSegmentElements) {
      const previousRect = previousSegmentRects.get(segmentId);
      if (!previousRect) {
        continue;
      }

      const currentRect = element.getBoundingClientRect();
      const offsetX = previousRect.left - currentRect.left;
      const widthScale = currentRect.width > 0 ? previousRect.width / currentRect.width : 1;
      element.animate([
        { transform: `translateX(${String(offsetX)}px) scaleX(${String(widthScale)})`, transformOrigin: "left center" },
        { transform: "none", transformOrigin: "left center" }
      ], {
        duration: timelineReflowDurationMs,
        easing: timelineReflowEasing
      });
    }

    removingElement.classList.add("timeline-segment-removing");
    removingElement.disabled = true;
    removingElement.setAttribute("aria-hidden", "true");
    this.timelineSegmentsElement.append(removingElement);
    const removalAnimation = removingElement.animate([
      { opacity: 1, transform: "scaleX(1)" },
      { opacity: 0, transform: "scaleX(0.2)" }
    ], {
      duration: timelineReflowDurationMs,
      easing: timelineReflowEasing
    });
    void removalAnimation.finished.then(
      (): void => removingElement.remove(),
      (): void => removingElement.remove()
    );
  }

  private syncPlaybackTime(): void {
    const location = this.activePlaybackLocation();
    const sourceTime = clamp(this.video.currentTime, location.segment.sourceStart, location.segment.sourceEnd);
    const timelineTime = location.timelineStart + sourceTime - location.segment.sourceStart;
    let currentTime = this.clampedPlaybackTime(timelineTime);

    if (!this.video.paused) {
      if (timelineTime >= this.trimEndSeconds - playbackBoundaryToleranceSeconds) {
        currentTime = this.trimEndSeconds;
        this.video.pause();
      } else if (sourceTime >= location.segment.sourceEnd - playbackBoundaryToleranceSeconds) {
        const nextSegment = this.timelineSegments.at(location.segmentIndex + 1);
        if (nextSegment?.sourceStart === location.segment.sourceEnd) {
          this.activeSegmentId = nextSegment.id;
          currentTime = location.timelineEnd;
        } else {
          this.seekTo(location.timelineEnd);
          return;
        }
      }
    }

    this.playheadSeconds = currentTime;
    this.syncAudioPreviewTime(sourceTime);
    this.currentTimeText.textContent = formatTime(currentTime);
    const editedDuration = this.editedDurationSeconds();
    this.timeline.style.setProperty("--playhead", `${String(percentOf(currentTime, editedDuration))}%`);
    this.syncPlayButton();
  }

  private syncTimeline(): void {
    const editedDuration = this.editedDurationSeconds();
    this.startRange.max = String(editedDuration);
    this.endRange.max = String(editedDuration);
    this.startRange.step = String(rangeStepSeconds);
    this.endRange.step = String(rangeStepSeconds);
    this.startRange.value = String(this.trimStartSeconds);
    this.endRange.value = String(this.trimEndSeconds);

    const startPercent = percentOf(this.trimStartSeconds, editedDuration);
    const endPercent = percentOf(this.trimEndSeconds, editedDuration);
    this.timeline.style.setProperty("--trim-start", `${String(startPercent)}%`);
    this.timeline.style.setProperty("--trim-end", `${String(endPercent)}%`);
    this.totalTimeText.textContent = formatTime(editedDuration);
    this.renderTimelineSegments();
    this.renderAudioWaveforms();
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

    if (this.playheadSeconds < this.trimStartSeconds || this.playheadSeconds >= this.trimEndSeconds) {
      this.seekTo(this.trimStartSeconds);
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

  private isFullSourceRange(sourceRange: TrimRange): boolean {
    return sourceRange.start <= fullTrimToleranceSeconds
      && Math.abs(sourceRange.end - this.durationSeconds) <= fullTrimToleranceSeconds;
  }

  private trimRange(): TrimRange {
    return {
      end: this.trimEndSeconds,
      start: this.trimStartSeconds
    };
  }

  private trimKey(): string {
    return `${this.timelineKey()}:${trimKeyFromRange(this.trimRange())}:${this.audioExportKey()}`;
  }

  private timelineKey(): string {
    return this.timelineSegments
      .map((segment) => `${String(segment.id)}=${segment.sourceStart.toFixed(trimKeyPrecisionDigits)}-${segment.sourceEnd.toFixed(trimKeyPrecisionDigits)}`)
      .join(",");
  }

  private sourceRangesForExport(): TrimRange[] {
    return sourceRangesForTimelineRange(this.timelineSegments, this.trimRange());
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
    const editedDuration = this.editedDurationSeconds();
    const minimumDuration = Math.min(minimumTrimDurationSeconds, editedDuration);
    this.trimEndSeconds = clamp(value, this.trimStartSeconds + minimumDuration, editedDuration);

    this.syncTimeline();
    this.seekTo(this.playheadSeconds);
    this.preparedVideo = null;
  }

  private updateTrimStart(value: number): void {
    const minimumDuration = Math.min(minimumTrimDurationSeconds, this.durationSeconds);
    this.trimStartSeconds = clamp(value, zeroSeconds, this.trimEndSeconds - minimumDuration);

    this.syncTimeline();
    this.seekTo(this.playheadSeconds);
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

      await this.loadAudioWaveforms();

      this.timelineSegments = [{
        id: initialSegmentId,
        sourceEnd: this.durationSeconds,
        sourceStart: zeroSeconds
      }];
      this.activeSegmentId = initialSegmentId;
      this.selectedSegmentId = initialSegmentId;
      this.trimEndSeconds = this.durationSeconds;
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

function hasCommandModifier(event: KeyboardEvent): boolean {
  return event.altKey || event.ctrlKey || event.metaKey;
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
