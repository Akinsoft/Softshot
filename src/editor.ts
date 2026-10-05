import { audioAnalyzerFftSize, audioLevelFromTimeDomainSamples } from "./audio-level.js";
import { audioMixGain, recordingAudioSampleRate } from "./audio-quality.js";
import { audioWaveformPeaks } from "./audio-waveform.js";
import { type ExportAudioTrack, exportEditedVideo, type ExportedVideo, type TrimRange } from "./editor-export.js";
import {
  captureVideoTimelineThumbnails,
  releaseTimelineThumbnailUrls,
  timelineFilmstrip,
  type TimelineThumbnail
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
  timelineSegmentById,
  timelineSegmentDuration,
  type TimelineSegmentEdge,
  timelineTimeAfterDeletion
} from "./editor-timeline.js";
import { drawTimelineWaveform } from "./editor-waveform-view.js";
import { playMedia, waitForMediaMetadata } from "./media-element.js";
import { getRequiredElement } from "./overlay-dom.js";
import type { AudioSourceKind, EditorAudioTrack, EditorBootstrap, EditorSource, PreparedVideoFile } from "./shared.js";
import { isAudioSourceKind, videoFpsOptions } from "./shared.js";
import { getSoftshotApi, reportAsyncError, reportError } from "./softshot-api.js";
import { setTooltipLabel, TooltipController } from "./ui-tooltip.js";

const defaultMimeType = "video/webm";
const audioLevelCssProperty = "--audio-level";
const audioWaveformPeakCount = 16_384;
const minimumTrimDurationSeconds = 0.05;
const halfDivisor = 2;
const fullSourceRangeToleranceSeconds = 0.005;
const playbackBoundaryToleranceSeconds = fullSourceRangeToleranceSeconds;
const timelineMoveThresholdPx = 6;
const snapDistancePx = 8;
const snapToleranceSeconds = 1e-6;
const filmstripTileMinimumAspect = 0.5;
const filmstripTileMaximumAspect = 2.5;
const filmstripTileWidthCssProperty = "--filmstrip-tile-width";
const timelineThumbnailMaximumCount = 240;
const thumbnailRequestDelayMs = 250;
const timelineZoomStep = 1.5;
const timelineZoomWheelSensitivity = 0.0015;
const timelineZoomEpsilon = 0.001;
const timelineZoomSliderSteps = 1000;
const maximumCanvasDimensionPx = 32_767;
const canvasDimensionSafetyRatio = 0.9;
const maximumTimelinePixelsPerSecond = 400;
const playheadFollowMarginRatio = 0.1;
const autoScrollEdgePx = 48;
const autoScrollMaximumStepPx = 18;
const timelineThumbnailMinimumImageWidthPx = 64;
const timelineThumbnailMaximumImageWidthPx = 320;
const rulerLabelEndClearancePx = 30;
const rulerLargestSecondStep = 20;
const rulerMajorMinimumSpacingPx = 72;
const rulerMinorDivisions = 5;
const rulerMinorMinimumSpacingPx = 8;
const rulerStepBase = 10;
const rulerStepDouble = 2;
const rulerStepHalfDecade = 5;
const rulerStepMultipliers = [1, rulerStepDouble, rulerStepHalfDecade];
const largeStepSeconds = 1;
const secondsPerMinute = 60;
const secondsTextLength = 5;
const spaceKey = " ";
const backspaceKey = "backspace";
const cutKey = "c";
const endKey = "end";
const escapeKey = "escape";
const handKey = "b";
const homeKey = "home";
const keyboardDeleteKey = "delete";
const nextFrameKey = "arrowright";
const previousFrameKey = "arrowleft";
const redoKey = "y";
const snapKey = "n";
const undoKey = "z";
const zoomFitKey = "\\";
const zoomInKey = "=";
const zoomInShiftedKey = "+";
const zoomOutKey = "-";
const audioMuteButtonSelector = "button[data-audio-kind]";
const audioVolumeInputSelector = "input[data-audio-kind]";
const defaultAudioVolume = 1;
const maximumAudioVolumePercent = 200;
const volumePercentScale = 100;
const clipDurationPrecisionDigits = 1;
const initialSegmentId = 1;
const timePartLength = 2;
const timePrecisionDigits = 2;
const timelineKeyPrecisionDigits = 3;
const timelinePercent = 100;
const trimToleranceSeconds = 0.04;
const transientStatusDurationMs = 1400;
const timelineReflowDurationMs = 220;
const timelineReflowEasing = "cubic-bezier(0.22, 1, 0.36, 1)";
const timelineReflowAnimationId = "timeline-reflow";
const timelineClipRemovingClassName = "timeline-clip-removing";
const movingClipClassName = "moving";
const zeroSeconds = 0;
const noPointerId = -1;
const ariaHiddenAttributeName = "aria-hidden";
const ariaPressedAttributeName = "aria-pressed";
const reducedMotionMediaQuery = "(prefers-reduced-motion: reduce)";
const audioTrackLabels: Record<AudioSourceKind, string> = {
  clip: "Audio",
  microphone: "Mic",
  system: "Desktop"
};
const audioTrackIcons: Record<AudioSourceKind, () => string> = {
  clip: clipTrackIcon,
  microphone: microphoneTrackIcon,
  system: desktopTrackIcon
};

interface PreparedVideo {
  filePath: string;
  key: string;
}

interface KeyboardCommand {
  allowRepeat: boolean;
  run: (event: KeyboardEvent) => void;
}

interface FilmstripScale {
  pixelsPerSecond: number;
  tileDurationSeconds: number;
}

interface CutPosition {
  offsetX: number;
  timelineTime: number;
}

type TimelineTool = "cut" | "hand";

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
  initialEdgePx: number;
  initialPointerOffsetPx: number;
  initialSegments: TimelineSegment[];
  initialTrackWidth: number;
  playbackSegmentId: number;
  playbackSourceTime: number;
  pointerId: number;
  segmentId: number;
  snapTargetsPx: number[];
}

