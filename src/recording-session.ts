import {
  AppendOnlyStreamTarget,
  CanvasSource,
  MediaStreamAudioTrackSource,
  MediaStreamVideoTrackSource,
  Mp4OutputFormat,
  Output
} from "mediabunny";

import { combinedError, rejectedReasons, throwCollectedErrors } from "./async-errors.js";
import { recordingAudioBitrate } from "./audio-quality.js";
import { desktopBounds, displaysInViewport, intersectRects } from "./capture-layout.js";
import { getCursorlessDesktopStream, stopTracks } from "./desktop-capture.js";
import { playMedia, waitForMediaMetadata } from "./media-element.js";
import { drawAnnotations } from "./overlay-drawing.js";
import type { Annotation } from "./overlay-model.js";
import { RecordingAudio } from "./recording-audio.js";
import { RecordingFileWriter, stopMediaRecorder } from "./recording-file-writer.js";
import { nextRecordingFrameDeadline } from "./recording-frame-clock.js";
import { recordingOutputSize } from "./recording-output-size.js";
import type { CaptureDisplay, CapturePipeline, RecordingAudioTrack, RecordingEncoder, Rect, VideoFps, VideoQuality } from "./shared.js";
import { videoBitrate } from "./video-bitrate.js";
import { selectVideoRecorderProfile } from "./video-recorder-profile.js";

const millisecondsPerSecond = 1000;
const hardwareVideoCodec = "avc";
const hardwareKeyframeIntervalSeconds = 2;
const hardwareFragmentDurationSeconds = 1;
const hardwareOperationTimeoutMs = 15_000;
const fullDisplayCropTolerancePx = 0.5;

type HardwareRecordingOutput = Output<Mp4OutputFormat, AppendOnlyStreamTarget>;
type RecordingSessionErrorHandler = (error: unknown) => void;

export interface RecordingSessionConfig {
  annotations: Annotation[];
  crop: Rect;
  displays: CaptureDisplay[];
  fps: VideoFps;
  microphoneDeviceId: string | null;
  quality: VideoQuality;
  systemAudioEnabled: boolean;
}

export interface RecordingResult {
  audioTracks: RecordingAudioTrack[];
  capturePipeline: CapturePipeline;
  durationSeconds: number;
  encoder: RecordingEncoder;
  mimeType: string;
  recordingId: string;
}

interface RecordingSource {
  bounds: Rect;
  stream: MediaStream;
  video: HTMLVideoElement;
}

interface VideoOutput {
  annotationCanvas: HTMLCanvasElement | null;
  canvasCaptureTrack: CanvasCaptureMediaStreamTrack | null;
  canvas: HTMLCanvasElement | null;
  context: CanvasRenderingContext2D | null;
  pipeline: CapturePipeline;
  stream: MediaStream;
}

interface HardwareRecording {
  canvasSource: CanvasSource | null;
  output: HardwareRecordingOutput;
}

