import {
  AppendOnlyStreamTarget,
  CanvasSource,
  MediaStreamAudioTrackSource,
  MediaStreamVideoTrackSource,
  Mp4OutputFormat,
  Output
} from "mediabunny";

import { microphoneConstraints } from "./audio-devices.js";
import { getCursorlessDesktopStream, stopTracks } from "./desktop-capture.js";
import { drawAnnotations } from "./overlay-drawing.js";
import type { Annotation } from "./overlay-model.js";
import { RecordingFileWriter } from "./recording-file-writer.js";
import type { AudioSourceKind, RecordingAudioTrack, RecordingEncoder, Rect, VideoFps, VideoQuality } from "./shared.js";
import { videoQualityHeights } from "./shared.js";
import { recordingVideoBitrate } from "./video-bitrate.js";
import { selectVideoRecorderProfile } from "./video-recorder-profile.js";

const minimumVideoDimensionPx = 2;
const millisecondsPerSecond = 1000;
const supportedAudioMimeTypes = ["audio/webm;codecs=opus", "audio/webm"] as const;
const hardwareVideoCodec = "avc";
const hardwareVideoCodecString = "avc1.640028";
const hardwareAudioBitrate = 192_000;
const hardwareKeyframeIntervalSeconds = 2;
const hardwareFragmentDurationSeconds = 1;