interface TimelineMove {
  grabOffsetPx: number;
  hasMoved: boolean;
  initialClientX: number;
  initialSegments: TimelineSegment[];
  isDragging: boolean;
  pointerClientX: number;
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
  private readonly audioTrackHeadersElement = getRequiredElement("audio-track-headers", HTMLDivElement);
  private readonly audioTracksElement = getRequiredElement("audio-tracks", HTMLElement);
  private readonly clipDeleteButton = getRequiredElement("delete-clip-button", HTMLButtonElement);
  private readonly handButton = getRequiredElement("hand-button", HTMLButtonElement);
  private readonly jumpEndButton = getRequiredElement("jump-end-button", HTMLButtonElement);
  private readonly jumpStartButton = getRequiredElement("jump-start-button", HTMLButtonElement);
  private readonly playButton = getRequiredElement("play-button", HTMLButtonElement);
  private readonly redoButton = getRequiredElement("redo-button", HTMLButtonElement);
  private readonly saveButton = getRequiredElement("editor-save-button", HTMLButtonElement);
  private readonly snapButton = getRequiredElement("snap-button", HTMLButtonElement);
  private readonly statusText = getRequiredElement("editor-status", HTMLSpanElement);
  private readonly stepBackButton = getRequiredElement("step-back-button", HTMLButtonElement);
  private readonly stepForwardButton = getRequiredElement("step-forward-button", HTMLButtonElement);
  private readonly timeline = getRequiredElement("timeline", HTMLDivElement);
  private readonly timelineResizeObserver = new ResizeObserver((): void => {
    this.renderTimelineLayout();
  });
  private readonly timelineCutIndicator = getRequiredElement("timeline-cut-indicator", HTMLDivElement);
  private readonly timelineCutTime = getRequiredElement("timeline-cut-time", HTMLSpanElement);
  private readonly timelineRuler = getRequiredElement("timeline-ruler", HTMLDivElement);
  private readonly timelineSnapIndicator = getRequiredElement("timeline-snap-indicator", HTMLDivElement);
  private readonly timelineTrack = getRequiredElement("timeline-track", HTMLDivElement);
  private readonly timelineSegmentsElement = getRequiredElement("timeline-segments", HTMLDivElement);
  private readonly totalTimeText = getRequiredElement("total-time", HTMLSpanElement);
  private readonly tooltips = new TooltipController(document.body);
  private readonly undoButton = getRequiredElement("undo-button", HTMLButtonElement);
  private readonly previewArea = getRequiredElement("preview-area", HTMLElement);
  private readonly videoLane = getRequiredElement("video-lane", HTMLDivElement);
  private readonly videoTrackToggle = getRequiredElement("video-track-toggle", HTMLButtonElement);
  private readonly zoomFitButton = getRequiredElement("zoom-fit-button", HTMLButtonElement);
  private readonly zoomInButton = getRequiredElement("zoom-in-button", HTMLButtonElement);
  private readonly zoomOutButton = getRequiredElement("zoom-out-button", HTMLButtonElement);
  private readonly zoomSlider = getRequiredElement("zoom-slider", HTMLInputElement);
  private readonly video = getRequiredElement("editor-video", HTMLVideoElement);
  private activeTimelineMove: TimelineMove | null = null;
  private activeTimelinePointerId = noPointerId;
  private activeTimelineResize: TimelineResize | null = null;
  private audioMeterFrame: number | null = null;
  private audioPreviewContext: AudioContext | null = null;
  private audioReady: Promise<void> = Promise.resolve();
  private audioTracks: EditorAudioTrack[] = [];
  private readonly audioWaveformsByKind = new Map<AudioSourceKind, number[]>();
  private readonly audioVolumesByKind = new Map<AudioSourceKind, number>();
  private hasLoadedAudioWaveforms = false;
  private readonly audioElementsByKind = new Map<AudioSourceKind, HTMLAudioElement>();
  private readonly audioMetersByKind = new Map<AudioSourceKind, AudioMeter>();
  private durationSeconds = zeroSeconds;
  private filmstripTileWidthPx = 0;
  private fps: number = videoFpsOptions.high;
  private isBusy = false;
  private isClosing = false;
  private mimeType = defaultMimeType;
  private playbackFrameHandle: number | null = null;
  private playheadSeconds = zeroSeconds;
  private preparedVideo: PreparedVideo | null = null;
  private selectedSegmentId: number | null = null;
  private canReuseSourceFile = false;
  private sourceFilePath = "";
  private sourceUrl = "";
  private statusHandle: ReturnType<typeof setTimeout> | null = null;
  private activeSegmentId: number | null = null;
  private nextSegmentId = initialSegmentId + 1;
  private readonly timelineSegmentElements = new Map<number, HTMLButtonElement>();
  private readonly audioClipElementsByKind = new Map<AudioSourceKind, Map<number, HTMLDivElement>>();
  private readonly audioLaneElementsByKind = new Map<AudioSourceKind, HTMLElement>();
  private timelineSegments: TimelineSegment[] = [];
  private timelineThumbnails: TimelineThumbnail[] = [];
  private timelineTool: TimelineTool = "hand";
  private isSnappingEnabled = true;
  private isVideoTrackVisible = true;
  private timelineZoom = 1;
  private isCapturingThumbnails = false;
  private hasPendingThumbnailRequest = false;
  private thumbnailRequestHandle: ReturnType<typeof setTimeout> | null = null;
  private rulerFrameHandle: number | null = null;
  private autoScrollFrameHandle: number | null = null;
  private lastTimelinePointerClientX = 0;
  private readonly mutedAudioKinds = new Set<AudioSourceKind>();
  private readonly redoStack: TimelineSegment[][] = [];
  private readonly undoStack: TimelineSegment[][] = [];
  private readonly keyboardCommands = new Map<string, KeyboardCommand>([
    [spaceKey, { allowRepeat: false, run: (): void => {
      this.runAsync(this.togglePlayback(), "Could not preview the recording.");
    } }],
    [cutKey, { allowRepeat: false, run: (): void => {
      this.setTimelineTool("cut");
    } }],
    [handKey, { allowRepeat: false, run: (): void => {
      this.setTimelineTool("hand");
    } }],
    [escapeKey, { allowRepeat: false, run: (): void => {
      this.setTimelineTool("hand");
    } }],
    [snapKey, { allowRepeat: false, run: (): void => {
      this.toggleSnapping();
    } }],
    [zoomInKey, { allowRepeat: true, run: (): void => {
      this.setTimelineZoom(this.timelineZoom * timelineZoomStep, null);
    } }],
    [zoomInShiftedKey, { allowRepeat: true, run: (): void => {
      this.setTimelineZoom(this.timelineZoom * timelineZoomStep, null);
    } }],
    [zoomOutKey, { allowRepeat: true, run: (): void => {
      this.setTimelineZoom(this.timelineZoom / timelineZoomStep, null);
    } }],
    [zoomFitKey, { allowRepeat: false, run: (): void => {
      this.setTimelineZoom(1, null);
    } }],
    [keyboardDeleteKey, { allowRepeat: false, run: (): void => {
      this.deleteSelectedSegmentSafely();
    } }],
    [backspaceKey, { allowRepeat: false, run: (): void => {
      this.deleteSelectedSegmentSafely();
    } }],
    [homeKey, { allowRepeat: false, run: (): void => {
      this.jumpTo(zeroSeconds);
    } }],
    [endKey, { allowRepeat: false, run: (): void => {
      this.jumpTo(this.editedDurationSeconds());
    } }],
    [previousFrameKey, { allowRepeat: true, run: (event): void => {
      this.stepPlayhead(-this.keyboardStepSeconds(event));
    } }],
    [nextFrameKey, { allowRepeat: true, run: (event): void => {
      this.stepPlayhead(this.keyboardStepSeconds(event));
    } }]
  ]);

