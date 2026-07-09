import { microphoneConstraints } from "./audio-devices.js";
import { getCursorlessDesktopStream, stopTracks } from "./desktop-capture.js";
import { drawAnnotations } from "./overlay-drawing.js";
import type { Annotation } from "./overlay-model.js";
import { RecordingFileWriter } from "./recording-file-writer.js";
import type { AudioSourceKind, RecordingAudioTrack, Rect, VideoFps, VideoQuality } from "./shared.js";
import { videoFpsOptions, videoQualityHeights } from "./shared.js";

const highQualityBitrate = 10_000_000;
const standardQualityBitrate = 5_000_000;
const highFpsBitrateMultiplier = 1.5;
const minimumVideoDimensionPx = 2;
const millisecondsPerSecond = 1000;
const supportedMimeTypes = ["video/webm;codecs=vp8", "video/webm;codecs=vp9", "video/webm"] as const;
const supportedAudioMimeTypes = ["audio/webm;codecs=opus", "audio/webm"] as const;

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
  mimeType: string;
  recordingId: string;
}

interface AudioRecorder {
  kind: AudioSourceKind;
  mimeType: string;
  recorder: MediaRecorder;
  writer: RecordingFileWriter;
}

export class RecordingSession {
  static async create(config: RecordingSessionConfig): Promise<RecordingSession> {
    const videoWriter = await RecordingFileWriter.create();
    const audioRecorders: AudioRecorder[] = [];
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
      const outputSize = videoOutputSize(config.crop, config.quality);
      const outputCanvas = document.createElement("canvas");
      outputCanvas.width = outputSize.width;
      outputCanvas.height = outputSize.height;

      const outputContext = outputCanvas.getContext("2d", {
        alpha: false,
        desynchronized: true
      });
      if (!outputContext) {
        throw new Error("Could not create the recording canvas.");
      }

      const outputStream = outputCanvas.captureStream(config.fps);
      const mimeType = supportedVideoMimeType();
      const recorder = new MediaRecorder(outputStream, {
        mimeType,
        videoBitsPerSecond: videoBitrate(config.quality, config.fps)
      });
      videoWriter.connect(recorder);
      const session = new RecordingSession({
        audioRecorders,
        crop: { ...config.crop },
        frameIntervalMs: millisecondsPerSecond / config.fps,
        outputCanvas,
        outputContext,
        outputStream,
        mimeType,
        microphoneStream,
        recorder,
        sourceStream,
        sourceVideo,
        videoWriter
      });
      session.connectRecorder(config.annotations);
      return session;
    } catch (error) {
      stopTracks(microphoneStream);
      stopTracks(sourceStream);
      await discardWriters(videoWriter, audioRecorders);
      throw error;
    }
  }

  private animationHandle: number | null = null;
  private readonly audioRecorders: AudioRecorder[];
  private readonly crop: Rect;
  private readonly frameIntervalMs: number;
  private isFinalized = false;
  private nextFrameDueAtMs: number | null = null;
  private readonly outputCanvas: HTMLCanvasElement;
  private readonly outputContext: CanvasRenderingContext2D;
  private readonly outputStream: MediaStream;
  private readonly mimeType: string;
  private readonly microphoneStream: MediaStream | null;
  private readonly recorder: MediaRecorder;
  private recordingStartedAtMs: number | null = null;
  private readonly sourceStream: MediaStream;
  private readonly sourceVideo: HTMLVideoElement;
  private readonly videoWriter: RecordingFileWriter;

  private constructor(config: {
    audioRecorders: AudioRecorder[];
    crop: Rect;
    frameIntervalMs: number;
    outputCanvas: HTMLCanvasElement;
    outputContext: CanvasRenderingContext2D;
    outputStream: MediaStream;
    mimeType: string;
    microphoneStream: MediaStream | null;
    recorder: MediaRecorder;
    sourceStream: MediaStream;
    sourceVideo: HTMLVideoElement;
    videoWriter: RecordingFileWriter;
  }) {
    this.audioRecorders = config.audioRecorders;
    this.crop = config.crop;
    this.frameIntervalMs = config.frameIntervalMs;
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

  private connectRecorder(annotations: Annotation[]): void {
    this.recorder.addEventListener("start", () => {
      this.drawFrameWithAnnotations(annotations);
      this.queueNextFrame(annotations);
    });
  }

  private drawFrame(): void {
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
  }

  private drawFrameWithAnnotations(annotations: Annotation[]): void {
    this.drawFrame();
    drawAnnotations(this.outputContext, annotations, {
      clip: this.crop,
      offset: { x: this.crop.x, y: this.crop.y },
      scale: {
        x: this.outputCanvas.width / this.crop.width,
        y: this.outputCanvas.height / this.crop.height
      }
    });
  }

  private queueNextFrame(annotations: Annotation[]): void {
    this.animationHandle = requestAnimationFrame((timestamp): void => {
      this.updateFrame(annotations, timestamp);
    });
  }

  private updateFrame(annotations: Annotation[], timestamp: number): void {
    if (this.shouldDrawFrame(timestamp)) {
      this.drawFrameWithAnnotations(annotations);
      this.nextFrameDueAtMs = nextFrameDueAt(timestamp, this.nextFrameDueAtMs, this.frameIntervalMs);
    }

    this.queueNextFrame(annotations);
  }

  private shouldDrawFrame(timestamp: number): boolean {
    return this.nextFrameDueAtMs === null || timestamp >= this.nextFrameDueAtMs;
  }

  private recordingDurationSeconds(stoppedAtMs: number): number {
    if (this.recordingStartedAtMs === null) {
      return 0;
    }

    return Math.max(0, (stoppedAtMs - this.recordingStartedAtMs) / millisecondsPerSecond);
  }

  private async stopRecorderIfActive(): Promise<void> {
    if (this.recorder.state === "inactive") {
      await this.videoWriter.finalize();
      return;
    }

    const stopped = new Promise<void>((resolve) => {
      this.recorder.addEventListener(
        "stop",
        () => {
          resolve();
        },
        { once: true }
      );
    });
    this.recorder.stop();
    await stopped;
    await this.videoWriter.finalize();
  }

  private async stopAudioRecorders(): Promise<void> {
    await Promise.all(this.audioRecorders.map(async (audioRecorder) => {
      await stopRecorder(audioRecorder.recorder, audioRecorder.writer);
    }));
  }

  async discard(): Promise<void> {
    await this.stopRecorderIfActive();
    await this.stopAudioRecorders();
    this.stopTracks();

    if (this.isFinalized) {
      return;
    }

    await discardWriters(this.videoWriter, this.audioRecorders);
    this.isFinalized = true;
  }

  start(): void {
    this.recordingStartedAtMs = performance.now();
    this.drawFrame();
    for (const audioRecorder of this.audioRecorders) {
      audioRecorder.writer.start(audioRecorder.recorder);
    }

    this.videoWriter.start(this.recorder);
  }

  async stop(): Promise<RecordingResult> {
    if (this.recorder.state === "inactive") {
      return {
        audioTracks: [],
        durationSeconds: 0,
        mimeType: this.mimeType,
        recordingId: this.videoWriter.recordingId
      };
    }

    const durationSeconds = this.recordingDurationSeconds(performance.now());
    await this.stopRecorderIfActive();
    await this.stopAudioRecorders();
    this.isFinalized = true;
    return {
      audioTracks: this.audioRecorders.map((audioRecorder) => ({
        kind: audioRecorder.kind,
        mimeType: audioRecorder.mimeType,
        recordingId: audioRecorder.writer.recordingId
      })),
      durationSeconds,
      mimeType: this.mimeType,
      recordingId: this.videoWriter.recordingId
    };
  }

  stopTracks(): void {
    if (this.animationHandle !== null) {
      cancelAnimationFrame(this.animationHandle);
      this.animationHandle = null;
    }

    this.nextFrameDueAtMs = null;
    stopTracks(this.sourceStream);
    stopTracks(this.microphoneStream);
    stopTracks(this.outputStream);
  }
}

