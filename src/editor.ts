import { audioAnalyzerFftSize, audioLevelFromTimeDomainSamples } from "./audio-level.js";
import { audioMixGain, recordingAudioSampleRate } from "./audio-quality.js";
import { audioWaveformPeaks } from "./audio-waveform.js";
import { type ExportAudioTrack, exportEditedVideo, type ExportedVideo, type TrimRange } from "./editor-export.js";
import {
  captureVideoTimelineThumbnails,
  releaseTimelineThumbnailUrls,
  type TimelineThumbnail,
  timelineThumbnailsForSegment
} from "./editor-thumbnails.js";
import {
  deleteTimelineSegment,
  moveTimelineSegment,
  resizeTimelineSegment,
  sourceRangesForTimeline,
  splitTimelineAt,
  timelineDuration,
  type TimelineLocation,
  timelineLocationAt,
  type TimelineSegment,
  timelineSegmentBounds,
  timelineSegmentDuration,
  type TimelineSegmentEdge,
  timelineTimeAfterDeletion
} from "./editor-timeline.js";
import { drawTimelineWaveform } from "./editor-waveform-view.js";
import { playMedia, waitForMediaMetadata } from "./media-element.js";
import { getRequiredElement } from "./overlay-dom.js";
import type { AudioSourceKind, EditorAudioTrack, EditorBootstrap, PreparedVideoFile, VideoFps } from "./shared.js";
import { videoFpsOptions } from "./shared.js";
import { getSoftshotApi, reportAsyncError, reportError } from "./softshot-api.js";
import { setTooltipLabel, TooltipController } from "./ui-tooltip.js";

const defaultMimeType = "video/webm";
const audioLevelCssProperty = "--audio-level";
const audioWaveformPeakCount = 640;
const minimumTrimDurationSeconds = 0.05;
const halfDivisor = 2;
const fullSourceRangeToleranceSeconds = 0.005;
const playbackBoundaryToleranceSeconds = fullSourceRangeToleranceSeconds;
const timelineMoveThresholdPx = 6;
const timelineThumbnailImageWidthPx = 160;
const timelineThumbnailMaximumCount = 14;
const timelineThumbnailMinimumIntervalSeconds = 1.5;
const timelineThumbnailTargetWidthPx = 120;
const secondsPerMinute = 60;
const secondsTextLength = 5;
const spaceKey = " ";
const backspaceKey = "Backspace";
const cutKey = "c";
const keyboardDeleteKey = "Delete";
const initialSegmentId = 1;
const timePartLength = 2;
const timePrecisionDigits = 2;
const timelineKeyPrecisionDigits = 3;
const timelinePercent = 100;
const trimToleranceSeconds = 0.04;
const transientStatusDurationMs = 1400;
const timelineReflowDurationMs = 220;
const timelineReflowEasing = "cubic-bezier(0.22, 1, 0.36, 1)";
const zeroSeconds = 0;
const noPointerId = -1;
const ariaHiddenAttributeName = "aria-hidden";
const reducedMotionMediaQuery = "(prefers-reduced-motion: reduce)";

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

interface TimelineResize {
  edge: TimelineSegmentEdge;
  hasChanged: boolean;
  initialClientX: number;
  initialSegments: TimelineSegment[];
  initialTrackWidth: number;
  playbackSegmentId: number;
  playbackSourceTime: number;
  pointerId: number;
  segmentId: number;
}