  private bindEvents(): void {
    this.tooltips.bind();
    this.bindKeyboardEvents();
    this.bindControlEvents();
    this.timelineResizeObserver.observe(this.timelineTrack);
    this.closeButton.addEventListener("click", (): void => {
      this.runAsync(this.closeEditor(), "Could not close the editor.");
    });
    this.copyButton.addEventListener("click", (): void => {
      this.runAsync(this.copyVideo(), "Could not copy the recording.");
    });
    this.saveButton.addEventListener("click", (): void => {
      this.runAsync(this.saveVideo(), "Could not save the recording.");
    });
    this.audioTrackHeadersElement.addEventListener("click", (event): void => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>(audioMuteButtonSelector);
      if (!button) {
        return;
      }

      this.toggleAudioTrackMute(audioSourceKindFromString(button.dataset.audioKind));
    });
    this.audioTrackHeadersElement.addEventListener("input", (event): void => {
      const input = event.target instanceof Element ? event.target.closest<HTMLInputElement>(audioVolumeInputSelector) : null;
      if (input) {
        this.setAudioTrackVolume(audioSourceKindFromString(input.dataset.audioKind), Number(input.value) / volumePercentScale);
      }
    });
    this.audioTrackHeadersElement.addEventListener("dblclick", (event): void => {
      const input = event.target instanceof Element ? event.target.closest<HTMLInputElement>(audioVolumeInputSelector) : null;
      if (input) {
        this.setAudioTrackVolume(audioSourceKindFromString(input.dataset.audioKind), defaultAudioVolume);
      }
    });
    this.timelineTrack.addEventListener("pointerdown", (event): void => {
      this.beginTimelineInteraction(event);
    });
    this.timelineTrack.addEventListener("pointermove", (event): void => {
      this.updateTimelineInteraction(event);
      this.updateCutIndicator(event);
    });
    this.timelineTrack.addEventListener("pointerleave", (): void => {
      this.hideCutIndicator();
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

  private bindControlEvents(): void {
    this.undoButton.addEventListener("click", (): void => {
      this.undoTimelineEdit();
    });
    this.redoButton.addEventListener("click", (): void => {
      this.redoTimelineEdit();
    });
    this.handButton.addEventListener("click", (): void => {
      this.setTimelineTool("hand");
    });
    this.cutButton.addEventListener("click", (): void => {
      this.setTimelineTool("cut");
    });
    this.snapButton.addEventListener("click", (): void => {
      this.toggleSnapping();
    });
    this.videoTrackToggle.addEventListener("click", (): void => {
      this.toggleVideoTrack();
    });
    this.zoomInButton.addEventListener("click", (): void => {
      this.setTimelineZoom(this.timelineZoom * timelineZoomStep, null);
    });
    this.zoomOutButton.addEventListener("click", (): void => {
      this.setTimelineZoom(this.timelineZoom / timelineZoomStep, null);
    });
    this.zoomFitButton.addEventListener("click", (): void => {
      this.setTimelineZoom(1, null);
    });
    this.zoomSlider.addEventListener("input", (): void => {
      const progress = Number(this.zoomSlider.value) / timelineZoomSliderSteps;
      this.setTimelineZoom(this.maximumTimelineZoom() ** progress, null);
    });
    this.timeline.addEventListener("wheel", (event): void => {
      this.handleTimelineWheel(event);
    }, { passive: false });
    this.timeline.addEventListener("scroll", (): void => {
      this.scheduleRulerRender();
    });
    this.clipDeleteButton.addEventListener("click", (): void => {
      this.deleteSelectedSegmentSafely();
    });
    this.jumpStartButton.addEventListener("click", (): void => {
      this.jumpTo(zeroSeconds);
    });
    this.stepBackButton.addEventListener("click", (): void => {
      this.stepPlayhead(-this.frameDurationSeconds());
    });
    this.playButton.addEventListener("click", (): void => {
      this.runAsync(this.togglePlayback(), "Could not preview the recording.");
    });
    this.stepForwardButton.addEventListener("click", (): void => {
      this.stepPlayhead(this.frameDurationSeconds());
    });
    this.jumpEndButton.addEventListener("click", (): void => {
      this.jumpTo(this.editedDurationSeconds());
    });
  }

  private bindKeyboardEvents(): void {
    addEventListener("keydown", (event): void => {
      const command = this.keyboardCommand(event);
      if (!command) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      this.blurFocusedElement();
      if (!event.repeat || command.allowRepeat) {
        command.run(event);
      }
    }, { capture: true });
  }

  private keyboardCommand(event: KeyboardEvent): KeyboardCommand | null {
    const key = event.key.toLowerCase();
    if (event.altKey) {
      return null;
    }

    if (event.ctrlKey || event.metaKey) {
      return this.historyKeyboardCommand(key, event.shiftKey);
    }

    return this.keyboardCommands.get(key) ?? null;
  }

  private historyKeyboardCommand(key: string, isShiftPressed: boolean): KeyboardCommand | null {
    if (key === redoKey || (key === undoKey && isShiftPressed)) {
      return { allowRepeat: false, run: (): void => {
        this.redoTimelineEdit();
      } };
    }

    if (key === undoKey) {
      return { allowRepeat: false, run: (): void => {
        this.undoTimelineEdit();
      } };
    }

    return null;
  }

  private keyboardStepSeconds(event: KeyboardEvent): number {
    return event.shiftKey ? largeStepSeconds : this.frameDurationSeconds();
  }

  private frameDurationSeconds(): number {
    return 1 / this.fps;
  }

  private jumpTo(timelineTime: number): void {
    if (this.isInteractionLocked) {
      return;
    }

    this.video.pause();
    this.seekTo(timelineTime);
    this.ensurePlayheadVisible();
  }

  private stepPlayhead(deltaSeconds: number): void {
    this.jumpTo(this.playheadSeconds + deltaSeconds);
  }

  private setTimelineTool(tool: TimelineTool): void {
    if (this.timelineTool === tool) {
      return;
    }

    this.timelineTool = tool;
    this.timeline.dataset.tool = tool;
    this.handButton.setAttribute(ariaPressedAttributeName, String(tool === "hand"));
    this.cutButton.setAttribute(ariaPressedAttributeName, String(tool === "cut"));
    this.hideCutIndicator();
    this.renderTimelineSegments();
    if (tool === "cut") {
      this.showStatus("Click a clip to cut it");
    }
  }

  private timelineBaseWidthPx(): number {
    return this.timelineTrack.clientWidth / this.timelineZoom;
  }

  private maximumTimelineZoom(): number {
    const baseWidthPx = this.timelineBaseWidthPx();
    if (baseWidthPx <= 0) {
      return 1;
    }

    const canvasLimitedWidthPx = (maximumCanvasDimensionPx * canvasDimensionSafetyRatio) / window.devicePixelRatio;
    const detailLimitedWidthPx = maximumTimelinePixelsPerSecond * this.durationSeconds;
    return Math.max(1, Math.min(canvasLimitedWidthPx, detailLimitedWidthPx) / baseWidthPx);
  }

  private setTimelineZoom(requestedZoom: number, anchorClientX: number | null): void {
    if (this.hasActiveTimelineDrag()) {
      return;
    }

    const baseWidthPx = this.timelineBaseWidthPx();
    const zoom = clamp(requestedZoom, 1, this.maximumTimelineZoom());
    if (baseWidthPx <= 0 || Math.abs(zoom - this.timelineZoom) < timelineZoomEpsilon) {
      this.syncZoomControls();
      return;
    }

    const trackBounds = this.timelineTrackBounds();
    const anchorX = anchorClientX ?? this.timelineZoomAnchorClientX(trackBounds);
    const anchorProgress = clamp((anchorX - trackBounds.left) / trackBounds.width, zeroSeconds, 1);
    const anchorOffsetPx = anchorX - this.timeline.getBoundingClientRect().left;
    this.timelineZoom = zoom;
    this.timelineTrack.style.width = `${String(zoom * timelinePercent)}%`;
    this.timeline.scrollLeft = this.timelineTrack.offsetLeft + anchorProgress * baseWidthPx * zoom - anchorOffsetPx;
    this.syncZoomControls();
  }

  private timelineZoomAnchorClientX(trackBounds: DOMRect): number {
    const viewport = this.timeline.getBoundingClientRect();
    const playheadClientX = trackBounds.left + (this.playheadSeconds / this.durationSeconds) * trackBounds.width;
    return playheadClientX >= viewport.left && playheadClientX <= viewport.right
      ? playheadClientX
      : viewport.left + viewport.width / halfDivisor;
  }

  private syncZoomControls(): void {
    const maximumZoom = this.maximumTimelineZoom();
    const progress = maximumZoom > 1 ? Math.log(this.timelineZoom) / Math.log(maximumZoom) : 0;
    const sliderValue = Math.round(clamp(progress, 0, 1) * timelineZoomSliderSteps);
    this.zoomSlider.value = String(sliderValue);
    this.zoomSlider.style.setProperty("--range-fill", `${String((sliderValue / timelineZoomSliderSteps) * timelinePercent)}%`);
    this.zoomInButton.disabled = this.isBusy || this.timelineZoom >= maximumZoom - timelineZoomEpsilon;
    this.zoomOutButton.disabled = this.isBusy || this.timelineZoom <= 1 + timelineZoomEpsilon;
    this.zoomFitButton.disabled = this.zoomOutButton.disabled;
    this.zoomSlider.disabled = this.isBusy || maximumZoom <= 1 + timelineZoomEpsilon;
  }

  private handleTimelineWheel(event: WheelEvent): void {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      this.setTimelineZoom(this.timelineZoom * Math.exp(-event.deltaY * timelineZoomWheelSensitivity), event.clientX);
      return;
    }

    if (this.timelineZoom > 1 && Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
      event.preventDefault();
      this.timeline.scrollLeft += event.deltaY;
    }
  }

  private scheduleRulerRender(): void {
    if (this.rulerFrameHandle !== null) {
      return;
    }

    this.rulerFrameHandle = requestAnimationFrame((): void => {
      this.rulerFrameHandle = null;
      this.renderTimelineRuler();
    });
  }

  private ensurePlayheadVisible(): void {
    if (this.timelineZoom <= 1) {
      return;
    }

    const viewportWidthPx = this.timeline.clientWidth;
    const playheadPx = this.timelineTrack.offsetLeft
      + (this.playheadSeconds / this.durationSeconds) * this.timelineTrack.clientWidth;
    const marginPx = viewportWidthPx * playheadFollowMarginRatio;
    if (playheadPx < this.timeline.scrollLeft || playheadPx > this.timeline.scrollLeft + viewportWidthPx - marginPx) {
      this.timeline.scrollLeft = playheadPx - marginPx;
    }
  }

  private requestTimelineThumbnails(): void {
    if (this.thumbnailRequestHandle !== null) {
      clearTimeout(this.thumbnailRequestHandle);
    }

    this.thumbnailRequestHandle = setTimeout((): void => {
      this.thumbnailRequestHandle = null;
      this.runAsync(this.loadTimelineThumbnails(), "Could not load timeline previews.");
    }, thumbnailRequestDelayMs);
  }

  private toggleVideoTrack(): void {
    this.isVideoTrackVisible = !this.isVideoTrackVisible;
    const label = this.isVideoTrackVisible ? "Hide video" : "Show video";
    this.previewArea.classList.toggle("video-hidden", !this.isVideoTrackVisible);
    this.videoLane.classList.toggle("track-hidden", !this.isVideoTrackVisible);
    this.videoTrackToggle.classList.toggle("off", !this.isVideoTrackVisible);
    setTooltipLabel(this.videoTrackToggle, label);
    this.preparedVideo = null;
    this.showStatus(this.isVideoTrackVisible ? "Video shown" : "Video hidden");
  }

  private toggleSnapping(): void {
    this.isSnappingEnabled = !this.isSnappingEnabled;
    this.snapButton.setAttribute(ariaPressedAttributeName, String(this.isSnappingEnabled));
    this.hideSnapIndicator();
    this.showStatus(this.isSnappingEnabled ? "Snapping on" : "Snapping off");
  }

  private timelineEdgeTimes(): number[] {
    const edgeTimes = [zeroSeconds];
    for (const segment of this.timelineSegments) {
      edgeTimes.push((edgeTimes.at(-1) ?? zeroSeconds) + timelineSegmentDuration(segment));
    }

    return edgeTimes;
  }

  private scrubTimeAtClientX(clientX: number): number {
    const timelineTime = this.timelineTimeAtClientX(clientX);
    if (!this.isSnappingEnabled) {
      return timelineTime;
    }

    const pixelsPerSecond = this.timelinePixelsPerSecond();
    const snappedPx = nearestSnapTarget(
      timelineTime * pixelsPerSecond,
      this.timelineEdgeTimes().map((edgeTime) => edgeTime * pixelsPerSecond)
    );
    if (snappedPx === null) {
      this.hideSnapIndicator();
      return timelineTime;
    }

    this.showSnapIndicator(snappedPx);
    return snappedPx / pixelsPerSecond;
  }

  private resizeSnapTargetsPx(
    segmentId: number,
    edge: TimelineSegmentEdge,
    initialEdgePx: number,
    pixelsPerSecond: number
  ): number[] {
    if (!this.isSnappingEnabled) {
      return [];
    }

    const { timelineEnd, timelineStart } = timelineSegmentBounds(this.timelineSegments, segmentId);
    const targetsPx = [...this.timelineEdgeTimes(), this.playheadSeconds]
      .filter((targetTime) => Math.abs(targetTime - timelineStart) > snapToleranceSeconds
        && Math.abs(targetTime - timelineEnd) > snapToleranceSeconds)
      .map((targetTime) => targetTime * pixelsPerSecond);
    return edge === "start" ? targetsPx : targetsPx.filter((targetPx) => targetPx < initialEdgePx);
  }

  private showSnapIndicator(offsetPx: number): void {
    this.timelineSnapIndicator.style.left = `${String(offsetPx)}px`;
    this.timelineSnapIndicator.hidden = false;
  }

  private hideSnapIndicator(): void {
    this.timelineSnapIndicator.hidden = true;
  }

  private cutPositionAtClientX(clientX: number): CutPosition | null {
    const rect = this.timelineTrackBounds();

    const pixelsPerSecond = rect.width / this.durationSeconds;
    const pointerOffsetX = clamp(clientX - rect.left, zeroSeconds, rect.width);
    const playheadOffsetX = this.playheadSeconds * pixelsPerSecond;
    const isSnappedToPlayhead = this.isSnappingEnabled && Math.abs(pointerOffsetX - playheadOffsetX) <= snapDistancePx;
    const offsetX = isSnappedToPlayhead ? playheadOffsetX : pointerOffsetX;
    const timelineTime = offsetX / pixelsPerSecond;
    return timelineTime < this.editedDurationSeconds() ? { offsetX, timelineTime } : null;
  }

  private updateCutIndicator(event: PointerEvent): void {
    const isOverRuler = event.target instanceof Element && event.target.closest(".timeline-ruler") !== null;
    if (this.timelineTool !== "cut" || this.isInteractionLocked || isOverRuler) {
      this.hideCutIndicator();
      return;
    }

    const position = this.cutPositionAtClientX(event.clientX);
    if (!position) {
      this.hideCutIndicator();
      return;
    }

    this.timelineCutIndicator.style.left = `${String(position.offsetX)}px`;
    this.timelineCutTime.textContent = formatTime(position.timelineTime);
    this.timelineCutIndicator.hidden = false;
  }

  private hideCutIndicator(): void {
    this.timelineCutIndicator.hidden = true;
  }

  private beginTimelineCut(event: PointerEvent): void {
    const position = this.cutPositionAtClientX(event.clientX);
    event.preventDefault();
    if (!position) {
      return;
    }

    this.run((): void => {
      this.cutTimelineAt(position.timelineTime);
    }, "Could not cut the recording.");
  }

  private deleteSelectedSegmentSafely(): void {
    this.run((): void => {
      this.deleteSelectedSegment();
    }, "Could not delete the selected segment.");
  }

  private recordTimelineEdit(previousSegments: TimelineSegment[]): void {
    this.undoStack.push(previousSegments);
    this.redoStack.length = 0;
  }

  private undoTimelineEdit(): void {
    this.restoreTimelineEdit(this.undoStack, this.redoStack, "Undone");
  }

  private redoTimelineEdit(): void {
    this.restoreTimelineEdit(this.redoStack, this.undoStack, "Redone");
  }

  private restoreTimelineEdit(source: TimelineSegment[][], target: TimelineSegment[][], message: string): void {
    if (this.isInteractionLocked) {
      return;
    }

    const segments = source.pop();
    if (!segments) {
      return;
    }

    const previousSegmentRects = this.timelineSegmentRects();
    target.push(this.timelineSegments);
    this.video.pause();
    this.timelineSegments = segments;
    if (segments.every((segment) => segment.id !== this.selectedSegmentId)) {
      this.selectedSegmentId = timelineLocationAt(segments, this.clampedPlaybackTime(this.playheadSeconds)).segment.id;
    }

    this.activeSegmentId = null;
    this.preparedVideo = null;
    this.syncTimeline();
    this.animateTimelineReflow(previousSegmentRects);
    this.seekTo(this.playheadSeconds);
    this.showStatus(message);
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
    return this.timelineTool === "hand" && this.timelineSegments.length > 1;
  }

  private async closeEditor(): Promise<void> {
    if (this.isInteractionLocked) {
      return;
    }

    this.isClosing = true;
    this.timelineResizeObserver.disconnect();
    this.stopTimelineAutoScroll();
    if (this.thumbnailRequestHandle !== null) {
      clearTimeout(this.thumbnailRequestHandle);
      this.thumbnailRequestHandle = null;
    }

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
    if (this.timelineTool === "cut" && !target?.closest(".timeline-ruler")) {
      this.beginTimelineCut(event);
      return;
    }

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
    const { timelineStart } = timelineSegmentBounds(this.timelineSegments, segmentId);
    const pointerOffsetPx = event.clientX - this.timelineTrackBounds().left;
    this.video.pause();
    this.selectedSegmentId = segmentId;
    this.seekTo(timelineTime);
    this.activeTimelineMove = {
      grabOffsetPx: pointerOffsetPx - timelineStart * this.timelinePixelsPerSecond(),
      hasMoved: false,
      initialClientX: event.clientX,
      initialSegments: this.timelineSegments,
      isDragging: false,
      pointerClientX: event.clientX,
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
    const trackBounds = this.timelineTrackBounds();
    const pixelsPerSecond = trackBounds.width / this.durationSeconds;
    const segmentBounds = timelineSegmentBounds(this.timelineSegments, segmentId);
    const initialEdgePx = (edge === "start" ? segmentBounds.timelineStart : segmentBounds.timelineEnd) * pixelsPerSecond;

    const playbackLocation = timelineLocationAt(this.timelineSegments, this.playheadSeconds);
    this.video.pause();
    this.selectedSegmentId = segmentId;
    this.activeTimelineResize = {
      edge,
      hasChanged: false,
      initialEdgePx,
      initialPointerOffsetPx: event.clientX - trackBounds.left,
      initialSegments: this.timelineSegments.map((segment) => ({ ...segment })),
      initialTrackWidth: trackBounds.width,
      playbackSegmentId: playbackLocation.segment.id,
      playbackSourceTime: playbackLocation.sourceTime,
      pointerId: event.pointerId,
      segmentId,
      snapTargetsPx: this.resizeSnapTargetsPx(segmentId, edge, initialEdgePx, pixelsPerSecond)
    };
    this.timeline.classList.add("resizing-clip");
    this.timelineTrack.setPointerCapture(event.pointerId);
    this.renderTimelineSegments();
    event.preventDefault();
  }

  private beginTimelineScrub(event: PointerEvent): void {
    this.activeTimelinePointerId = event.pointerId;
    this.timelineTrack.setPointerCapture(event.pointerId);
    const timelineTime = this.scrubTimeAtClientX(event.clientX);
    if (this.timelineTool === "hand") {
      this.selectSegmentAt(timelineTime);
    }

    this.seekTo(timelineTime);
    event.preventDefault();
  }

  private clampedPlaybackTime(value: number): number {
    return clamp(value, zeroSeconds, this.editedDurationSeconds());
  }

  private editedDurationSeconds(): number {
    return timelineDuration(this.timelineSegments);
  }

  private timelineTrackBounds(): DOMRect {
    const rect = this.timelineTrack.getBoundingClientRect();
    if (rect.width <= 0) {
      throw new Error("The editor timeline has no usable width.");
    }

    return rect;
  }

  private timelineTimeAtClientX(clientX: number): number {
    const rect = this.timelineTrackBounds();

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

  private cutTimelineAt(timelineTime: number): void {
    if (this.isInteractionLocked) {
      return;
    }

    let split;
    try {
      split = splitTimelineAt(
        this.timelineSegments,
        timelineTime,
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
    this.recordTimelineEdit(this.timelineSegments);
    this.timelineSegments = split.segments;
    this.nextSegmentId += 1;
    this.selectedSegmentId = split.rightSegmentId;
    this.activeSegmentId = timelineLocationAt(this.timelineSegments, this.playheadSeconds).segment.id;
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
    const removingClips = this.segmentClipElements(selectedSegmentId).map((element) => ({
      element,
      parent: requiredParentElement(element)
    }));
    this.video.pause();
    this.recordTimelineEdit(this.timelineSegments);
    this.timelineSegments = deleteTimelineSegment(this.timelineSegments, selectedSegmentId);
    this.playheadSeconds = timelineTimeAfterDeletion(this.playheadSeconds, deletedRange);

    const nextSelectedIndex = Math.min(selectedSegmentIndex, this.timelineSegments.length - 1);
    this.selectedSegmentId = this.timelineSegments[nextSelectedIndex]?.id ?? null;
    this.activeSegmentId = null;
    this.preparedVideo = null;
    this.syncTimeline();
    this.animateTimelineDeletion(previousSegmentRects, removingClips);
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
    if (this.canReuseSourceFile
      && this.hasDefaultAudioMix()
      && this.isVideoTrackVisible
      && singleSourceRange
      && singleSourceRange.start <= fullSourceRangeToleranceSeconds) {
      if (this.isFullSourceRange(singleSourceRange)) {
        return {
          filePath: this.sourceFilePath,
          key
        };
      }

      if (!this.hasEmbeddedAudio()) {
        const trimmedFile = await getSoftshotApi().trimEditorVideoEnd(singleSourceRange.end);
        return preparedVideoFromFile(key, trimmedFile);
      }
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
        kind: audioTrack.kind,
        volume: this.audioTrackVolume(audioTrack.kind)
      }));
  }

  private hasEmbeddedAudio(): boolean {
    return this.audioTracks.some((audioTrack) => audioTrack.sourceFilePath === this.sourceFilePath);
  }

  private hasDefaultAudioMix(): boolean {
    return this.mutedAudioKinds.size === 0
      && this.audioTracks.every((audioTrack) => this.audioTrackVolume(audioTrack.kind) === defaultAudioVolume);
  }

  private audioTrackVolume(kind: AudioSourceKind): number {
    const volume = this.audioVolumesByKind.get(kind);
    if (typeof volume !== "number") {
      throw new TypeError("The audio track volume is missing.");
    }

    return volume;
  }

  private setAudioTrackVolume(kind: AudioSourceKind, volume: number): void {
    if (!Number.isFinite(volume) || volume < 0) {
      throw new RangeError("Audio track volume must be a non-negative number.");
    }

    this.audioVolumesByKind.set(kind, volume);
    this.preparedVideo = null;
    this.syncAudioMuteStates();
    this.syncAudioVolumeControl(kind);
    this.renderAudioClips();
  }

  private syncAudioVolumeControl(kind: AudioSourceKind): void {
    const percent = Math.round(this.audioTrackVolume(kind) * volumePercentScale);
    const input = this.audioTrackHeadersElement.querySelector<HTMLInputElement>(`${audioVolumeInputSelector}[data-audio-kind="${CSS.escape(kind)}"]`);
    const value = this.audioTrackHeadersElement.querySelector<HTMLElement>(`.track-volume-value[data-audio-kind="${CSS.escape(kind)}"]`);
    if (!input || !value) {
      throw new Error("The audio track volume control is missing.");
    }

    input.value = String(percent);
    input.style.setProperty("--range-fill", `${String((percent / maximumAudioVolumePercent) * volumePercentScale)}%`);
    value.textContent = `${String(percent)}%`;
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
    this.hideSnapIndicator();
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

    const previousSegmentRects = this.timelineSegmentRects();
    this.activeTimelineMove = null;
    this.timeline.classList.remove("moving-clip");
    if (this.timelineTrack.hasPointerCapture(event.pointerId)) {
      this.timelineTrack.releasePointerCapture(event.pointerId);
    }

    for (const element of this.segmentClipElements(move.segmentId)) {
      element.style.removeProperty("transform");
    }

    if (move.hasMoved) {
      this.recordTimelineEdit(move.initialSegments);
      this.showStatus("Clip moved");
    }

    this.syncTimeline();
    this.animateTimelineReflow(previousSegmentRects);

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
    this.hideSnapIndicator();
    if (this.timelineTrack.hasPointerCapture(event.pointerId)) {
      this.timelineTrack.releasePointerCapture(event.pointerId);
    }

    if (resize.hasChanged) {
      this.recordTimelineEdit(resize.initialSegments);
      this.showStatus("Clip trimmed");
    }

    this.syncTimeline();
    this.animateTimelineReflow(previousSegmentRects);
    this.seekTo(this.playheadSeconds);

    event.preventDefault();
  }

  private async exportVideoForSourceRanges(sourceRanges: readonly TrimRange[]): Promise<ExportedVideo> {
    return await exportEditedVideo(
      this.mimeType,
      this.fps,
      sourceRanges,
      this.audioTracksForExport(),
      this.isVideoTrackVisible
    );
  }

  private loadRecording(bootstrap: EditorBootstrap): void {
    this.audioTracks = bootstrap.audioTracks;
    for (const audioTrack of this.audioTracks) {
      this.audioVolumesByKind.set(audioTrack.kind, defaultAudioVolume);
    }

    this.durationSeconds = positiveDuration(bootstrap.durationSeconds);
    this.fps = bootstrap.fps;
    this.mimeType = bootstrap.mimeType;
    this.canReuseSourceFile = bootstrap.canReuseSourceFile;
    this.sourceFilePath = bootstrap.sourceFilePath;
    this.sourceUrl = bootstrap.sourceUrl;
    this.video.muted = this.audioTracks.length > 0;
    this.video.src = this.sourceUrl;
    this.createAudioPreviewElements();
    this.renderAudioTracks();
    this.showStatus(editorSourceStatus(bootstrap.source));
  }

  private async loadAudioWaveforms(): Promise<void> {
    const waveforms = await Promise.all(this.audioTracks.map(async (audioTrack) => ({
      kind: audioTrack.kind,
      peaks: await audioWaveformPeaks(audioTrack.kind, this.durationSeconds, audioWaveformPeakCount)
    })));
    if (this.isClosing) {
      return;
    }

    this.audioWaveformsByKind.clear();
    for (const waveform of waveforms) {
      this.audioWaveformsByKind.set(waveform.kind, waveform.peaks);
    }

    this.hasLoadedAudioWaveforms = true;
    this.renderAudioClips();
  }

  private async loadTimelineThumbnails(): Promise<void> {
    if (this.isCapturingThumbnails) {
      this.hasPendingThumbnailRequest = true;
      return;
    }

    const trackWidth = this.timelineTrack.clientWidth;
    const laneHeight = this.timelineSegmentsElement.clientHeight;
    if (trackWidth <= 0 || laneHeight <= 0) {
      throw new Error("The editor timeline has no usable size.");
    }

    const videoAspect = this.video.videoWidth / this.video.videoHeight;
    const tileWidth = Math.round(laneHeight * clamp(videoAspect, filmstripTileMinimumAspect, filmstripTileMaximumAspect));
    const thumbnailCount = clamp(Math.ceil(trackWidth / tileWidth), 1, timelineThumbnailMaximumCount);
    if (thumbnailCount <= this.timelineThumbnails.length) {
      return;
    }

    const imageWidth = clamp(
      Math.round(tileWidth * window.devicePixelRatio),
      timelineThumbnailMinimumImageWidthPx,
      timelineThumbnailMaximumImageWidthPx
    );
    this.isCapturingThumbnails = true;
    let thumbnails: TimelineThumbnail[];
    try {
      thumbnails = await captureVideoTimelineThumbnails(this.sourceUrl, this.durationSeconds, thumbnailCount, imageWidth);
    } finally {
      this.isCapturingThumbnails = false;
    }

    if (this.isClosing) {
      releaseTimelineThumbnailUrls(thumbnails);
      return;
    }

    this.releaseTimelineThumbnails();
    this.timelineThumbnails = thumbnails;
    this.filmstripTileWidthPx = tileWidth;
    this.timeline.style.setProperty(filmstripTileWidthCssProperty, `${String(tileWidth)}px`);
    this.renderTimelineSegments();
    if (this.hasPendingThumbnailRequest) {
      this.hasPendingThumbnailRequest = false;
      this.requestTimelineThumbnails();
    }
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
    const hasAudioTracks = this.audioTracks.length > 0;
    this.audioTrackHeadersElement.hidden = !hasAudioTracks;
    this.audioTracksElement.hidden = !hasAudioTracks;
    this.audioTrackHeadersElement.replaceChildren(
      ...this.audioTracks.map((audioTrack) => this.audioTrackHeaderElement(audioTrack))
    );
    this.audioClipElementsByKind.clear();
    this.audioLaneElementsByKind.clear();
    this.audioTracksElement.replaceChildren(...this.audioTracks.map((audioTrack) => this.audioTrackLaneElement(audioTrack)));
    for (const audioTrack of this.audioTracks) {
      this.syncAudioVolumeControl(audioTrack.kind);
    }

    this.renderAudioClips();
  }

  private renderAudioClips(): void {
    if (this.timelineSegments.length === 0 || !this.hasLoadedAudioWaveforms) {
      return;
    }

    const pixelsPerSecond = this.timelineTrack.clientWidth / this.durationSeconds;
    for (const audioTrack of this.audioTracks) {
      const lane = this.audioLaneElementsByKind.get(audioTrack.kind);
      const waveformPeaks = this.audioWaveformsByKind.get(audioTrack.kind);
      if (!lane || !waveformPeaks) {
        throw new Error("The audio waveform data is missing.");
      }

      const clipElements = this.audioClipElementsByKind.get(audioTrack.kind) ?? new Map<number, HTMLDivElement>();
      this.audioClipElementsByKind.set(audioTrack.kind, clipElements);
      let timelineStart = zeroSeconds;
      const clips = this.timelineSegments.map((segment, segmentIndex) => {
        const clip = clipElements.get(segment.id) ?? audioClipElement(segment.id);
        const segmentDuration = timelineSegmentDuration(segment);
        clipElements.set(segment.id, clip);
        clip.classList.toggle(movingClipClassName, this.isMovingSegment(segment.id));
        this.positionTimelineClip(clip, timelineStart, segmentDuration, segmentIndex);
        timelineStart += segmentDuration;
        return { clip, segment, widthPx: segmentDuration * pixelsPerSecond };
      });
      pruneTimelineClipElements(clipElements, this.timelineSegments);
      lane.replaceChildren(...clips.map(({ clip }) => clip));
      const isMuted = this.mutedAudioKinds.has(audioTrack.kind);
      const volume = this.audioTrackVolume(audioTrack.kind);
      for (const { clip, segment, widthPx } of clips) {
        const canvas = requiredChildElement(clip, ".audio-waveform");
        if (!(canvas instanceof HTMLCanvasElement)) {
          throw new TypeError("The audio clip waveform is not a canvas.");
        }

        const drawKey = `${String(segment.sourceStart)}|${String(segment.sourceEnd)}|${String(Math.round(widthPx))}|${String(isMuted)}|${String(volume)}`;
        if (canvas.dataset.drawKey !== drawKey) {
          canvas.dataset.drawKey = drawKey;
          drawTimelineWaveform(canvas, waveformPeaks, this.durationSeconds, segment, isMuted, volume);
        }
      }
    }
  }

  private audioTrackHeaderElement(audioTrack: EditorAudioTrack): HTMLElement {
    const header = document.createElement("div");
    header.className = "track-header audio-track-header";
    header.classList.toggle("muted", this.mutedAudioKinds.has(audioTrack.kind));

    const name = document.createElement("span");
    name.className = "track-name";
    name.textContent = audioTrackLabel(audioTrack.kind);

    const value = document.createElement("span");
    value.className = "track-volume-value";
    value.dataset.audioKind = audioTrack.kind;

    const volume = document.createElement("input");
    volume.className = "range-input track-volume";
    volume.type = "range";
    volume.min = "0";
    volume.max = String(maximumAudioVolumePercent);
    volume.step = "1";
    volume.dataset.audioKind = audioTrack.kind;
    volume.setAttribute("aria-label", `${audioTrackLabel(audioTrack.kind)} volume`);
    volume.dataset.tooltip = "Double-click to reset";

    const nameRow = document.createElement("span");
    nameRow.className = "track-name-row";
    nameRow.append(name, value);

    const details = document.createElement("span");
    details.className = "track-details";
    details.append(nameRow, volume);

    header.append(details, this.audioTrackMuteButton(audioTrack.kind));
    return header;
  }

  private audioTrackLaneElement(audioTrack: EditorAudioTrack): HTMLElement {
    const lane = document.createElement("div");
    lane.className = "timeline-lane audio-lane";
    lane.classList.toggle("muted", this.mutedAudioKinds.has(audioTrack.kind));
    lane.style.setProperty(audioLevelCssProperty, "0");
    this.assignAudioMeterRow(audioTrack.kind, lane);
    this.audioLaneElementsByKind.set(audioTrack.kind, lane);
    return lane;
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
    button.className = "track-toggle";
    button.classList.toggle("off", isMuted);
    button.type = "button";
    button.dataset.audioKind = kind;
    setTooltipLabel(button, isMuted ? `Unmute ${audioTrackLabel(kind)}` : `Mute ${audioTrackLabel(kind)}`);
    button.innerHTML = `${audioTrackIcon(kind)}<span class="track-toggle-badge">${audioTrackMuteIcon(isMuted)}</span>`;
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

  private setBusy(isBusy: boolean): void {
    this.isBusy = isBusy;
    document.body.classList.toggle("busy", isBusy);
    this.syncControlStates();
  }

  private syncControlStates(): void {
    const { isBusy } = this;
    const transportButtons = [
      this.closeButton,
      this.copyButton,
      this.cutButton,
      this.handButton,
      this.snapButton,
      this.videoTrackToggle,
      this.jumpEndButton,
      this.jumpStartButton,
      this.playButton,
      this.saveButton,
      this.stepBackButton,
      this.stepForwardButton,
      ...this.audioTrackHeadersElement.querySelectorAll<HTMLButtonElement>(audioMuteButtonSelector),
      ...this.audioTrackHeadersElement.querySelectorAll<HTMLInputElement>(audioVolumeInputSelector),
      ...this.timelineSegmentElements.values()
    ];
    for (const button of transportButtons) {
      button.disabled = isBusy;
    }

    this.undoButton.disabled = isBusy || this.undoStack.length === 0;
    this.redoButton.disabled = isBusy || this.redoStack.length === 0;
    this.clipDeleteButton.disabled = isBusy || this.selectedSegmentId === null || this.timelineSegments.length <= 1;
    this.syncZoomControls();
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
    setTooltipLabel(this.playButton, this.video.paused ? "Play" : "Pause", "Space");
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

  private renderTimelineLayout(): void {
    if (this.timelineSegments.length === 0) {
      return;
    }

    if (this.timelineZoom > this.maximumTimelineZoom()) {
      this.setTimelineZoom(this.maximumTimelineZoom(), null);
    }

    this.renderTimelineRuler();
    this.renderTimelineSegments();
    this.renderAudioClips();
    this.syncZoomControls();
    if (this.timelineTrack.clientWidth > 0) {
      this.requestTimelineThumbnails();
    }
  }

  private renderTimelineRuler(): void {
    const trackWidth = this.timelineTrack.clientWidth;
    if (trackWidth <= 0) {
      return;
    }

    const pixelsPerSecond = trackWidth / this.durationSeconds;
    const majorSeconds = rulerMajorSeconds(rulerMajorMinimumSpacingPx / pixelsPerSecond);
    const minorSeconds = majorSeconds / rulerMinorDivisions;
    const hasMinorTicks = minorSeconds * pixelsPerSecond >= rulerMinorMinimumSpacingPx;
    const hasTenths = majorSeconds < 1;
    const viewportWidthPx = this.timeline.clientWidth;
    const visibleStartPx = this.timeline.scrollLeft - this.timelineTrack.offsetLeft - viewportWidthPx;
    const visibleEndPx = visibleStartPx + viewportWidthPx * (1 + halfDivisor);
    const firstTickIndex = Math.max(0, Math.floor(visibleStartPx / pixelsPerSecond / minorSeconds));
    const lastTickIndex = Math.min(
      Math.floor(this.durationSeconds / minorSeconds),
      Math.ceil(visibleEndPx / pixelsPerSecond / minorSeconds)
    );
    const ticks: HTMLElement[] = [];
    for (let tickIndex = firstTickIndex; tickIndex <= lastTickIndex; tickIndex += 1) {
      const isMajor = tickIndex % rulerMinorDivisions === 0;
      if (!isMajor && !hasMinorTicks) {
        continue;
      }

      const tickSeconds = tickIndex * minorSeconds;
      const hasLabel = isMajor && (this.durationSeconds - tickSeconds) * pixelsPerSecond >= rulerLabelEndClearancePx;
      ticks.push(rulerTick(
        percentOf(tickSeconds, this.durationSeconds),
        isMajor,
        hasLabel ? formatRulerTime(tickSeconds, hasTenths) : null
      ));
    }

    this.timelineRuler.replaceChildren(...ticks);
  }

  private timelineFilmstripScale(): FilmstripScale | null {
    const trackWidth = this.timelineTrack.clientWidth;
    if (this.timelineThumbnails.length === 0 || this.filmstripTileWidthPx <= 0 || trackWidth <= 0) {
      return null;
    }

    const pixelsPerSecond = trackWidth / this.durationSeconds;
    return {
      pixelsPerSecond,
      tileDurationSeconds: this.filmstripTileWidthPx / pixelsPerSecond
    };
  }

  private renderTimelineSegments(): void {
    let timelineStart = zeroSeconds;
    const filmstripScale = this.timelineFilmstripScale();
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
          timelineClipDurationBadge(),
          timelineResizeHandle(segment.id, "start"),
          timelineResizeHandle(segment.id, "end")
        );
        this.timelineSegmentElements.set(segment.id, element);
      }

      const segmentDuration = timelineSegmentDuration(segment);
      const isSelected = segment.id === this.selectedSegmentId;
      renderedSegmentIds.add(segment.id);
      element.setAttribute("aria-label", `Select section ${String(segmentIndex + 1)}`);
      element.setAttribute(ariaPressedAttributeName, String(isSelected));
      if (this.canReorderTimelineSegments) {
        element.dataset.tooltip = "Drag to reorder";
      } else {
        delete element.dataset.tooltip;
      }

      element.classList.toggle("reorderable", this.canReorderTimelineSegments);
      element.classList.toggle(movingClipClassName, this.isMovingSegment(segment.id));
      element.classList.toggle("selected", isSelected);
      this.renderTimelineSegmentThumbnails(element, segment, filmstripScale);
      this.renderTimelineClipDuration(element, segmentDuration);
      this.positionTimelineClip(element, timelineStart, segmentDuration, segmentIndex);
      timelineStart += segmentDuration;
      return element;
    });
    for (const segmentId of this.timelineSegmentElements.keys()) {
      if (!renderedSegmentIds.has(segmentId)) {
        this.timelineSegmentElements.delete(segmentId);
      }
    }

    this.timelineSegmentsElement.replaceChildren(...elements);
    this.syncControlStates();
  }

  private renderTimelineSegmentThumbnails(
    element: HTMLButtonElement,
    segment: TimelineSegment,
    filmstripScale: FilmstripScale | null
  ): void {
    if (!filmstripScale) {
      return;
    }

    const strip = requiredChildElement(element, ".timeline-segment-thumbnails");
    const filmstrip = timelineFilmstrip(this.timelineThumbnails, segment, filmstripScale.tileDurationSeconds);
    strip.style.left = `${String(-filmstrip.offsetSeconds * filmstripScale.pixelsPerSecond)}px`;
    const thumbnailKey = filmstrip.thumbnails.map((thumbnail) => thumbnail.url).join("|");
    if (strip.dataset.thumbnailKey === thumbnailKey) {
      return;
    }

    strip.dataset.thumbnailKey = thumbnailKey;
    syncTimelineThumbnailImages(strip, filmstrip.thumbnails);
  }

  private renderTimelineClipDuration(element: HTMLButtonElement, durationSeconds: number): void {
    requiredChildElement(element, ".timeline-segment-duration").textContent = formatClipDuration(durationSeconds);
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
    removingClips: readonly RemovingTimelineClip[]
  ): void {
    this.animateTimelineReflow(previousSegmentRects);
    if (matchMedia(reducedMotionMediaQuery).matches) {
      return;
    }

    for (const { element, parent } of removingClips) {
      element.classList.add(timelineClipRemovingClassName);
      element.setAttribute(ariaHiddenAttributeName, "true");
      if (element instanceof HTMLButtonElement) {
        element.disabled = true;
      }

      parent.append(element);
      const removalAnimation = element.animate([
        { opacity: 1 },
        { opacity: 0 }
      ], {
        duration: timelineReflowDurationMs,
        easing: timelineReflowEasing
      });
      void removalAnimation.finished.then(
        (): void => element.remove(),
        (): void => element.remove()
      );
    }
  }

  private animateTimelineReflow(
    previousSegmentRects: ReadonlyMap<number, DOMRect>,
    pointerDrivenSegmentId: number | null = null
  ): void {
    if (matchMedia(reducedMotionMediaQuery).matches) {
      return;
    }

    for (const [segmentId, element] of this.timelineSegmentElements) {
      const previousRect = previousSegmentRects.get(segmentId);
      if (!previousRect || segmentId === pointerDrivenSegmentId) {
        continue;
      }

      const clipElements = this.segmentClipElements(segmentId);
      for (const clipElement of clipElements) {
        cancelTimelineReflowAnimations(clipElement);
      }

      const offsetX = previousRect.left - element.getBoundingClientRect().left;
      if (Math.abs(offsetX) < 1) {
        continue;
      }

      for (const clipElement of clipElements) {
        clipElement.animate([
          { transform: `translateX(${String(offsetX)}px)` },
          { transform: "none" }
        ], {
          duration: timelineReflowDurationMs,
          easing: timelineReflowEasing,
          id: timelineReflowAnimationId
        });
      }
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
    if (!this.video.paused) {
      this.ensurePlayheadVisible();
    }
    this.syncPlayButton();
  }

  private syncTimeline(): void {
    const editedDuration = this.editedDurationSeconds();
    this.totalTimeText.textContent = formatTime(editedDuration);
    this.renderTimelineSegments();
    this.renderAudioClips();
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
    } else if (this.activeTimelineMove?.pointerId === event.pointerId) {
      this.updateTimelineMove(event);
    } else {
      this.updateTimelineScrub(event);
    }

    if (this.hasActiveTimelineDrag()) {
      this.startTimelineAutoScroll(event.clientX);
    }
  }

  private hasActiveTimelineDrag(): boolean {
    return this.activeTimelineResize !== null
      || this.activeTimelineMove?.isDragging === true
      || this.activeTimelinePointerId !== noPointerId;
  }

  private startTimelineAutoScroll(clientX: number): void {
    this.lastTimelinePointerClientX = clientX;
    if (this.autoScrollFrameHandle !== null) {
      return;
    }

    const step = (): void => {
      if (!this.hasActiveTimelineDrag()) {
        this.autoScrollFrameHandle = null;
        return;
      }

      const scrollStepPx = this.timelineAutoScrollStepPx(this.lastTimelinePointerClientX);
      const previousScrollLeft = this.timeline.scrollLeft;
      this.timeline.scrollLeft += scrollStepPx;
      if (this.timeline.scrollLeft !== previousScrollLeft) {
        this.applyActiveTimelinePointer(this.lastTimelinePointerClientX);
      }

      this.autoScrollFrameHandle = requestAnimationFrame(step);
    };
    this.autoScrollFrameHandle = requestAnimationFrame(step);
  }

  private stopTimelineAutoScroll(): void {
    if (this.autoScrollFrameHandle === null) {
      return;
    }

    cancelAnimationFrame(this.autoScrollFrameHandle);
    this.autoScrollFrameHandle = null;
  }

  private timelineAutoScrollStepPx(clientX: number): number {
    if (this.timelineZoom <= 1) {
      return 0;
    }

    const viewport = this.timeline.getBoundingClientRect();
    const leftDepthPx = viewport.left + autoScrollEdgePx - clientX;
    if (leftDepthPx > 0) {
      return -autoScrollMaximumStepPx * Math.min(leftDepthPx / autoScrollEdgePx, 1);
    }

    const rightDepthPx = clientX - (viewport.right - autoScrollEdgePx);
    if (rightDepthPx > 0) {
      return autoScrollMaximumStepPx * Math.min(rightDepthPx / autoScrollEdgePx, 1);
    }

    return 0;
  }

  private applyActiveTimelinePointer(clientX: number): void {
    if (this.activeTimelineResize) {
      this.applyTimelineResize(this.activeTimelineResize, clientX);
    } else if (this.activeTimelineMove?.isDragging) {
      this.applyTimelineMove(this.activeTimelineMove, clientX);
    } else if (this.activeTimelinePointerId !== noPointerId) {
      this.seekTo(this.scrubTimeAtClientX(clientX));
    }
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
      this.syncTimeline();
    }

    this.applyTimelineMove(move, event.clientX);
    event.preventDefault();
  }