export class RecordingSession {
  static async create(config: RecordingSessionConfig): Promise<RecordingSession> {
    let audio: RecordingAudio | null = null;
    let videoWriter: RecordingFileWriter | null = null;
    let videoOutput: VideoOutput | null = null;
    const sources: RecordingSource[] = [];
    try {
      await prepareRecordingSources(sources, config);
      if (sources.length === 0) {
        throw new Error("The selected region does not include a monitor.");
      }

      audio = await RecordingAudio.create(
        sources[0].stream,
        config.microphoneDeviceId,
        config.systemAudioEnabled
      );
      const outputSize = recordingOutputSize(
        config.crop,
        config.quality,
        desktopBounds(config.displays),
        { height: window.innerHeight, width: window.innerWidth }
      );
      const bitrate = videoBitrate(outputSize.width, outputSize.height, config.fps);
      const profile = await selectVideoRecorderProfile(
        outputSize.width,
        outputSize.height,
        config.fps,
        bitrate,
        audio.hasAudio()
      );
      videoWriter = await RecordingFileWriter.create(profile.fileExtension);
      videoOutput = await createVideoOutput(sources, config, outputSize);
      if (audio.mixedTrack) {
        videoOutput.stream.addTrack(audio.mixedTrack);
      }

      const hardwareRecording = profile.encoder === "hardware"
        ? createHardwareRecording(
          videoOutput,
          audio.mixedTrack,
          config.fps,
          bitrate,
          profile.hardwareVideoCodec,
          videoWriter
        )
        : null;
      const recorder = hardwareRecording
        ? null
        : new MediaRecorder(videoOutput.stream, {
          ...(audio.mixedTrack && { audioBitsPerSecond: recordingAudioBitrate }),
          mimeType: profile.mimeType,
          videoBitsPerSecond: bitrate
        });
      if (recorder) {
        videoWriter.connect(recorder);
      }

      return new RecordingSession({
        annotationCanvas: videoOutput.annotationCanvas,
        audio,
        canvasCaptureTrack: videoOutput.canvasCaptureTrack,
        crop: { ...config.crop },
        capturePipeline: videoOutput.pipeline,
        encoder: profile.encoder,
        fps: config.fps,
        hardwareCanvasSource: hardwareRecording?.canvasSource ?? null,
        hardwareOutput: hardwareRecording?.output ?? null,
        outputCanvas: videoOutput.canvas,
        outputContext: videoOutput.context,
        outputStream: videoOutput.stream,
        mimeType: profile.mimeType,
        recorder,
        sources,
        videoWriter
      });
    } catch (error) {
      stopTracks(videoOutput?.stream ?? null);
      stopRecordingSources(sources);
      const cleanupResults = await Promise.allSettled([
        audio?.close(),
        videoWriter?.discard(),
        audio?.discardWriters()
      ]);
      throw combinedError("Could not prepare the recording.", [error, ...rejectedReasons(cleanupResults)]);
    }
  }

  private readonly annotationCanvas: HTMLCanvasElement | null;
  private readonly audio: RecordingAudio;
  private readonly canvasCaptureTrack: CanvasCaptureMediaStreamTrack | null;
  private readonly crop: Rect;
  private readonly capturePipeline: CapturePipeline;
  private readonly encoder: RecordingEncoder;
  private readonly errorHandlers = new Set<RecordingSessionErrorHandler>();
  private hasRecordingError = false;
  private recordingError: unknown = null;
  private discardPromise: Promise<void> | null = null;
  private frameEncodingError: unknown = null;
  private readonly frameIntervalMs: number;
  private nextFrameAtMs: number | null = null;
  private frameTimerHandle: ReturnType<typeof setTimeout> | null = null;
  private hasStarted = false;
  private readonly hardwareCanvasSource: CanvasSource | null;
  private readonly hardwareOutput: HardwareRecordingOutput | null;
  private isFinalized = false;
  private isFrameDrawingActive = false;
  private areWritersDiscarded = false;
  private readonly outputCanvas: HTMLCanvasElement | null;
  private readonly outputContext: CanvasRenderingContext2D | null;
  private readonly outputStream: MediaStream;
  private readonly mimeType: string;
  private readonly recorder: MediaRecorder | null;
  private recordingStartedAtMs: number | null = null;
  private readonly sources: RecordingSource[];
  private stopPromise: Promise<RecordingResult> | null = null;
  private readonly videoWriter: RecordingFileWriter;

  private constructor(config: {
    annotationCanvas: HTMLCanvasElement | null;
    audio: RecordingAudio;
    canvasCaptureTrack: CanvasCaptureMediaStreamTrack | null;
    crop: Rect;
    capturePipeline: CapturePipeline;
    encoder: RecordingEncoder;
    fps: VideoFps;
    hardwareCanvasSource: CanvasSource | null;
    hardwareOutput: HardwareRecordingOutput | null;
    outputCanvas: HTMLCanvasElement | null;
    outputContext: CanvasRenderingContext2D | null;
    outputStream: MediaStream;
    mimeType: string;
    recorder: MediaRecorder | null;
    sources: RecordingSource[];
    videoWriter: RecordingFileWriter;
  }) {
    this.annotationCanvas = config.annotationCanvas;
    this.audio = config.audio;
    this.canvasCaptureTrack = config.canvasCaptureTrack;
    this.crop = config.crop;
    this.capturePipeline = config.capturePipeline;
    this.encoder = config.encoder;
    this.frameIntervalMs = millisecondsPerSecond / config.fps;
    this.hardwareCanvasSource = config.hardwareCanvasSource;
    this.hardwareOutput = config.hardwareOutput;
    this.outputCanvas = config.outputCanvas;
    this.outputContext = config.outputContext;
    this.outputStream = config.outputStream;
    this.mimeType = config.mimeType;
    this.recorder = config.recorder;
    this.sources = config.sources;
    this.videoWriter = config.videoWriter;
    this.videoWriter.onError((error): void => {
      this.notifyError(error);
    });
    this.audio.onError((error): void => {
      this.notifyError(error);
    });
    for (const source of this.sources) {
      this.watchStreamTracks(source.stream, "Desktop capture");
    }
  }