type HardwareRecordingOutput = Output<Mp4OutputFormat, AppendOnlyStreamTarget>;

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
  canvas: HTMLCanvasElement | null;
  context: CanvasRenderingContext2D | null;
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
      const outputSize = videoOutputSize(config.crop, config.quality, sourceVideo);
      const bitrate = recordingVideoBitrate(config.quality, config.fps);
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
        ? createHardwareRecording(videoOutput, embeddedAudioMix.track, config.fps, bitrate, videoWriter)
        : null;
      const recorder = hardwareRecording
        ? null
        : new MediaRecorder(videoOutput.stream, {
          mimeType: profile.mimeType,
          videoBitsPerSecond: bitrate
        });
      if (recorder) {
        videoWriter.connect(recorder);
      }

      const session = new RecordingSession({
        audioRecorders,
        annotationCanvas: videoOutput.annotationCanvas,
        crop: { ...config.crop },
        embeddedAudioContext: embeddedAudioMix.context,
        encoder: profile.encoder,
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
      session.connectRecorder();
      return session;
    } catch (error) {
      stopTracks(microphoneStream);
      stopTracks(sourceStream);
      if (embeddedAudioContext?.state !== "closed") {
        await embeddedAudioContext?.close();
      }
      await discardWriters(videoWriter, audioRecorders);
      throw error;
    }
  }

  private readonly annotationCanvas: HTMLCanvasElement | null;
  private readonly audioRecorders: AudioRecorder[];
  private readonly crop: Rect;
  private readonly embeddedAudioContext: AudioContext | null;
  private readonly encoder: RecordingEncoder;
  private frameCallbackHandle: number | null = null;
  private readonly hardwareCanvasSource: CanvasSource | null;
  private readonly hardwareOutput: HardwareRecordingOutput | null;
  private isFinalized = false;
  private readonly outputCanvas: HTMLCanvasElement | null;
  private readonly outputContext: CanvasRenderingContext2D | null;
  private readonly outputStream: MediaStream;
  private readonly mimeType: string;
  private readonly microphoneStream: MediaStream | null;
  private readonly recorder: MediaRecorder | null;
  private recordingStartedAtMs: number | null = null;
  private readonly sourceStream: MediaStream;
  private readonly sourceVideo: HTMLVideoElement;
  private readonly videoWriter: RecordingFileWriter;

  private constructor(config: {
    annotationCanvas: HTMLCanvasElement | null;
    audioRecorders: AudioRecorder[];
    crop: Rect;
    embeddedAudioContext: AudioContext | null;
    encoder: RecordingEncoder;
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
    this.crop = config.crop;
    this.embeddedAudioContext = config.embeddedAudioContext;
    this.encoder = config.encoder;
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
  }

  private connectRecorder(): void {
    if (!this.recorder) {
      return;
    }

    this.recorder.addEventListener("start", () => {
      this.startDrawingFrames();
    });
  }

  private startDrawingFrames(): void {
    if (!this.outputCanvas) {
      return;
    }

    this.drawFrame();
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
  }

  private queueNextFrame(): void {
    this.frameCallbackHandle = this.sourceVideo.requestVideoFrameCallback((): void => {
      void this.drawAndEncodeFrame();
    });
  }

  private async drawAndEncodeFrame(): Promise<void> {
    this.drawFrame();
    if (this.hardwareCanvasSource && this.recordingStartedAtMs !== null) {
      const timestamp = (performance.now() - this.recordingStartedAtMs) / millisecondsPerSecond;
      await this.hardwareCanvasSource.add(timestamp);
    }

    if (this.frameCallbackHandle !== null) {
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
      this.hardwareCanvasSource?.close();
      await this.hardwareOutput.finalize();
      await this.videoWriter.finalize();
      return;
    }

    const { recorder } = this;
    if (!recorder) {
      throw new Error("The recording has no video encoder.");
    }

    if (recorder.state === "inactive") {
      await this.videoWriter.finalize();
      return;
    }

    const stopped = new Promise<void>((resolve) => {
      recorder.addEventListener(
        "stop",
        () => {
          resolve();
        },
        { once: true }
      );
    });
    recorder.stop();
    await stopped;
    await this.videoWriter.finalize();
  }

  private async stopAudioRecorders(): Promise<void> {
    await Promise.all(this.audioRecorders.map(async (audioRecorder) => {
      await stopRecorder(audioRecorder.recorder, audioRecorder.writer);
    }));
  }

  private async closeEmbeddedAudioContext(): Promise<void> {
    if (!this.embeddedAudioContext || this.embeddedAudioContext.state === "closed") {
      return;
    }

    await this.embeddedAudioContext.close();
  }

  private stopFrameDrawing(): void {
    if (this.frameCallbackHandle === null) {
      return;
    }

    this.sourceVideo.cancelVideoFrameCallback(this.frameCallbackHandle);
    this.frameCallbackHandle = null;
  }

  async discard(): Promise<void> {
    if (this.hardwareOutput) {
      this.stopFrameDrawing();
      if (this.hardwareOutput.state !== "canceled" && this.hardwareOutput.state !== "finalized") {
        await this.hardwareOutput.cancel();
      }
    } else {
      await this.stopRecorderIfActive();
    }

    await this.stopAudioRecorders();
    await this.closeEmbeddedAudioContext();
    this.stopTracks();

    if (this.isFinalized) {
      return;
    }

    await discardWriters(this.videoWriter, this.audioRecorders);
    this.isFinalized = true;
  }

  async start(): Promise<void> {
    this.drawFrame();
    for (const audioRecorder of this.audioRecorders) {
      audioRecorder.writer.start(audioRecorder.recorder);
    }

    if (this.hardwareOutput) {
      await this.hardwareOutput.start();
      this.recordingStartedAtMs = performance.now();
      this.startDrawingFrames();
      return;
    }

    if (!this.recorder) {
      throw new Error("The recording has no video encoder.");
    }

    this.recordingStartedAtMs = performance.now();
    this.videoWriter.start(this.recorder);
  }

  async stop(): Promise<RecordingResult> {
    if (!this.hardwareOutput && this.recorder?.state === "inactive") {
      return {
        audioTracks: [],
        durationSeconds: 0,
        encoder: this.encoder,
        mimeType: this.mimeType,
        recordingId: this.videoWriter.recordingId
      };
    }

    const durationSeconds = this.recordingDurationSeconds(performance.now());
    await this.stopRecorderIfActive();
    await this.stopAudioRecorders();
    await this.closeEmbeddedAudioContext();
    this.isFinalized = true;
    return {
      audioTracks: this.audioRecorders.map((audioRecorder) => ({
        kind: audioRecorder.kind,
        mimeType: audioRecorder.mimeType,
        recordingId: audioRecorder.writer.recordingId
      })),
      durationSeconds,
      encoder: this.encoder,
      mimeType: this.mimeType,
      recordingId: this.videoWriter.recordingId
    };
  }

  stopTracks(): void {
    this.stopFrameDrawing();

    stopTracks(this.sourceStream);
    stopTracks(this.microphoneStream);
    stopTracks(this.outputStream);
  }
}