  private applyTimelineMove(move: TimelineMove, clientX: number): void {
    move.pointerClientX = clientX;
    const segments = moveTimelineSegment(this.timelineSegments, move.segmentId, this.timelineMoveTargetIndex(move));
    if (!isSameTimelineSegmentOrder(segments, this.timelineSegments)) {
      const previousSegmentRects = this.timelineSegmentRects();
      this.timelineSegments = segments;
      move.hasMoved = true;
      this.preparedVideo = null;
      this.syncTimeline();
      this.animateTimelineReflow(previousSegmentRects, move.segmentId);
      this.seekTo(this.timelineTimeForSegmentSourceTime(move.playbackSegmentId, move.playbackSourceTime));
    }

    this.applyTimelineMoveOffset(move);
  }

  private timelinePixelsPerSecond(): number {
    return this.timelineTrackBounds().width / this.durationSeconds;
  }

  private timelineMoveLeftPx(move: TimelineMove, pixelsPerSecond: number, clipWidthPx: number): number {
    const pointerOffsetPx = move.pointerClientX - this.timelineTrackBounds().left;
    const editedWidthPx = this.editedDurationSeconds() * pixelsPerSecond;
    return clamp(pointerOffsetPx - move.grabOffsetPx, zeroSeconds, editedWidthPx - clipWidthPx);
  }