  private watchStreamTracks(stream: MediaStream, label: string): void {
    for (const track of stream.getTracks()) {
      const reportEndedTrack = (): void => {
        this.notifyError(new Error(`${label} ended unexpectedly.`));
      };
      track.addEventListener("ended", reportEndedTrack, { once: true });
      if (track.readyState === "ended") {
        reportEndedTrack();
      }
    }
  }

  private notifyError(error: unknown): void {
    if (this.isFinalized || this.hasRecordingError) {
      return;
    }

    this.recordingError = error;
    this.hasRecordingError = true;
    for (const handler of this.errorHandlers) {
      handler(error);
    }
  }

  private startDrawingFrames(): void {
    if (!this.outputCanvas || this.isFrameDrawingActive) {
      return;
    }

    this.isFrameDrawingActive = true;
    this.nextFrameAtMs = performance.now();
    this.queueNextFrame();
  }

  private drawFrame(): void {
    if (!this.outputCanvas || !this.outputContext) {
      return;
    }

    const outputScaleX = this.outputCanvas.width / this.crop.width;
    const outputScaleY = this.outputCanvas.height / this.crop.height;
    this.outputContext.clearRect(0, 0, this.outputCanvas.width, this.outputCanvas.height);
    for (const source of this.sources) {
      const intersection = intersectRects(this.crop, source.bounds);
      if (!intersection) {
        continue;
      }

      const sourceScaleX = source.video.videoWidth / source.bounds.width;
      const sourceScaleY = source.video.videoHeight / source.bounds.height;
      this.outputContext.drawImage(
        source.video,
        (intersection.x - source.bounds.x) * sourceScaleX,
        (intersection.y - source.bounds.y) * sourceScaleY,
        intersection.width * sourceScaleX,
        intersection.height * sourceScaleY,
        (intersection.x - this.crop.x) * outputScaleX,
        (intersection.y - this.crop.y) * outputScaleY,
        intersection.width * outputScaleX,
        intersection.height * outputScaleY
      );
    }
    if (this.annotationCanvas) {
      this.outputContext.drawImage(this.annotationCanvas, 0, 0);
    }

    if (this.recorder) {
      this.canvasCaptureTrack?.requestFrame();
    }
  }

  private queueNextFrame(): void {
    if (this.nextFrameAtMs === null) {
      throw new Error("The recording frame clock has not started.");
    }

    const delayMs = Math.max(0, this.nextFrameAtMs - performance.now());
    this.frameTimerHandle = setTimeout((): void => {
      this.frameTimerHandle = null;
      void this.drawAndEncodeFrame().catch((error: unknown): void => {
        this.frameEncodingError ??= error;
        this.stopFrameDrawing();
        this.notifyError(error);
      });
    }, delayMs);
  }

  private async drawAndEncodeFrame(): Promise<void> {
    this.drawFrame();
    if (this.hardwareCanvasSource && this.recordingStartedAtMs !== null) {
      const timestamp = (performance.now() - this.recordingStartedAtMs) / millisecondsPerSecond;
      await this.hardwareCanvasSource.add(timestamp);
    }

    if (this.isFrameDrawingActive) {
      const currentDeadlineMs = this.nextFrameAtMs ?? performance.now();
      this.nextFrameAtMs = nextRecordingFrameDeadline(currentDeadlineMs, performance.now(), this.frameIntervalMs);
      this.queueNextFrame();
    }
  }

