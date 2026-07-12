import {
  AppendOnlyStreamTarget,
  CanvasSource,
  MediaStreamAudioTrackSource,
  MediaStreamVideoTrackSource,
  Mp4OutputFormat,
  Output
} from "mediabunny";

import { microphoneConstraints } from "./audio-devices.js";
import { audioMixGain, recordingAudioBitrate, recordingAudioSampleRate } from "./audio-quality.js";
import { getCursorlessDesktopStream, stopTracks } from "./desktop-capture.js";
import { playMedia, waitForMediaMetadata } from "./media-element.js";
import { drawAnnotations } from "./overlay-drawing.js";
import type { Annotation } from "./overlay-model.js";
import { RecordingFileWriter, stopMediaRecorder } from "./recording-file-writer.js";
import { nextRecordingFrameDeadline } from "./recording-frame-clock.js";
import { recordingOutputSize } from "./recording-output-size.js";
import type { AudioSourceKind, CapturePipeline, RecordingAudioTrack, RecordingEncoder, Rect, VideoFps, VideoQuality } from "./shared.js";
import { videoBitrate } from "./video-bitrate.js";
import { selectVideoRecorderProfile } from "./video-recorder-profile.js";

const millisecondsPerSecond = 1000;
const supportedAudioMimeTypes = ["audio/webm;codecs=opus", "audio/webm"] as const;
const hardwareVideoCodec = "avc";
const hardwareKeyframeIntervalSeconds = 2;
const hardwareFragmentDurationSeconds = 1;
const hardwareOperationTimeoutMs = 15_000;

type HardwareRecordingOutput = Output<Mp4OutputFormat, AppendOnlyStreamTarget>;
type RecordingSessionErrorHandler = (error: unknown) => void;

export interface RecordingSessionConfig {
  annotations: Annotation[];
  crop: Rect;
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

interface AudioRecorder {
  kind: AudioSourceKind;
  mimeType: string;
  recorder: MediaRecorder;
  writer: RecordingFileWriter;
}

interface VideoOutput {
  annotationCanvas: HTMLCanvasElement | null;
  canvasCaptureTrack: CanvasCaptureMediaStreamTrack | null;
  canvas: HTMLCanvasElement | null;
  context: CanvasRenderingContext2D | null;
  pipeline: CapturePipeline;
  stream: MediaStream;
}

interface EmbeddedAudioMix {
  context: AudioContext | null;
  track: MediaStreamTrack | null;
}

interface HardwareRecording {
  canvasSource: CanvasSource | null;
  output: HardwareRecordingOutput;
}

export class RecordingSession {
  static async create(config: RecordingSessionConfig): Promise<RecordingSession> {
    let videoWriter: RecordingFileWriter | null = null;
    const audioRecorders: AudioRecorder[] = [];
    let embeddedAudioContext: AudioContext | null = null;
    let microphoneStream: MediaStream | null = null;
    let sourceStream: MediaStream | null = null;
    try {
      sourceStream = await getCursorlessDesktopStream(config.fps, config.systemAudioEnabled);
      if (config.systemAudioEnabled) {
        audioRecorders.push(await audioRecorderFromTrack("system", systemAudioTrack(sourceStream)));
      }

      microphoneStream = await getMicrophoneStream(config.microphoneDeviceId);
      if (microphoneStream) {
        audioRecorders.push(await audioRecorderFromTrack("microphone", microphoneAudioTrack(microphoneStream)));
      }

      const sourceVideo = await createSourceVideo(sourceStream);
      const outputSize = recordingOutputSize(
        config.crop,
        config.quality,
        { height: sourceVideo.videoHeight, width: sourceVideo.videoWidth },
        { height: window.innerHeight, width: window.innerWidth }
      );
      const bitrate = videoBitrate(outputSize.width, outputSize.height, config.fps);
      const profile = await selectVideoRecorderProfile(
        outputSize.width,
        outputSize.height,
        config.fps,
        bitrate,
        audioRecorders.length > 0
      );
      videoWriter = await RecordingFileWriter.create(profile.fileExtension);
      const videoOutput = await createVideoOutput(sourceStream, config, outputSize);
      const embeddedAudioMix = await createEmbeddedAudioMix(audioRecorders);
      embeddedAudioContext = embeddedAudioMix.context;
      if (embeddedAudioMix.track) {
        videoOutput.stream.addTrack(embeddedAudioMix.track);
      }

      const hardwareRecording = profile.encoder === "hardware"
        ? createHardwareRecording(
          videoOutput,
          embeddedAudioMix.track,
          config.fps,
          bitrate,
          profile.hardwareVideoCodec,
          videoWriter
        )
        : null;
      const recorder = hardwareRecording
        ? null
        : new MediaRecorder(videoOutput.stream, {
          ...(embeddedAudioMix.track && { audioBitsPerSecond: recordingAudioBitrate }),
          mimeType: profile.mimeType,
          videoBitsPerSecond: bitrate
        });
      if (recorder) {
        videoWriter.connect(recorder);
      }

      const session = new RecordingSession({
        audioRecorders,
        annotationCanvas: videoOutput.annotationCanvas,
        canvasCaptureTrack: videoOutput.canvasCaptureTrack,
        crop: { ...config.crop },
        capturePipeline: videoOutput.pipeline,
        embeddedAudioContext: embeddedAudioMix.context,
        encoder: profile.encoder,
        fps: config.fps,
        hardwareCanvasSource: hardwareRecording?.canvasSource ?? null,
        hardwareOutput: hardwareRecording?.output ?? null,
        outputCanvas: videoOutput.canvas,
        outputContext: videoOutput.context,
        outputStream: videoOutput.stream,
        mimeType: profile.mimeType,
        microphoneStream,
        recorder,
        sourceStream,
        sourceVideo,
        videoWriter
      });
      return session;
    } catch (error) {
      stopTracks(microphoneStream);
      stopTracks(sourceStream);
      const errors: [unknown, ...unknown[]] = [error];
      try {
        if (embeddedAudioContext?.state !== "closed") {
          await embeddedAudioContext?.close();
        }
      } catch (cleanupError) {
        errors.push(cleanupError);
      }

      try {
        await discardWriters(videoWriter, audioRecorders);
      } catch (cleanupError) {
        errors.push(cleanupError);
      }

      return throwCollectedErrors(errors, "Could not prepare the recording.");
    }
  }