  private timelineMoveTargetIndex(move: TimelineMove): number {
    const pixelsPerSecond = this.timelinePixelsPerSecond();
    const movingClip = timelineSegmentBounds(this.timelineSegments, move.segmentId);
    const movingWidthPx = (movingClip.timelineEnd - movingClip.timelineStart) * pixelsPerSecond;
    const movingCenterPx = this.timelineMoveLeftPx(move, pixelsPerSecond, movingWidthPx) + movingWidthPx / halfDivisor;
    let clipStartPx = zeroSeconds;
    let targetIndex = 0;
    for (const segment of this.timelineSegments) {
      const clipWidthPx = timelineSegmentDuration(segment) * pixelsPerSecond;
      if (segment.id !== move.segmentId && clipStartPx + clipWidthPx / halfDivisor < movingCenterPx) {
        targetIndex += 1;
      }

      clipStartPx += clipWidthPx;
    }

    return targetIndex;
  }

  private applyTimelineMoveOffset(move: TimelineMove): void {
    const pixelsPerSecond = this.timelinePixelsPerSecond();
    const { timelineEnd, timelineStart } = timelineSegmentBounds(this.timelineSegments, move.segmentId);
    const slotLeftPx = timelineStart * pixelsPerSecond;
    const offsetPx = this.timelineMoveLeftPx(move, pixelsPerSecond, (timelineEnd - timelineStart) * pixelsPerSecond) - slotLeftPx;
    for (const element of this.segmentClipElements(move.segmentId)) {
      element.style.transform = `translateX(${String(offsetPx)}px)`;
    }
  }