  private recordingDurationSeconds(stoppedAtMs: number): number {
    if (this.recordingStartedAtMs === null) {
      return 0;
    }

    return Math.max(0, (stoppedAtMs - this.recordingStartedAtMs) / millisecondsPerSecond);
  }

  private async stopRecorderIfActive(): Promise<void> {
    if (this.hardwareOutput) {
      this.stopFrameDrawing();
      const errors: unknown[] = [];
      try {
        this.hardwareCanvasSource?.close();
      } catch (error) {
        errors.push(error);
      }

      try {
        await withTimeout(
          this.hardwareOutput.finalize(),
          "Timed out finalizing the hardware video encoder."
        );
      } catch (error) {
        errors.push(error);
      }

      try {
        await this.videoWriter.finalize();
      } catch (error) {
        errors.push(error);
      }

      throwCollectedErrors(errors, "Could not finalize the video recording.");
      return;
    }

    const { recorder } = this;
    if (!recorder) {
      throw new Error("The recording has no video encoder.");
    }

    await stopMediaRecorder(recorder, this.videoWriter);
  }

  private stopFrameDrawing(): void {
    this.isFrameDrawingActive = false;
    this.nextFrameAtMs = null;
    if (this.frameTimerHandle === null) {
      return;
    }

    clearTimeout(this.frameTimerHandle);
    this.frameTimerHandle = null;
  }

  private async discardOnce(): Promise<void> {
    const stopTasks: Array<Promise<void>> = [this.audio.stopRecorders()];
    if (this.hardwareOutput) {
      this.stopFrameDrawing();
      if (this.hardwareOutput.state !== "canceled" && this.hardwareOutput.state !== "finalized") {
        stopTasks.push(withTimeout(
          this.hardwareOutput.cancel(),
          "Timed out canceling the hardware video encoder."
        ));
      }
    } else if (this.recorder?.state !== "inactive") {
      stopTasks.push(this.stopRecorderIfActive());
    }

    const stopResults = await Promise.allSettled(stopTasks);
    const closeResults = await Promise.allSettled([this.audio.close()]);
    this.stopTracks();
    this.isFinalized = true;

    const discardResults = await Promise.allSettled([
      this.videoWriter.discard(),
      this.audio.discardWriters()
    ]);
    const errors = [
      ...rejectedReasons(stopResults),
      ...rejectedReasons(closeResults),
      ...rejectedReasons(discardResults)
    ];
    if (discardResults.every((result) => result.status === "fulfilled")) {
      this.areWritersDiscarded = true;
    }

    throwCollectedErrors(errors, "Could not discard the recording cleanly.");
  }

  private async stopOnce(): Promise<RecordingResult> {
    const durationSeconds = this.recordingDurationSeconds(performance.now());
    const stopResults = await Promise.allSettled([
      this.stopRecorderIfActive(),
      this.audio.stopRecorders()
    ]);
    const closeResults = await Promise.allSettled([this.audio.close()]);
    this.stopTracks();
    this.isFinalized = true;
    const errors = [...rejectedReasons(stopResults), ...rejectedReasons(closeResults)];
    if (this.frameEncodingError) {
      errors.push(this.frameEncodingError);
    }

    throwCollectedErrors(errors, "Could not finalize the recording.");
    return {
      audioTracks: this.audio.recordingTracks(),
      capturePipeline: this.capturePipeline,
      durationSeconds,
      encoder: this.encoder,
      mimeType: this.mimeType,
      recordingId: this.videoWriter.recordingId
    };
  }

  private stopTracks(): void {
    this.stopFrameDrawing();

    stopRecordingSources(this.sources);
    stopTracks(this.outputStream);
  }

  async discard(): Promise<void> {
    if (this.areWritersDiscarded) {
      return;
    }

    if (this.discardPromise) {
      await this.discardPromise;
      return;
    }

    this.discardPromise = this.discardOnce();
    try {
      await this.discardPromise;
    } finally {
      this.discardPromise = null;
    }
  }

  onError(handler: RecordingSessionErrorHandler): () => void {
    this.errorHandlers.add(handler);
    if (this.hasRecordingError) {
      queueMicrotask((): void => {
        if (this.errorHandlers.has(handler)) {
          handler(this.recordingError);
        }
      });
    }

    return (): void => {
      this.errorHandlers.delete(handler);
    };
  }