  private readonly annotationCanvas: HTMLCanvasElement | null;
  private readonly audioRecorders: AudioRecorder[];
  private readonly canvasCaptureTrack: CanvasCaptureMediaStreamTrack | null;
  private readonly crop: Rect;
  private readonly capturePipeline: CapturePipeline;
  private readonly embeddedAudioContext: AudioContext | null;
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
  private readonly microphoneStream: MediaStream | null;
  private readonly recorder: MediaRecorder | null;
  private recordingStartedAtMs: number | null = null;
  private readonly sourceStream: MediaStream;
  private readonly sourceVideo: HTMLVideoElement;
  private stopPromise: Promise<RecordingResult> | null = null;
  private readonly videoWriter: RecordingFileWriter;

  private constructor(config: {
    annotationCanvas: HTMLCanvasElement | null;
    audioRecorders: AudioRecorder[];
    canvasCaptureTrack: CanvasCaptureMediaStreamTrack | null;
    crop: Rect;
    capturePipeline: CapturePipeline;
    embeddedAudioContext: AudioContext | null;
    encoder: RecordingEncoder;
    fps: VideoFps;
    hardwareCanvasSource: CanvasSource | null;
    hardwareOutput: HardwareRecordingOutput | null;
    outputCanvas: HTMLCanvasElement | null;
    outputContext: CanvasRenderingContext2D | null;
    outputStream: MediaStream;
    mimeType: string;
    microphoneStream: MediaStream | null;
    recorder: MediaRecorder | null;
    sourceStream: MediaStream;
    sourceVideo: HTMLVideoElement;
    videoWriter: RecordingFileWriter;
  }) {
    this.annotationCanvas = config.annotationCanvas;
    this.audioRecorders = config.audioRecorders;
    this.canvasCaptureTrack = config.canvasCaptureTrack;
    this.crop = config.crop;
    this.capturePipeline = config.capturePipeline;
    this.embeddedAudioContext = config.embeddedAudioContext;
    this.encoder = config.encoder;
    this.frameIntervalMs = millisecondsPerSecond / config.fps;
    this.hardwareCanvasSource = config.hardwareCanvasSource;
    this.hardwareOutput = config.hardwareOutput;
    this.outputCanvas = config.outputCanvas;
    this.outputContext = config.outputContext;
    this.outputStream = config.outputStream;
    this.mimeType = config.mimeType;
    this.microphoneStream = config.microphoneStream;
    this.recorder = config.recorder;
    this.sourceStream = config.sourceStream;
    this.sourceVideo = config.sourceVideo;
    this.videoWriter = config.videoWriter;
    const writers = [this.videoWriter, ...this.audioRecorders.map((audioRecorder) => audioRecorder.writer)];
    for (const writer of writers) {
      writer.onError((error): void => {
        this.notifyError(error);
      });
    }

    this.watchStreamTracks(this.sourceStream, "Desktop capture");
    if (this.microphoneStream) {
      this.watchStreamTracks(this.microphoneStream, "Microphone capture");
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

    const sourceScaleX = this.sourceVideo.videoWidth / window.innerWidth;
    const sourceScaleY = this.sourceVideo.videoHeight / window.innerHeight;
    this.outputContext.clearRect(0, 0, this.outputCanvas.width, this.outputCanvas.height);
    this.outputContext.drawImage(
      this.sourceVideo,
      this.crop.x * sourceScaleX,
      this.crop.y * sourceScaleY,
      this.crop.width * sourceScaleX,
      this.crop.height * sourceScaleY,
      0,
      0,
      this.outputCanvas.width,
      this.outputCanvas.height
    );
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

  private async stopAudioRecorders(): Promise<void> {
    const results = await Promise.allSettled(this.audioRecorders.map(async (audioRecorder) => {
      await stopMediaRecorder(audioRecorder.recorder, audioRecorder.writer);
    }));
    throwCollectedErrors(rejectedReasons(results), "Could not finalize the recording audio.");
  }

  private async closeEmbeddedAudioContext(): Promise<void> {
    if (!this.embeddedAudioContext || this.embeddedAudioContext.state === "closed") {
      return;
    }

    await this.embeddedAudioContext.close();
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
    const cleanupTasks: Array<Promise<void>> = [];
    if (this.hardwareOutput) {
      this.stopFrameDrawing();
      if (this.hardwareOutput.state !== "canceled" && this.hardwareOutput.state !== "finalized") {
        cleanupTasks.push(withTimeout(
          this.hardwareOutput.cancel(),
          "Timed out canceling the hardware video encoder."
        ));
      }
    } else if (this.recorder?.state !== "inactive") {
      cleanupTasks.push(this.stopRecorderIfActive());
    }

    for (const audioRecorder of this.audioRecorders) {
      if (audioRecorder.recorder.state !== "inactive") {
        cleanupTasks.push(stopMediaRecorder(audioRecorder.recorder, audioRecorder.writer));
      }
    }

    cleanupTasks.push(this.closeEmbeddedAudioContext());
    const cleanupResults = await Promise.allSettled(cleanupTasks);
    this.stopTracks();
    this.isFinalized = true;

    const discardResults = await Promise.allSettled([
      this.videoWriter.discard(),
      ...this.audioRecorders.map(async (audioRecorder) => await audioRecorder.writer.discard())
    ]);
    const errors = [...rejectedReasons(cleanupResults), ...rejectedReasons(discardResults)];
    if (discardResults.every((result) => result.status === "fulfilled")) {
      this.areWritersDiscarded = true;
    }

    throwCollectedErrors(errors, "Could not discard the recording cleanly.");
  }

  private startAudioRecorders(): void {
    for (const audioRecorder of this.audioRecorders) {
      audioRecorder.writer.start(audioRecorder.recorder);
    }
  }

  private async stopOnce(): Promise<RecordingResult> {
    const durationSeconds = this.recordingDurationSeconds(performance.now());
    const stopResults = await Promise.allSettled([
      this.stopRecorderIfActive(),
      this.stopAudioRecorders()
    ]);
    const contextResult = await Promise.allSettled([this.closeEmbeddedAudioContext()]);
    this.stopTracks();
    this.isFinalized = true;
    const errors = [...rejectedReasons(stopResults), ...rejectedReasons(contextResult)];
    if (this.frameEncodingError) {
      errors.push(this.frameEncodingError);
    }

    throwCollectedErrors(errors, "Could not finalize the recording.");
    return {
      audioTracks: this.audioRecorders.map((audioRecorder) => ({
        kind: audioRecorder.kind,
        mimeType: audioRecorder.mimeType,
        recordingId: audioRecorder.writer.recordingId
      })),
      capturePipeline: this.capturePipeline,
      durationSeconds,
      encoder: this.encoder,
      mimeType: this.mimeType,
      recordingId: this.videoWriter.recordingId
    };
  }

  private stopTracks(): void {
    this.stopFrameDrawing();

    stopTracks(this.sourceStream);
    stopTracks(this.microphoneStream);
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
      this.startAudioRecorders();
      this.startDrawingFrames();
      return;
    }

    if (!this.recorder) {
      throw new Error("The recording has no video encoder.");
    }

    this.recordingStartedAtMs = performance.now();
    this.videoWriter.start(this.recorder);
    this.startAudioRecorders();
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

async function audioRecorderFromTrack(kind: AudioSourceKind, track: MediaStreamTrack): Promise<AudioRecorder> {
  const stream = new MediaStream([track]);
  const mimeType = supportedAudioMimeType();
  const writer = await RecordingFileWriter.create("webm");
  try {
    const recorder = new MediaRecorder(stream, {
      audioBitsPerSecond: recordingAudioBitrate,
      mimeType
    });
    writer.connect(recorder);
    return {
      kind,
      mimeType,
      recorder,
      writer
    };
  } catch (error) {
    await writer.discard();
    throw error;
  }
}

async function createSourceVideo(sourceStream: MediaStream): Promise<HTMLVideoElement> {
  const sourceVideo = document.createElement("video");
  sourceVideo.muted = true;
  sourceVideo.playsInline = true;
  sourceVideo.srcObject = sourceStream;
  await playMedia(sourceVideo);
  await waitForMediaMetadata(sourceVideo);
  if (sourceVideo.videoWidth < 1 || sourceVideo.videoHeight < 1) {
    throw new Error("Desktop capture did not provide usable video dimensions.");
  }
  return sourceVideo;
}

async function createEmbeddedAudioMix(audioRecorders: AudioRecorder[]): Promise<EmbeddedAudioMix> {
  const tracks = audioRecorders.flatMap((audioRecorder) => audioRecorder.recorder.stream.getAudioTracks());
  if (tracks.length === 0) {
    return { context: null, track: null };
  }

  if (tracks.length === 1) {
    return { context: null, track: tracks[0] };
  }

  const context = new AudioContext({ sampleRate: recordingAudioSampleRate });
  const destination = context.createMediaStreamDestination();
  const gain = context.createGain();
  gain.gain.value = audioMixGain(tracks.length);
  gain.connect(destination);
  for (const track of tracks) {
    context.createMediaStreamSource(new MediaStream([track])).connect(gain);
  }

  await context.resume();
  return { context, track: destination.stream.getAudioTracks()[0] };
}

async function createVideoOutput(
  sourceStream: MediaStream,
  config: RecordingSessionConfig,
  outputSize: { height: number; width: number }
): Promise<VideoOutput> {
  const directStream = await directVideoStream(sourceStream, config, outputSize);
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
  sourceStream: MediaStream,
  config: RecordingSessionConfig,
  outputSize: { height: number; width: number }
): Promise<MediaStream | null> {
  if (config.annotations.length > 0 || !isFullViewportCrop(config.crop)) {
    return null;
  }

  const track = sourceStream.getVideoTracks().at(0);
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

function isFullViewportCrop(crop: Rect): boolean {
  return crop.x <= 0
    && crop.y <= 0
    && crop.width >= window.innerWidth
    && crop.height >= window.innerHeight;
}

function setVideoContentHint(stream: MediaStream): void {
  for (const track of stream.getVideoTracks()) {
    track.contentHint = "detail";
  }
}

async function discardWriters(videoWriter: RecordingFileWriter | null, audioRecorders: AudioRecorder[]): Promise<void> {
  const results = await Promise.allSettled([
    videoWriter?.discard(),
    ...audioRecorders.map(async (audioRecorder) => {
      await audioRecorder.writer.discard();
    })
  ]);
  throwCollectedErrors(rejectedReasons(results), "Could not discard temporary recording files.");
}

async function getMicrophoneStream(deviceId: string | null): Promise<MediaStream | null> {
  if (deviceId === null) {
    return null;
  }

  return await navigator.mediaDevices.getUserMedia({
    audio: microphoneConstraints(deviceId),
    video: false
  });
}

function microphoneAudioTrack(microphoneStream: MediaStream): MediaStreamTrack {
  const tracks = microphoneStream.getAudioTracks();
  if (tracks.length === 0) {
    throw new Error("The selected microphone did not provide an audio track.");
  }

  return tracks[0];
}

function systemAudioTrack(sourceStream: MediaStream): MediaStreamTrack {
  const tracks = sourceStream.getAudioTracks();
  if (tracks.length === 0) {
    throw new Error("Desktop audio capture is enabled, but Windows did not provide a desktop audio track.");
  }

  return tracks[0];
}

function supportedAudioMimeType(): string {
  const supported = supportedAudioMimeTypes.find((type) => MediaRecorder.isTypeSupported(type));
  if (!supported) {
    throw new Error("This system does not support WebM audio recording through MediaRecorder.");
  }

  return supported;
}

function rejectedReasons(results: Array<PromiseSettledResult<void>>): unknown[] {
  const reasons: unknown[] = [];
  for (const result of results) {
    if (result.status === "rejected") {
      reasons.push(result.reason as unknown);
    }
  }

  return reasons;
}

function observeHardwareSourceErrors(errorPromise: Promise<void>, writer: RecordingFileWriter): void {
  void errorPromise.catch((error: unknown): void => {
    writer.reportEncoderError(error);
  });
}

function throwCollectedErrors(errors: [unknown, ...unknown[]], message: string): never;
function throwCollectedErrors(errors: unknown[], message: string): void;
function throwCollectedErrors(errors: unknown[], message: string): void {
  if (errors.length === 0) {
    return;
  }

  const details = errors.map((error) => error instanceof Error ? error.message : String(error)).join("\n");
  throw new AggregateError(errors, `${message}\n${details}`);
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