interface TimelineMove {
  hasMoved: boolean;
  initialClientX: number;
  isDragging: boolean;
  playbackSegmentId: number;
  playbackSourceTime: number;
  pointerId: number;
  segmentId: number;
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
  private readonly playButton = getRequiredElement("play-button", HTMLButtonElement);
  private readonly saveButton = getRequiredElement("editor-save-button", HTMLButtonElement);
  private readonly statusText = getRequiredElement("editor-status", HTMLSpanElement);
  private readonly timeline = getRequiredElement("timeline", HTMLDivElement);
  private readonly timelineTrack = getRequiredElement("timeline-track", HTMLDivElement);
  private readonly timelineSegmentsElement = getRequiredElement("timeline-segments", HTMLDivElement);
  private readonly totalTimeText = getRequiredElement("total-time", HTMLSpanElement);
  private readonly tooltips = new TooltipController(document.body);
  private readonly video = getRequiredElement("editor-video", HTMLVideoElement);
  private activeTimelineMove: TimelineMove | null = null;
  private activeTimelinePointerId = noPointerId;
  private activeTimelineResize: TimelineResize | null = null;
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
  private activeSegmentId: number | null = null;
  private nextSegmentId = initialSegmentId + 1;
  private readonly timelineSegmentElements = new Map<number, HTMLButtonElement>();
  private timelineSegments: TimelineSegment[] = [];
  private timelineThumbnails: TimelineThumbnail[] = [];
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
    this.timelineTrack.addEventListener("pointerdown", (event): void => {
      this.beginTimelineInteraction(event);
    });
    this.timelineTrack.addEventListener("pointermove", (event): void => {
      this.updateTimelineInteraction(event);
    });
    this.timelineTrack.addEventListener("pointerup", (event): void => {
      this.endTimelineInteraction(event);
    });
    this.timelineTrack.addEventListener("pointercancel", (event): void => {
      this.endTimelineInteraction(event);
    });
    this.timelineTrack.addEventListener("lostpointercapture", (event): void => {
      this.endTimelineInteraction(event);
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

  private runAsync(task: Promise<void>, message: string): void {
    void reportAsyncError(task, message);
  }

  private run(task: () => void, message: string): void {
    try {
      task();
    } catch (error) {
      void reportError(message, error);
    }
  }

  private get isInteractionLocked(): boolean {
    return this.isBusy || this.isClosing
      || this.activeTimelineMove !== null
      || this.activeTimelineResize !== null
      || this.activeTimelinePointerId !== noPointerId;
  }

  private get canReorderTimelineSegments(): boolean {
    return this.timelineSegments.length > 1;
  }

  private async closeEditor(): Promise<void> {
    if (this.isInteractionLocked) {
      return;
    }

    this.isClosing = true;
    this.audioWaveformResizeObserver.disconnect();
    this.releaseTimelineThumbnails();
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

  private beginTimelineInteraction(event: PointerEvent): void {
    if (event.button !== 0 || this.isInteractionLocked) {
      return;
    }

    const target = event.target instanceof HTMLElement ? event.target : null;
    const resizeHandle = target?.closest<HTMLElement>("[data-timeline-edge]");
    if (resizeHandle) {
      this.beginTimelineResize(event, resizeHandle);
      return;
    }

    const segmentElement = target?.closest<HTMLButtonElement>(".timeline-segment");
    if (segmentElement && this.canReorderTimelineSegments) {
      this.beginTimelineMove(event, segmentElement);
      return;
    }

    this.beginTimelineScrub(event);
  }

  private beginTimelineMove(event: PointerEvent, segmentElement: HTMLButtonElement): void {
    const segmentId = timelineSegmentIdFromString(segmentElement.dataset.segmentId);
    timelineSegmentById(this.timelineSegments, segmentId);
    const timelineTime = this.timelineTimeAtClientX(event.clientX);
    const playbackLocation = timelineLocationAt(this.timelineSegments, timelineTime);
    this.video.pause();
    this.selectedSegmentId = segmentId;
    this.seekTo(timelineTime);
    this.activeTimelineMove = {
      hasMoved: false,
      initialClientX: event.clientX,
      isDragging: false,
      playbackSegmentId: playbackLocation.segment.id,
      playbackSourceTime: playbackLocation.sourceTime,
      pointerId: event.pointerId,
      segmentId
    };
    this.timelineTrack.setPointerCapture(event.pointerId);
    this.renderTimelineSegments();
    event.preventDefault();
  }

  private beginTimelineResize(event: PointerEvent, resizeHandle: HTMLElement): void {
    const edge = timelineSegmentEdgeFromString(resizeHandle.dataset.timelineEdge);
    const segmentId = timelineSegmentIdFromString(resizeHandle.dataset.segmentId);
    timelineSegmentById(this.timelineSegments, segmentId);
    const trackBounds = this.timelineTrack.getBoundingClientRect();
    if (trackBounds.width <= 0) {
      throw new Error("The editor timeline has no usable width.");
    }

    const playbackLocation = timelineLocationAt(this.timelineSegments, this.playheadSeconds);
    this.video.pause();
    this.selectedSegmentId = segmentId;
    this.activeTimelineResize = {
      edge,
      hasChanged: false,
      initialClientX: event.clientX,
      initialSegments: this.timelineSegments.map((segment) => ({ ...segment })),
      initialTrackWidth: trackBounds.width,
      playbackSegmentId: playbackLocation.segment.id,
      playbackSourceTime: playbackLocation.sourceTime,
      pointerId: event.pointerId,
      segmentId
    };
    this.timeline.classList.add("resizing-clip");
    this.timelineTrack.setPointerCapture(event.pointerId);
    this.renderTimelineSegments();
    event.preventDefault();
  }

  private beginTimelineScrub(event: PointerEvent): void {
    this.activeTimelinePointerId = event.pointerId;
    this.timelineTrack.setPointerCapture(event.pointerId);
    const timelineTime = this.timelineTimeAtClientX(event.clientX);
    this.selectSegmentAt(timelineTime);
    this.seekTo(timelineTime);
    event.preventDefault();
  }

  private clampedPlaybackTime(value: number): number {
    return clamp(value, zeroSeconds, this.editedDurationSeconds());
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
    return Math.min(progress * this.durationSeconds, this.editedDurationSeconds());
  }

  private selectSegmentAt(timelineTime: number): void {
    this.selectedSegmentId = timelineLocationAt(this.timelineSegments, timelineTime).segment.id;
    this.renderTimelineSegments();
  }

  private timelineTimeForSegmentSourceTime(segmentId: number, sourceTime: number): number {
    const segment = timelineSegmentById(this.timelineSegments, segmentId);
    const { timelineStart } = timelineSegmentBounds(this.timelineSegments, segmentId);
    return timelineStart + clamp(sourceTime, segment.sourceStart, segment.sourceEnd) - segment.sourceStart;
  }

  private cutAtPlayhead(): void {
    if (this.isInteractionLocked) {
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
    if (this.isInteractionLocked || this.selectedSegmentId === null) {
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
    this.playheadSeconds = timelineTimeAfterDeletion(this.playheadSeconds, deletedRange);

    const nextSelectedIndex = Math.min(selectedSegmentIndex, this.timelineSegments.length - 1);
    this.selectedSegmentId = this.timelineSegments[nextSelectedIndex]?.id ?? null;
    this.activeSegmentId = null;
    this.preparedVideo = null;
    this.syncTimeline();
    this.animateTimelineDeletion(previousSegmentRects, removingElement);
    this.seekTo(this.playheadSeconds);
    this.showStatus("Segment deleted");
  }

  private async copyVideo(): Promise<void> {
    if (this.isInteractionLocked) {
      return;
    }

    this.setBusy(true);
    try {
      const preparedVideo = await this.preparedVideoForCurrentEdit();
      await getSoftshotApi().copyPreparedEditorVideo(preparedVideo.filePath);
      this.showStatus("Copied");
    } finally {
      this.setBusy(false);
    }
  }

  private async createPreparedVideo(key: string, sourceRanges: readonly TrimRange[]): Promise<PreparedVideo> {
    const singleSourceRange = sourceRanges.length === 1 ? sourceRanges[0] : null;
    if (this.mutedAudioKinds.size === 0
      && singleSourceRange
      && singleSourceRange.start <= fullSourceRangeToleranceSeconds) {
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

  private endTimelineInteraction(event: PointerEvent): void {
    if (this.activeTimelineResize?.pointerId === event.pointerId) {
      this.endTimelineResize(event);
      return;
    }

    if (this.activeTimelineMove?.pointerId === event.pointerId) {
      this.endTimelineMove(event);
      return;
    }

    this.endTimelineScrub(event);
  }

  private endTimelineMove(event: PointerEvent): void {
    const move = this.activeTimelineMove;
    if (move?.pointerId !== event.pointerId) {
      return;
    }

    this.activeTimelineMove = null;
    this.timeline.classList.remove("moving-clip");
    if (this.timelineTrack.hasPointerCapture(event.pointerId)) {
      this.timelineTrack.releasePointerCapture(event.pointerId);
    }

    this.renderTimelineSegments();
    if (move.hasMoved) {
      this.showStatus("Clip moved");
    }

    event.preventDefault();
  }

  private endTimelineResize(event: PointerEvent): void {
    const resize = this.activeTimelineResize;
    if (resize?.pointerId !== event.pointerId) {
      return;
    }

    const previousSegmentRects = this.timelineSegmentRects();
    this.activeTimelineResize = null;
    this.timeline.classList.remove("resizing-clip");
    if (this.timelineTrack.hasPointerCapture(event.pointerId)) {
      this.timelineTrack.releasePointerCapture(event.pointerId);
    }

    this.syncTimeline();
    this.animateTimelineReflow(previousSegmentRects);
    this.seekTo(this.playheadSeconds);
    if (resize.hasChanged) {
      this.showStatus("Clip trimmed");
    }

    event.preventDefault();
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
    this.showStatus(`${encoderLabel}, ${pipelineLabel}`);
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

  private async loadTimelineThumbnails(): Promise<void> {
    const trackWidth = this.timelineTrack.getBoundingClientRect().width;
    const widthBasedCount = Math.ceil(trackWidth / timelineThumbnailTargetWidthPx);
    const durationBasedCount = Math.ceil(this.durationSeconds / timelineThumbnailMinimumIntervalSeconds);
    const thumbnailCount = Math.max(
      1,
      Math.min(timelineThumbnailMaximumCount, widthBasedCount, durationBasedCount)
    );
    const thumbnails = await captureVideoTimelineThumbnails(
      this.sourceUrl,
      this.durationSeconds,
      thumbnailCount,
      timelineThumbnailImageWidthPx
    );
    if (this.isClosing) {
      releaseTimelineThumbnailUrls(thumbnails);
      return;
    }

    this.releaseTimelineThumbnails();
    this.timelineThumbnails = thumbnails;
    this.renderTimelineSegments();
  }

  private async preparedVideoForCurrentEdit(): Promise<PreparedVideo> {
    const key = this.editKey();
    if (this.preparedVideo?.key === key) {
      return this.preparedVideo;
    }

    const preparedVideo = await this.createPreparedVideo(key, this.sourceRangesForExport());
    if (key === this.editKey()) {
      this.preparedVideo = preparedVideo;
    }

    return preparedVideo;
  }

  private releaseTimelineThumbnails(): void {
    releaseTimelineThumbnailUrls(this.timelineThumbnails);
    this.timelineThumbnails = [];
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

    const waveformWidth = `${String(percentOf(this.editedDurationSeconds(), this.durationSeconds))}%`;
    for (const canvas of this.audioTracksElement.querySelectorAll<HTMLCanvasElement>("canvas[data-audio-kind]")) {
      const kind = audioSourceKindFromString(canvas.dataset.audioKind);
      if (this.audioTracks.every((candidate) => candidate.kind !== kind)) {
        throw new Error("The audio waveform track is missing.");
      }

      const waveformPeaks = this.audioWaveformsByKind.get(kind);
      if (!waveformPeaks) {
        throw new Error("The audio waveform data is missing.");
      }

      canvas.style.width = waveformWidth;
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
    if (this.isInteractionLocked) {
      return;
    }

    this.setBusy(true);
    try {
      const result = await getSoftshotApi().chooseEditorVideoSavePath();
      if (!result.filePath) {
        return;
      }

      const preparedVideo = await this.preparedVideoForCurrentEdit();
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
        element.append(
          timelineThumbnailStrip(),
          timelineResizeHandle(segment.id, "start"),
          timelineResizeHandle(segment.id, "end")
        );
        this.timelineSegmentElements.set(segment.id, element);
      }

      const segmentDuration = timelineSegmentDuration(segment);
      const isSelected = segment.id === this.selectedSegmentId;
      const isMoving = segment.id === this.activeTimelineMove?.segmentId && this.activeTimelineMove.isDragging;
      renderedSegmentIds.add(segment.id);
      element.disabled = this.isBusy;
      element.setAttribute("aria-label", `Select section ${String(segmentIndex + 1)}`);
      element.setAttribute("aria-pressed", String(isSelected));
      if (this.canReorderTimelineSegments) {
        element.dataset.tooltip = "Drag to reorder";
      } else {
        delete element.dataset.tooltip;
      }

      element.classList.toggle("reorderable", this.canReorderTimelineSegments);
      element.classList.toggle("moving", isMoving);
      element.classList.toggle("selected", isSelected);
      this.renderTimelineSegmentThumbnails(element, segment);
      const visualOffset = this.activeStartResizeVisualOffsetSeconds(segmentIndex);
      element.style.left = `${String(percentOf(timelineStart + visualOffset, this.durationSeconds))}%`;
      element.style.width = `${String(percentOf(segmentDuration, this.durationSeconds))}%`;
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

  private renderTimelineSegmentThumbnails(element: HTMLButtonElement, segment: TimelineSegment): void {
    const strip = element.querySelector<HTMLElement>(".timeline-segment-thumbnails");
    if (!strip) {
      throw new Error("The timeline clip preview strip is missing.");
    }

    const thumbnails = timelineThumbnailsForSegment(this.timelineThumbnails, segment);
    const thumbnailKey = thumbnails.map((thumbnail) => thumbnail.url).join("|");
    if (strip.dataset.thumbnailKey === thumbnailKey) {
      return;
    }

    strip.dataset.thumbnailKey = thumbnailKey;
    strip.replaceChildren(...thumbnails.map((thumbnail) => timelineThumbnailImage(thumbnail.url)));
  }

  private activeStartResizeVisualOffsetSeconds(segmentIndex: number): number {
    const resize = this.activeTimelineResize;
    if (resize?.edge !== "start") {
      return zeroSeconds;
    }

    const resizedSegmentIndex = this.timelineSegments.findIndex((segment) => segment.id === resize.segmentId);
    if (segmentIndex < resizedSegmentIndex) {
      return zeroSeconds;
    }

    const initialSegment = timelineSegmentById(resize.initialSegments, resize.segmentId);
    const currentSegment = timelineSegmentById(this.timelineSegments, resize.segmentId);
    return currentSegment.sourceStart - initialSegment.sourceStart;
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
    this.animateTimelineReflow(previousSegmentRects);
    if (matchMedia(reducedMotionMediaQuery).matches) {
      return;
    }

    removingElement.classList.add("timeline-segment-removing");
    removingElement.disabled = true;
    removingElement.setAttribute(ariaHiddenAttributeName, "true");
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

  private animateTimelineReflow(previousSegmentRects: ReadonlyMap<number, DOMRect>): void {
    if (matchMedia(reducedMotionMediaQuery).matches) {
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
  }

  private syncPlaybackTime(): void {
    const location = this.activePlaybackLocation();
    const sourceTime = clamp(this.video.currentTime, location.segment.sourceStart, location.segment.sourceEnd);
    const timelineTime = location.timelineStart + sourceTime - location.segment.sourceStart;
    let currentTime = this.clampedPlaybackTime(timelineTime);

    if (!this.video.paused) {
      const editedDuration = this.editedDurationSeconds();
      if (timelineTime >= editedDuration - playbackBoundaryToleranceSeconds) {
        currentTime = editedDuration;
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
    const visualOffset = this.activeStartResizeVisualOffsetSeconds(location.segmentIndex);
    const visualPlayheadTime = currentTime + visualOffset;
    this.timeline.style.setProperty("--playhead", `${String(percentOf(visualPlayheadTime, this.durationSeconds))}%`);
    this.syncPlayButton();
  }

  private syncTimeline(): void {
    const editedDuration = this.editedDurationSeconds();
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
    if (this.isInteractionLocked) {
      return;
    }

    if (!this.video.paused) {
      this.video.pause();
      return;
    }

    if (this.playheadSeconds >= this.editedDurationSeconds()) {
      this.seekTo(zeroSeconds);
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

  private updateTimelineInteraction(event: PointerEvent): void {
    if (this.activeTimelineResize?.pointerId === event.pointerId) {
      this.updateTimelineResize(event);
      return;
    }

    if (this.activeTimelineMove?.pointerId === event.pointerId) {
      this.updateTimelineMove(event);
      return;
    }

    this.updateTimelineScrub(event);
  }

  private updateTimelineMove(event: PointerEvent): void {
    const move = this.activeTimelineMove;
    if (move?.pointerId !== event.pointerId) {
      return;
    }

    if (!move.isDragging) {
      if (Math.abs(event.clientX - move.initialClientX) < timelineMoveThresholdPx) {
        return;
      }

      move.isDragging = true;
      this.timeline.classList.add("moving-clip");
      this.renderTimelineSegments();
    }

    const targetIndex = this.timelineMoveTargetIndex(event.clientX, move.segmentId);
    const segments = moveTimelineSegment(this.timelineSegments, move.segmentId, targetIndex);
    if (isSameTimelineSegmentOrder(segments, this.timelineSegments)) {
      event.preventDefault();
      return;
    }

    const previousSegmentRects = this.timelineSegmentRects();
    this.timelineSegments = segments;
    move.hasMoved = true;
    this.preparedVideo = null;
    this.syncTimeline();
    this.animateTimelineReflow(previousSegmentRects);
    this.seekTo(this.timelineTimeForSegmentSourceTime(move.playbackSegmentId, move.playbackSourceTime));
    event.preventDefault();
  }

  private timelineMoveTargetIndex(clientX: number, segmentId: number): number {
    let targetIndex = 0;
    for (const segment of this.timelineSegments) {
      if (segment.id === segmentId) {
        continue;
      }

      const element = this.timelineSegmentElements.get(segment.id);
      if (!element) {
        throw new Error("A timeline clip is not rendered.");
      }

      const bounds = element.getBoundingClientRect();
      if (clientX < bounds.left + bounds.width / halfDivisor) {
        return targetIndex;
      }

      targetIndex += 1;
    }

    return targetIndex;
  }

  private updateTimelineResize(event: PointerEvent): void {
    const resize = this.activeTimelineResize;
    if (resize?.pointerId !== event.pointerId) {
      return;
    }

    const initialSegment = timelineSegmentById(resize.initialSegments, resize.segmentId);
    const initialEdgeTime = timelineSegmentEdgeTime(initialSegment, resize.edge);
    const sourceTimeDelta = ((event.clientX - resize.initialClientX) / resize.initialTrackWidth) * this.durationSeconds;
    const segments = resizeTimelineSegment(
      resize.initialSegments,
      resize.segmentId,
      resize.edge,
      initialEdgeTime + sourceTimeDelta,
      minimumTrimDurationSeconds,
      this.durationSeconds
    );
    const resizedSegment = timelineSegmentById(segments, resize.segmentId);
    resize.hasChanged = Math.abs(timelineSegmentEdgeTime(resizedSegment, resize.edge) - initialEdgeTime) > Number.EPSILON;
    this.timelineSegments = segments;
    this.preparedVideo = null;
    this.syncTimeline();
    this.seekTo(this.timelineTimeForSegmentSourceTime(resize.playbackSegmentId, resize.playbackSourceTime));
    event.preventDefault();
  }

  private updateTimelineScrub(event: PointerEvent): void {
    if (this.activeTimelinePointerId !== event.pointerId) {
      return;
    }

    this.seekToTimelinePoint(event.clientX);
  }

  private isFullSourceRange(sourceRange: TrimRange): boolean {
    return sourceRange.start <= fullSourceRangeToleranceSeconds
      && Math.abs(sourceRange.end - this.durationSeconds) <= fullSourceRangeToleranceSeconds;
  }

  private editKey(): string {
    return `${this.timelineKey()}:${this.audioExportKey()}`;
  }

  private timelineKey(): string {
    return this.timelineSegments
      .map((segment) => `${String(segment.id)}=${segment.sourceStart.toFixed(timelineKeyPrecisionDigits)}-${segment.sourceEnd.toFixed(timelineKeyPrecisionDigits)}`)
      .join(",");
  }

  private sourceRangesForExport(): TrimRange[] {
    return sourceRangesForTimeline(this.timelineSegments);
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
      this.syncTimeline();
      this.syncPlaybackTime();
      this.runAsync(this.loadTimelineThumbnails(), "Could not load timeline previews.");
    } catch (error) {
      try {
        await reportError("Could not open the editor.", error);
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

function timelineResizeHandle(segmentId: number, edge: TimelineSegmentEdge): HTMLSpanElement {
  const handle = document.createElement("span");
  handle.className = `timeline-segment-handle timeline-segment-handle-${edge}`;
  handle.dataset.segmentId = String(segmentId);
  handle.dataset.timelineEdge = edge;
  handle.setAttribute(ariaHiddenAttributeName, "true");
  return handle;
}

function timelineThumbnailImage(sourceUrl: string): HTMLImageElement {
  const image = document.createElement("img");
  image.alt = "";
  image.className = "timeline-segment-thumbnail";
  image.draggable = false;
  image.src = sourceUrl;
  return image;
}

function timelineThumbnailStrip(): HTMLSpanElement {
  const strip = document.createElement("span");
  strip.className = "timeline-segment-thumbnails";
  strip.setAttribute(ariaHiddenAttributeName, "true");
  return strip;
}

function isSameTimelineSegmentOrder(
  leftSegments: readonly TimelineSegment[],
  rightSegments: readonly TimelineSegment[]
): boolean {
  return leftSegments.length === rightSegments.length
    && leftSegments.every((segment, index) => segment.id === rightSegments[index]?.id);
}

function timelineSegmentById(segments: readonly TimelineSegment[], segmentId: number): TimelineSegment {
  const segment = segments.find((candidate) => candidate.id === segmentId);
  if (!segment) {
    throw new Error("The requested timeline clip no longer exists.");
  }

  return segment;
}

function timelineSegmentEdgeFromString(value: string | undefined): TimelineSegmentEdge {
  if (value === "start" || value === "end") {
    return value;
  }

  throw new Error("Unexpected timeline clip edge.");
}

function timelineSegmentEdgeTime(segment: TimelineSegment, edge: TimelineSegmentEdge): number {
  return edge === "start" ? segment.sourceStart : segment.sourceEnd;
}

function timelineSegmentIdFromString(value: string | undefined): number {
  const segmentId = Number(value);
  if (!Number.isSafeInteger(segmentId) || segmentId <= 0) {
    throw new Error("Unexpected timeline clip identifier.");
  }

  return segmentId;
}

async function waitForAudioReady(audioReadyPromises: Array<Promise<void>>): Promise<void> {
  await Promise.all(audioReadyPromises);
}

const editorApp = new VideoEditorApp();
await editorApp.initialize();