  async start(): Promise<void> {
    if (this.hasStarted || this.isFinalized) {
      throw new Error("The recording session has already started.");
    }

    this.hasStarted = true;
    this.drawFrame();

    if (this.hardwareOutput) {
      await withTimeout(
        this.hardwareOutput.start(),
        "Timed out starting the hardware video encoder."
      );
      this.recordingStartedAtMs = performance.now();
      this.audio.start();
      this.startDrawingFrames();
      return;
    }

    if (!this.recorder) {
      throw new Error("The recording has no video encoder.");
    }

    this.recordingStartedAtMs = performance.now();
    this.videoWriter.start(this.recorder);
    this.audio.start();
    this.startDrawingFrames();
  }

  async stop(): Promise<RecordingResult> {
    if (!this.hasStarted) {
      throw new Error("The recording session has not started.");
    }

    if (this.stopPromise) {
      return await this.stopPromise;
    }

    if (this.isFinalized) {
      throw new Error("The recording session has already finished.");
    }

    this.stopPromise = this.stopOnce();
    return await this.stopPromise;
  }
}

async function prepareRecordingSources(sources: RecordingSource[], config: RecordingSessionConfig): Promise<void> {
  const displays = displaysInViewport(config.displays, { width: innerWidth, height: innerHeight });
  for (const display of displays) {
    if (!intersectRects(config.crop, display.bounds)) {
      continue;
    }

    const stream = await getCursorlessDesktopStream(display.id, config.fps, sources.length === 0 && config.systemAudioEnabled);
    const video = document.createElement("video");
    sources.push({ bounds: display.bounds, stream, video });
    await prepareSourceVideo(video, stream);
  }
}

function stopRecordingSources(sources: RecordingSource[]): void {
  for (const source of sources) {
    stopTracks(source.stream);
    source.video.pause();
    source.video.srcObject = null;
  }
}

async function prepareSourceVideo(sourceVideo: HTMLVideoElement, sourceStream: MediaStream): Promise<void> {
  sourceVideo.muted = true;
  sourceVideo.playsInline = true;
  sourceVideo.srcObject = sourceStream;
  await playMedia(sourceVideo);
  await waitForMediaMetadata(sourceVideo);
  if (sourceVideo.videoWidth < 1 || sourceVideo.videoHeight < 1) {
    throw new Error("Desktop capture did not provide usable video dimensions.");
  }
}

async function createVideoOutput(
  sources: RecordingSource[],
  config: RecordingSessionConfig,
  outputSize: { height: number; width: number }
): Promise<VideoOutput> {
  const directStream = sources.length === 1 ? await directVideoStream(sources[0], config, outputSize) : null;
  if (directStream) {
    setVideoContentHint(directStream);
    return {
      annotationCanvas: null,
      canvasCaptureTrack: null,
      canvas: null,
      context: null,
      pipeline: "direct",
      stream: directStream
    };
  }

  const canvas = document.createElement("canvas");
  canvas.width = outputSize.width;
  canvas.height = outputSize.height;
  const context = canvas.getContext("2d", {
    alpha: false,
    desynchronized: true
  });
  if (!context) {
    throw new Error("Could not create the recording canvas.");
  }

  const stream = canvas.captureStream(0);
  const canvasCaptureTrack = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined;
  if (!canvasCaptureTrack || typeof canvasCaptureTrack.requestFrame !== "function") {
    stopTracks(stream);
    throw new Error("This system does not support manually paced canvas recording frames.");
  }

  setVideoContentHint(stream);
  return {
    annotationCanvas: createAnnotationCanvas(config.annotations, config.crop, outputSize),
    canvasCaptureTrack,
    canvas,
    context,
    pipeline: "composited",
    stream
  };
}