async function audioRecorderFromTrack(kind: AudioSourceKind, track: MediaStreamTrack): Promise<AudioRecorder> {
  const stream = new MediaStream([track]);
  const mimeType = supportedAudioMimeType();
  const writer = await RecordingFileWriter.create("webm");
  try {
    const recorder = new MediaRecorder(stream, { mimeType });
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
  await sourceVideo.play();
  await waitForVideoMetadata(sourceVideo);
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

  const context = new AudioContext();
  const destination = context.createMediaStreamDestination();
  for (const track of tracks) {
    context.createMediaStreamSource(new MediaStream([track])).connect(destination);
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
      canvas: null,
      context: null,
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

  const stream = canvas.captureStream(config.fps);
  setVideoContentHint(stream);
  return {
    annotationCanvas: createAnnotationCanvas(config.annotations, config.crop, outputSize),
    canvas,
    context,
    stream
  };
}

function createHardwareRecording(
  videoOutput: VideoOutput,
  audioTrack: MediaStreamTrack | null,
  fps: VideoFps,
  bitrate: number,
  writer: RecordingFileWriter
): HardwareRecording {
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
    fullCodecString: hardwareVideoCodecString,
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

    output.addVideoTrack(
      new MediaStreamVideoTrackSource(videoTrack, encodingConfig, { frameRate: fps }),
      { frameRate: fps }
    );
  }

  if (audioTrack) {
    output.addAudioTrack(new MediaStreamAudioTrackSource(audioTrack as MediaStreamAudioTrack, {
      bitrate: hardwareAudioBitrate,
      codec: "aac"
    }));
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
  } catch {
    return null;
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
  await Promise.all([
    videoWriter?.discard(),
    ...audioRecorders.map(async (audioRecorder) => {
      await audioRecorder.writer.discard();
    })
  ]);
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

async function stopRecorder(recorder: MediaRecorder, writer: RecordingFileWriter): Promise<void> {
  if (recorder.state === "inactive") {
    await writer.finalize();
    return;
  }

  const stopped = new Promise<void>((resolve) => {
    recorder.addEventListener(
      "stop",
      () => {
        resolve();
      },
      { once: true }
    );
  });
  recorder.stop();
  await stopped;
  await writer.finalize();
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

function videoOutputSize(rect: Rect, selectedQuality: VideoQuality, sourceVideo: HTMLVideoElement): { height: number; width: number } {
  const targetHeight = selectedQuality === "720p" ? videoQualityHeights.low : videoQualityHeights.high;
  const sourceWidth = rect.width * sourceVideo.videoWidth / window.innerWidth;
  const sourceHeight = rect.height * sourceVideo.videoHeight / window.innerHeight;
  const outputScale = Math.min(1, targetHeight / sourceHeight);
  return {
    height: evenVideoDimension(sourceHeight * outputScale),
    width: evenVideoDimension(sourceWidth * outputScale)
  };
}

function evenVideoDimension(value: number): number {
  return Math.max(minimumVideoDimensionPx, Math.round(value / minimumVideoDimensionPx) * minimumVideoDimensionPx);
}

async function waitForVideoMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.videoWidth > 0 && video.videoHeight > 0) {
    return;
  }

  await new Promise<void>((resolve) => {
    video.addEventListener("loadedmetadata", () => {
      resolve();
    }, { once: true });
  });
}