  private isMovingSegment(segmentId: number): boolean {
    return segmentId === this.activeTimelineMove?.segmentId && this.activeTimelineMove.isDragging;
  }

  private segmentClipElements(segmentId: number): HTMLElement[] {
    const elements: HTMLElement[] = [];
    const videoClip = this.timelineSegmentElements.get(segmentId);
    if (videoClip) {
      elements.push(videoClip);
    }

    for (const clips of this.audioClipElementsByKind.values()) {
      const audioClip = clips.get(segmentId);
      if (audioClip) {
        elements.push(audioClip);
      }
    }

    return elements;
  }

  private positionTimelineClip(
    element: HTMLElement,
    timelineStart: number,
    segmentDuration: number,
    segmentIndex: number
  ): void {
    const visualOffset = this.activeStartResizeVisualOffsetSeconds(segmentIndex);
    element.style.left = `${String(percentOf(timelineStart + visualOffset, this.durationSeconds))}%`;
    element.style.width = `${String(percentOf(segmentDuration, this.durationSeconds))}%`;
  }

  private updateTimelineResize(event: PointerEvent): void {
    const resize = this.activeTimelineResize;
    if (resize?.pointerId !== event.pointerId) {
      return;
    }

    this.applyTimelineResize(resize, event.clientX);
    event.preventDefault();
  }