async function audioRecorderFromTrack(kind: AudioSourceKind, track: MediaStreamTrack): Promise<AudioRecorder> {
  const stream = new MediaStream([track]);
  const mimeType = supportedAudioMimeType();
  const writer = await RecordingFileWriter.create();
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

async function discardWriters(videoWriter: RecordingFileWriter, audioRecorders: AudioRecorder[]): Promise<void> {
  await Promise.all([
    videoWriter.discard(),
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

function supportedVideoMimeType(): string {
  const supported = supportedMimeTypes.find((type) => MediaRecorder.isTypeSupported(type));
  if (!supported) {
    throw new Error("This system does not support WebM screen recording through MediaRecorder.");
  }

  return supported;
}

function supportedAudioMimeType(): string {
  const supported = supportedAudioMimeTypes.find((type) => MediaRecorder.isTypeSupported(type));
  if (!supported) {
    throw new Error("This system does not support WebM audio recording through MediaRecorder.");
  }

  return supported;
}

function nextFrameDueAt(timestamp: number, currentFrameDueAtMs: number | null, frameIntervalMs: number): number {
  if (currentFrameDueAtMs === null) {
    return timestamp + frameIntervalMs;
  }

  const nextFrameAt = currentFrameDueAtMs + frameIntervalMs;
  if (timestamp > nextFrameAt) {
    return timestamp + frameIntervalMs;
  }

  return nextFrameAt;
}

function videoBitrate(selectedQuality: VideoQuality, selectedFps: VideoFps): number {
  const base = selectedQuality === "720p" ? standardQualityBitrate : highQualityBitrate;
  return selectedFps === videoFpsOptions.high ? Math.round(base * highFpsBitrateMultiplier) : base;
}

function videoOutputSize(rect: Rect, selectedQuality: VideoQuality): { height: number; width: number } {
  const targetHeight = selectedQuality === "720p" ? videoQualityHeights.low : videoQualityHeights.high;
  const aspect = rect.width / rect.height;
  return {
    height: targetHeight,
    width: Math.max(minimumVideoDimensionPx, Math.round(targetHeight * aspect))
  };
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