function createHardwareRecording(
  videoOutput: VideoOutput,
  audioTrack: MediaStreamTrack | null,
  fps: VideoFps,
  bitrate: number,
  fullHardwareVideoCodec: string | null,
  writer: RecordingFileWriter
): HardwareRecording {
  if (!fullHardwareVideoCodec) {
    throw new Error("Hardware recording requires a supported AVC codec.");
  }

  const output = new Output({
    format: new Mp4OutputFormat({
      fastStart: "fragmented",
      minimumFragmentDuration: hardwareFragmentDurationSeconds
    }),
    target: new AppendOnlyStreamTarget(writer.writableStream())
  });
  const encodingConfig = {
    bitrate,
    codec: hardwareVideoCodec,
    contentHint: "detail",
    fullCodecString: fullHardwareVideoCodec,
    hardwareAcceleration: "prefer-hardware",
    keyFrameInterval: hardwareKeyframeIntervalSeconds,
    latencyMode: "realtime"
  } as const;
  let canvasSource: CanvasSource | null = null;
  if (videoOutput.canvas) {
    canvasSource = new CanvasSource(videoOutput.canvas, encodingConfig);
    output.addVideoTrack(canvasSource, { frameRate: fps });
  } else {
    const videoTrack = videoOutput.stream.getVideoTracks().at(0);
    if (!videoTrack) {
      throw new Error("Desktop capture did not provide a video track.");
    }

    const videoSource = new MediaStreamVideoTrackSource(videoTrack, encodingConfig, { frameRate: fps });
    observeHardwareSourceErrors(videoSource.errorPromise, writer);
    output.addVideoTrack(videoSource, { frameRate: fps });
  }

  if (audioTrack) {
    const audioSource = new MediaStreamAudioTrackSource(audioTrack as MediaStreamAudioTrack, {
      bitrate: recordingAudioBitrate,
      codec: "aac"
    });
    observeHardwareSourceErrors(audioSource.errorPromise, writer);
    output.addAudioTrack(audioSource);
  }

  return { canvasSource, output };
}

async function directVideoStream(
  source: RecordingSource,
  config: RecordingSessionConfig,
  outputSize: { height: number; width: number }
): Promise<MediaStream | null> {
  if (config.annotations.length > 0 || !isFullDisplayCrop(config.crop, source.bounds)) {
    return null;
  }

  const track = source.stream.getVideoTracks().at(0);
  if (!track) {
    throw new Error("Desktop capture did not provide a video track.");
  }

  try {
    await track.applyConstraints({
      frameRate: config.fps,
      height: outputSize.height,
      width: outputSize.width
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "OverconstrainedError") {
      return null;
    }

    throw error;
  }

  const settings = track.getSettings();
  if (settings.width !== outputSize.width || settings.height !== outputSize.height) {
    return null;
  }

  return new MediaStream([track]);
}

function createAnnotationCanvas(
  annotations: Annotation[],
  crop: Rect,
  outputSize: { height: number; width: number }
): HTMLCanvasElement | null {
  if (annotations.length === 0) {
    return null;
  }

  const canvas = document.createElement("canvas");
  canvas.width = outputSize.width;
  canvas.height = outputSize.height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Could not create the recording annotation canvas.");
  }

  drawAnnotations(context, annotations, {
    clip: crop,
    offset: { x: crop.x, y: crop.y },
    scale: {
      x: outputSize.width / crop.width,
      y: outputSize.height / crop.height
    }
  });
  return canvas;
}

function isFullDisplayCrop(crop: Rect, bounds: Rect): boolean {
  return Math.abs(crop.x - bounds.x) <= fullDisplayCropTolerancePx
    && Math.abs(crop.y - bounds.y) <= fullDisplayCropTolerancePx
    && Math.abs(crop.width - bounds.width) <= fullDisplayCropTolerancePx
    && Math.abs(crop.height - bounds.height) <= fullDisplayCropTolerancePx;
}

function setVideoContentHint(stream: MediaStream): void {
  for (const track of stream.getVideoTracks()) {
    track.contentHint = "detail";
  }
}

function observeHardwareSourceErrors(errorPromise: Promise<void>, writer: RecordingFileWriter): void {
  void errorPromise.catch((error: unknown): void => {
    writer.reportEncoderError(error);
  });
}

async function withTimeout<T>(operation: Promise<T>, timeoutMessage: string): Promise<T> {
  const { promise: timeout, reject } = Promise.withResolvers<never>();
  const timeoutHandle = setTimeout((): void => {
    reject(new Error(timeoutMessage));
  }, hardwareOperationTimeoutMs);
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}