  private applyTimelineResize(resize: TimelineResize, clientX: number): void {
    const initialSegment = timelineSegmentById(resize.initialSegments, resize.segmentId);
    const initialEdgeTime = timelineSegmentEdgeTime(initialSegment, resize.edge);
    const pointerOffsetPx = clientX - this.timelineTrackBounds().left;
    const pointerEdgePx = resize.initialEdgePx + pointerOffsetPx - resize.initialPointerOffsetPx;
    const snappedEdgePx = nearestSnapTarget(pointerEdgePx, resize.snapTargetsPx);
    const edgeDeltaPx = (snappedEdgePx ?? pointerEdgePx) - resize.initialEdgePx;
    const sourceTimeDelta = (edgeDeltaPx / resize.initialTrackWidth) * this.durationSeconds;
    const segments = resizeTimelineSegment(
      resize.initialSegments,
      resize.segmentId,
      resize.edge,
      initialEdgeTime + sourceTimeDelta,
      minimumTrimDurationSeconds,
      this.durationSeconds
    );
    const resizedSegment = timelineSegmentById(segments, resize.segmentId);
    const resizedEdgeTime = timelineSegmentEdgeTime(resizedSegment, resize.edge);
    resize.hasChanged = Math.abs(resizedEdgeTime - initialEdgeTime) > Number.EPSILON;
    if (snappedEdgePx !== null && Math.abs(resizedEdgeTime - (initialEdgeTime + sourceTimeDelta)) <= snapToleranceSeconds) {
      this.showSnapIndicator(snappedEdgePx);
    } else {
      this.hideSnapIndicator();
    }
    this.timelineSegments = segments;
    this.preparedVideo = null;
    this.syncTimeline();
    this.seekTo(this.timelineTimeForSegmentSourceTime(resize.playbackSegmentId, resize.playbackSourceTime));
  }

  private updateTimelineScrub(event: PointerEvent): void {
    if (this.activeTimelinePointerId !== event.pointerId) {
      return;
    }

    this.seekTo(this.scrubTimeAtClientX(event.clientX));
  }

  private isFullSourceRange(sourceRange: TrimRange): boolean {
    return sourceRange.start <= fullSourceRangeToleranceSeconds
      && Math.abs(sourceRange.end - this.durationSeconds) <= fullSourceRangeToleranceSeconds;
  }

  private editKey(): string {
    return `${this.timelineKey()}:${this.audioExportKey()}:${String(this.isVideoTrackVisible)}`;
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
      .map((audioTrack) => `${audioTrack.kind}=${String(!this.mutedAudioKinds.has(audioTrack.kind))}@${String(this.audioTrackVolume(audioTrack.kind))}`)
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
      meter.gain.gain.value = this.mutedAudioKinds.has(kind) ? 0 : activeGain * this.audioTrackVolume(kind);
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

      this.timelineSegments = [{
        id: initialSegmentId,
        sourceEnd: this.durationSeconds,
        sourceStart: zeroSeconds
      }];
      this.activeSegmentId = initialSegmentId;
      this.selectedSegmentId = initialSegmentId;
      this.syncTimeline();
      this.renderTimelineRuler();
      this.syncPlaybackTime();
      this.runAsync(this.loadAudioWaveforms(), "Could not load audio waveforms.");
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
  if (isAudioSourceKind(value)) {
    return value;
  }

  throw new Error("Unexpected audio track type.");
}

function audioTrackLabel(kind: AudioSourceKind): string {
  return audioTrackLabels[kind];
}

function editorSourceStatus(source: EditorSource): string {
  if (source.kind === "file") {
    return source.fileName;
  }

  const encoderLabel = source.encoder === "hardware" ? "Hardware encoded" : "Compatibility encoding";
  const pipelineLabel = source.capturePipeline === "direct" ? "Direct capture" : "Composited capture";
  return `${encoderLabel}, ${pipelineLabel}`;
}

function audioTrackIcon(kind: AudioSourceKind): string {
  return audioTrackIcons[kind]();
}

function clipTrackIcon(): string {
  return speakerTrackIcon(`<path d="M16.5 9.5a4 4 0 0 1 0 5" /><path d="M19 7a7.5 7.5 0 0 1 0 10" />`);
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

function desktopTrackIcon(): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4.5" width="18" height="12" rx="2" /><path d="M12 16.5V20" /><path d="M8 20h8" /></svg>`;
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

function formatClipDuration(value: number): string {
  if (value < secondsPerMinute) {
    return `${value.toFixed(clipDurationPrecisionDigits)}s`;
  }

  const minutes = Math.floor(value / secondsPerMinute);
  const seconds = Math.floor(value % secondsPerMinute);
  return `${String(minutes)}:${String(seconds).padStart(timePartLength, "0")}`;
}

function formatRulerTime(value: number, hasTenths: boolean): string {
  const minutes = Math.floor(value / secondsPerMinute);
  const seconds = value % secondsPerMinute;
  const secondsText = hasTenths
    ? seconds.toFixed(clipDurationPrecisionDigits).padStart(timePartLength + clipDurationPrecisionDigits + 1, "0")
    : String(Math.round(seconds)).padStart(timePartLength, "0");
  return `${String(minutes)}:${secondsText}`;
}

function rulerMajorSeconds(minimumSeconds: number): number {
  if (minimumSeconds > secondsPerMinute) {
    return rulerStep(minimumSeconds / secondsPerMinute) * secondsPerMinute;
  }

  const seconds = rulerStep(minimumSeconds);
  return seconds > rulerLargestSecondStep ? secondsPerMinute : seconds;
}

function rulerStep(minimumValue: number): number {
  const magnitude = rulerStepBase ** Math.floor(Math.log10(minimumValue));
  const multiplier = rulerStepMultipliers.find((candidate) => candidate * magnitude >= minimumValue) ?? rulerStepBase;
  return multiplier * magnitude;
}

function rulerTick(leftPercent: number, isMajor: boolean, label: string | null): HTMLSpanElement {
  const tick = document.createElement("span");
  tick.className = isMajor ? "ruler-tick major" : "ruler-tick";
  tick.style.left = `${String(leftPercent)}%`;
  if (label !== null) {
    const labelElement = document.createElement("span");
    labelElement.className = "ruler-label";
    labelElement.textContent = label;
    tick.append(labelElement);
  }

  return tick;
}

function requiredChildElement(parent: HTMLElement, selector: string): HTMLElement {
  const element = parent.querySelector<HTMLElement>(selector);
  if (!element) {
    throw new Error(`The timeline element is missing: ${selector}.`);
  }

  return element;
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
  image.decoding = "sync";
  image.draggable = false;
  image.src = sourceUrl;
  return image;
}

function syncTimelineThumbnailImages(strip: HTMLElement, thumbnails: readonly TimelineThumbnail[]): void {
  const images = [...strip.children];
  for (const [index, thumbnail] of thumbnails.entries()) {
    const image = images[index];
    if (!(image instanceof HTMLImageElement)) {
      strip.append(timelineThumbnailImage(thumbnail.url));
    } else if (image.src !== thumbnail.url) {
      image.src = thumbnail.url;
    }
  }

  for (const image of images.slice(thumbnails.length)) {
    image.remove();
  }
}

interface RemovingTimelineClip {
  element: HTMLElement;
  parent: HTMLElement;
}

function audioClipElement(segmentId: number): HTMLDivElement {
  const clip = document.createElement("div");
  clip.className = "audio-clip";
  clip.dataset.segmentId = String(segmentId);
  const waveform = document.createElement("canvas");
  waveform.className = "audio-waveform";
  clip.append(waveform);
  return clip;
}

function pruneTimelineClipElements(clipElements: Map<number, HTMLElement>, segments: readonly TimelineSegment[]): void {
  for (const segmentId of clipElements.keys()) {
    if (segments.every((segment) => segment.id !== segmentId)) {
      clipElements.delete(segmentId);
    }
  }
}

function cancelTimelineReflowAnimations(element: HTMLElement): void {
  for (const animation of element.getAnimations()) {
    if (animation.id === timelineReflowAnimationId) {
      animation.cancel();
    }
  }
}

function nearestSnapTarget(positionPx: number, targetsPx: readonly number[]): number | null {
  let nearestTargetPx: number | null = null;
  for (const targetPx of targetsPx) {
    const distancePx = Math.abs(targetPx - positionPx);
    if (distancePx <= snapDistancePx && (nearestTargetPx === null || distancePx < Math.abs(nearestTargetPx - positionPx))) {
      nearestTargetPx = targetPx;
    }
  }

  return nearestTargetPx;
}

function requiredParentElement(element: HTMLElement): HTMLElement {
  if (!element.parentElement) {
    throw new Error("A timeline clip is not attached to its track.");
  }

  return element.parentElement;
}

function timelineClipDurationBadge(): HTMLSpanElement {
  const badge = document.createElement("span");
  badge.className = "timeline-segment-duration";
  badge.setAttribute(ariaHiddenAttributeName, "true");
  return badge;
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
