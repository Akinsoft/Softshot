import {
  ALL_FORMATS,
  AppendOnlyStreamTarget,
  AudioBufferSource,
  type AudioSample,
  AudioSampleSink,
  BufferTarget,
  canEncodeAudio,
  canEncodeVideo,
  CustomSource,
  Input,
  type InputAudioTrack,
  type InputVideoTrack,
  Mp4OutputFormat,
  Output,
  type Rotation,
  VideoSample,
  VideoSampleSink,
  VideoSampleSource,
  type VideoTransformOptions,
  WavOutputFormat,
  WebMOutputFormat
} from "mediabunny";

import { audioMixGain, recordingAudioChannelCount, recordingAudioSampleRate } from "./audio-quality.js";
import type { EncodedVideoPlan, ExportAudioPlan, ExportPlan, ExportVideoCodec, GifPlan } from "./editor-export-settings.js";
import { exportVideoCodecLabel } from "./editor-export-settings.js";
import { encodeGifRanges } from "./editor-gif-export.js";
import { VideoUpscaler } from "./editor-upscaler.js";
import { RecordingFileWriter } from "./recording-file-writer.js";
import type { AudioSourceKind, OutputFileExtension } from "./shared.js";
import { getSoftshotApi } from "./softshot-api.js";

const audioRenderChunkSeconds = 5;
const bitsPerKilobit = 1000;
const bufferedOutputChunkBytes = 4_194_304;
const halfTurnDegrees = 180;
const keyframeIntervalSeconds = 2;
const minimumSampleDurationSeconds = 1e-6;
const preferredHardwareAcceleration = "prefer-hardware";
const hardwareThenAnyAcceleration = [preferredHardwareAcceleration, "no-preference"] as const;
const videoEncoderAccelerations: Record<ExportVideoCodec, readonly HardwareAcceleration[]> = {
  av1: hardwareThenAnyAcceleration,
  avc: hardwareThenAnyAcceleration,
  hevc: hardwareThenAnyAcceleration,
  vp9: ["no-preference"]
};

export interface TrimRange {
  end: number;
  start: number;
}

export interface ExportAudioTrack {
  kind: AudioSourceKind;
  volume: number;
}

interface ExportedFile {
  fileExtension: OutputFileExtension;
  recordingId: string;
}

export interface ExportOptions {
  onProgress?: (progress: number) => void;
  signal?: AbortSignal;
}

interface VideoEncoderSize {
  height: number;
  width: number;
}

interface VideoEncoderCheck extends VideoEncoderSize {
  bitrate: number;
  framerate: number;
}

interface EditorByteSource {
  getSize(): Promise<number>;
  read(start: number, end: number): Promise<Uint8Array>;
}

interface LoadedAudioInput {
  input: Input;
  track: InputAudioTrack;
  volume: number;
}

interface LoadedVideoInput {
  input: Input;
  track: InputVideoTrack;
}

interface VideoFrameLayout {
  codedSize: VideoEncoderSize;
  outputRotation: Rotation;
  sourceRotation: Rotation;
}

interface VideoExportJob {
  audioInputs: readonly LoadedAudioInput[];
  audioPlan: ExportAudioPlan | null;
  format: "mp4" | "webm";
  isVideoVisible: boolean;
  options: ExportOptions;
  totalSeconds: number;
  trimRanges: readonly TrimRange[];
  videoPlan: EncodedVideoPlan;
  videoTrack: InputVideoTrack;
}

type ExportTrackKind = "audio" | "video";

export class ExportProgress {
  private readonly processedSecondsByTrack = new Map<ExportTrackKind, number>();

  constructor(
    private readonly totalSeconds: number,
    trackKinds: readonly ExportTrackKind[],
    private readonly onProgress: ((progress: number) => void) | null
  ) {
    for (const trackKind of trackKinds) {
      this.processedSecondsByTrack.set(trackKind, 0);
    }
  }

  update(trackKind: ExportTrackKind, processedSeconds: number): void {
    this.processedSecondsByTrack.set(trackKind, processedSeconds);
    const slowestSeconds = Math.min(...this.processedSecondsByTrack.values());
    this.onProgress?.(Math.min(1, Math.max(0, slowestSeconds / this.totalSeconds)));
  }
}

export async function exportEdit(
  plan: ExportPlan,
  trimRanges: readonly TrimRange[],
  audioTracks: readonly ExportAudioTrack[],
  isVideoVisible: boolean,
  options: ExportOptions = {}
): Promise<ExportedFile> {
  validateTrimRanges(trimRanges);
  const totalSeconds = trimRanges.reduce((total, trimRange) => total + trimRange.end - trimRange.start, 0);
  if (plan.kind === "gif") {
    return await exportGif(plan.gif, trimRanges, totalSeconds, options);
  }

  if (plan.kind === "audio") {
    return await exportAudioOnly(plan.format, plan.audio, trimRanges, audioTracks, totalSeconds, options);
  }

  const videoInput = await openVideoInput();
  try {
    const audioInputs = plan.audio ? await openAudioInputs(audioTracks) : [];
    try {
      return await exportVideo({
        audioInputs,
        audioPlan: plan.audio,
        format: plan.format,
        isVideoVisible,
        options,
        totalSeconds,
        trimRanges,
        videoPlan: plan.video,
        videoTrack: videoInput.track
      });
    } finally {
      disposeAudioInputs(audioInputs);
    }
  } finally {
    videoInput.input.dispose();
  }
}

export async function supportedVideoEncoderAcceleration(
  codec: ExportVideoCodec,
  encoderCheck: VideoEncoderCheck
): Promise<HardwareAcceleration | null> {
  const accelerations = videoEncoderAccelerations[codec];
  for (const hardwareAcceleration of accelerations) {
    const options = { ...encoderCheck, hardwareAcceleration };
    if (await canEncodeVideo(codec, options)) {
      return hardwareAcceleration;
    }
  }

  return null;
}

async function exportVideo(job: VideoExportJob): Promise<ExportedFile> {
  const { audioInputs, audioPlan, videoPlan, videoTrack } = job;
  const codedSize = { height: await videoTrack.getCodedHeight(), width: await videoTrack.getCodedWidth() };
  const sourceRotation = await videoTrack.getRotation();
  const shouldKeepRotationMetadata = videoPlan.outputSize === null && (sourceRotation === 0 || job.format === "mp4");
  const frameLayout: VideoFrameLayout = {
    codedSize,
    outputRotation: shouldKeepRotationMetadata ? sourceRotation : 0,
    sourceRotation
  };
  const encoderSize = videoPlan.outputSize ?? (shouldKeepRotationMetadata ? codedSize : rotatedSize(codedSize, sourceRotation));
  const hardwareAcceleration = await supportedVideoEncoderAcceleration(videoPlan.codec, {
    ...encoderSize,
    bitrate: videoPlan.bitrate,
    framerate: videoPlan.fps
  });
  if (!hardwareAcceleration) {
    const sizeLabel = `${String(encoderSize.width)}×${String(encoderSize.height)}`;
    throw new Error(`This system cannot encode ${exportVideoCodecLabel(videoPlan.codec)} video at ${sizeLabel}.`);
  }

  const hasAudio = audioPlan !== null && audioInputs.length > 0;
  if (hasAudio) {
    await assertAudioEncodingSupport(audioPlan);
  }

  const upscaler = videoPlan.scaling === "up" && videoPlan.outputSize
    ? new VideoUpscaler(videoPlan.outputSize.width, videoPlan.outputSize.height)
    : null;
  const transform = videoTransform(videoPlan, upscaler, !shouldKeepRotationMetadata);
  try {
    return await encodeVideoExport(job, transform, hardwareAcceleration, frameLayout);
  } finally {
    upscaler?.dispose();
  }
}

async function encodeVideoExport(
  job: VideoExportJob,
  transform: VideoTransformOptions | null,
  hardwareAcceleration: HardwareAcceleration,
  frameLayout: VideoFrameLayout
): Promise<ExportedFile> {
  const { audioInputs, audioPlan, format, options, videoPlan, videoTrack } = job;
  const hasAudio = audioPlan !== null && audioInputs.length > 0;
  return await writeExportFile(format, async (writer) => {
    const output = new Output({
      format: format === "mp4"
        ? new Mp4OutputFormat({ fastStart: "fragmented", minimumFragmentDuration: 1 })
        : new WebMOutputFormat({ appendOnly: true }),
      target: new AppendOnlyStreamTarget(writer.writableStream())
    });
    const videoSource = new VideoSampleSource({
      bitrate: videoPlan.bitrate,
      bitrateMode: videoPlan.bitrateMode,
      codec: videoPlan.codec,
      contentHint: "detail",
      hardwareAcceleration,
      keyFrameInterval: keyframeIntervalSeconds,
      ...(transform && { transform })
    });
    const audioSource = hasAudio ? new AudioBufferSource({ bitrate: audioPlan.bitrate, codec: audioPlan.codec }) : null;
    output.addVideoTrack(videoSource, {
      frameRate: videoPlan.fps,
      rotation: frameLayout.outputRotation
    });
    if (audioSource) {
      output.addAudioTrack(audioSource);
    }

    const progress = new ExportProgress(job.totalSeconds, audioSource ? ["video", "audio"] : ["video"], options.onProgress ?? null);
    await runOutput(output, async () => {
      await Promise.all([
        job.isVideoVisible
          ? encodeVideoRanges(videoTrack, videoSource, job.trimRanges, progress, options.signal)
          : encodeBlankVideoRanges(videoSource, job.trimRanges, videoPlan.fps, frameLayout, progress, options.signal),
        ...(audioSource ? [encodeAudioRanges(audioInputs, audioSource, job.trimRanges, progress, options.signal)] : [])
      ]);
    });
  });
}

async function exportAudioOnly(
  format: "m4a" | "wav",
  audioPlan: ExportAudioPlan,
  trimRanges: readonly TrimRange[],
  audioTracks: readonly ExportAudioTrack[],
  totalSeconds: number,
  options: ExportOptions
): Promise<ExportedFile> {
  if (audioTracks.length === 0) {
    throw new Error("There is no sound to export.");
  }

  const audioInputs = await openAudioInputs(audioTracks);
  try {
    await assertAudioEncodingSupport(audioPlan);
    return await writeExportFile(format, async (writer) => {
      const target = new BufferTarget();
      const output = new Output({
        format: format === "m4a" ? new Mp4OutputFormat({ fastStart: "in-memory" }) : new WavOutputFormat(),
        target
      });
      const audioSource = new AudioBufferSource({ bitrate: audioPlan.bitrate, codec: audioPlan.codec });
      output.addAudioTrack(audioSource);
      const progress = new ExportProgress(totalSeconds, ["audio"], options.onProgress ?? null);
      await runOutput(output, async () => {
        await encodeAudioRanges(audioInputs, audioSource, trimRanges, progress, options.signal);
      });
      await writeBufferedOutput(writer, target);
    });
  } finally {
    disposeAudioInputs(audioInputs);
  }
}

async function exportGif(
  gifPlan: GifPlan,
  trimRanges: readonly TrimRange[],
  totalSeconds: number,
  options: ExportOptions
): Promise<ExportedFile> {
  const videoInput = await openVideoInput();
  try {
    return await writeExportFile("gif", async (writer) => {
      const streamWriter = writer.writableStream().getWriter();
      const progress = new ExportProgress(totalSeconds, ["video"], options.onProgress ?? null);
      await encodeGifRanges(videoInput.track, streamWriter, gifPlan, trimRanges, progress, options.signal);
      await streamWriter.close();
    });
  } finally {
    videoInput.input.dispose();
  }
}

function videoTransform(
  videoPlan: EncodedVideoPlan,
  upscaler: VideoUpscaler | null,
  shouldBakeRotation: boolean
): VideoTransformOptions | null {
  const { normalizeFrameRate, outputSize } = videoPlan;
  const frameRate = normalizeFrameRate && { frameRate: videoPlan.fps };
  if (upscaler) {
    return {
      ...frameRate,
      force: true,
      process: (sample): OffscreenCanvas => upscaler.upscale(sample.toCanvasImageSource(), sample.displayWidth, sample.displayHeight)
    };
  }

  if (outputSize) {
    return { ...frameRate, fit: "fill", height: outputSize.height, width: outputSize.width };
  }

  if (!shouldBakeRotation && !normalizeFrameRate) {
    return null;
  }

  return { ...frameRate, force: shouldBakeRotation };
}

function rotatedSize(size: VideoEncoderSize, rotation: Rotation): VideoEncoderSize {
  return rotation % halfTurnDegrees === 0 ? size : { height: size.width, width: size.height };
}

async function writeExportFile(
  fileExtension: OutputFileExtension,
  write: (writer: RecordingFileWriter) => Promise<void>
): Promise<ExportedFile> {
  const writer = await RecordingFileWriter.create(fileExtension);
  try {
    await write(writer);
    await writer.finalize();
    return { fileExtension, recordingId: writer.recordingId };
  } catch (error) {
    try {
      await writer.discard();
    } catch (discardError) {
      throw new AggregateError([error, discardError], "Could not export or clean up the edited file.", { cause: discardError });
    }

    throw error;
  }
}

async function runOutput(output: Output, encode: () => Promise<void>): Promise<void> {
  try {
    await output.start();
    await encode();
    await output.finalize();
  } catch (error) {
    if (output.state !== "canceled" && output.state !== "finalized") {
      try {
        await output.cancel();
      } catch (cancelError) {
        throw new AggregateError([error, cancelError], "Could not export or stop the media encoder.", { cause: cancelError });
      }
    }

    throw error;
  }
}

async function writeBufferedOutput(writer: RecordingFileWriter, target: BufferTarget): Promise<void> {
  const { buffer } = target;
  if (!buffer) {
    throw new Error("The exported audio is empty.");
  }

  const streamWriter = writer.writableStream().getWriter();
  const bytes = new Uint8Array(buffer);
  for (let offset = 0; offset < bytes.byteLength; offset += bufferedOutputChunkBytes) {
    await streamWriter.write(bytes.subarray(offset, offset + bufferedOutputChunkBytes));
  }

  await streamWriter.close();
}

async function openVideoInput(): Promise<LoadedVideoInput> {
  const input = createVideoInput();
  try {
    return { input, track: await loadVideoTrack(input) };
  } catch (error) {
    input.dispose();
    throw error;
  }
}

async function openAudioInputs(audioTracks: readonly ExportAudioTrack[]): Promise<LoadedAudioInput[]> {
  const inputs = audioTracks.map((audioTrack) => ({
    input: createAudioInput(audioTrack.kind),
    volume: audioTrack.volume
  }));
  try {
    return await Promise.all(inputs.map(async ({ input, volume }) => await loadAudioInput(input, volume)));
  } catch (error) {
    for (const { input } of inputs) {
      input.dispose();
    }

    throw error;
  }
}

function disposeAudioInputs(audioInputs: readonly LoadedAudioInput[]): void {
  for (const audioInput of audioInputs) {
    audioInput.input.dispose();
  }
}

function createEditorInput(source: EditorByteSource): Input {
  return new Input({
    formats: ALL_FORMATS,
    source: new CustomSource(source)
  });
}

function createVideoInput(): Input {
  const api = getSoftshotApi();
  return createEditorInput({
    getSize: async (): Promise<number> => await api.getEditorVideoFileSize(),
    read: async (start, end): Promise<Uint8Array> => await api.readEditorVideoFile(start, end)
  });
}

function createAudioInput(kind: AudioSourceKind): Input {
  const api = getSoftshotApi();
  return createEditorInput({
    getSize: async (): Promise<number> => await api.getEditorAudioFileSize(kind),
    read: async (start, end): Promise<Uint8Array> => await api.readEditorAudioFile(kind, start, end)
  });
}

async function loadVideoTrack(input: Input): Promise<InputVideoTrack> {
  if (!await input.canRead()) {
    throw new Error("The source recording could not be read for export.");
  }

  const track = await input.getPrimaryVideoTrack();
  if (!track) {
    throw new Error("The source recording does not contain a video track.");
  }

  if (!await track.canDecode()) {
    throw new Error("This system cannot decode the source recording for export.");
  }

  return track;
}

async function loadAudioInput(input: Input, volume: number): Promise<LoadedAudioInput> {
  if (!await input.canRead()) {
    throw new Error("A recording audio track could not be read for export.");
  }

  const track = await input.getPrimaryAudioTrack();
  if (!track) {
    throw new Error("A recording audio source does not contain an audio track.");
  }

  if (!await track.canDecode()) {
    throw new Error("This system cannot decode a recording audio track for export.");
  }

  return { input, track, volume };
}

async function assertAudioEncodingSupport(audioPlan: ExportAudioPlan): Promise<void> {
  const isSupported = await canEncodeAudio(audioPlan.codec, {
    bitrate: audioPlan.bitrate,
    numberOfChannels: recordingAudioChannelCount,
    sampleRate: recordingAudioSampleRate
  });
  if (isSupported) {
    return;
  }

  const bitrateLabel = `${String(audioPlan.bitrate / bitsPerKilobit)} kbps`;
  throw new Error(`This system cannot encode ${audioPlan.codec.toUpperCase()} audio at ${bitrateLabel}.`);
}

async function encodeVideoRanges(
  inputTrack: InputVideoTrack,
  outputSource: VideoSampleSource,
  trimRanges: readonly TrimRange[],
  progress: ExportProgress,
  signal: AbortSignal | undefined
): Promise<void> {
  let outputOffset = 0;
  for (const trimRange of trimRanges) {
    const sink = new VideoSampleSink(inputTrack, { hardwareAcceleration: preferredHardwareAcceleration });
    let isFirstSample = true;
    for await (const sample of sink.samples(trimRange.start, trimRange.end)) {
      signal?.throwIfAborted();
      const processedSeconds = outputOffset + Math.min(trimRange.end, sample.timestamp + sample.duration) - trimRange.start;
      if (await encodeVideoSample(sample, outputSource, trimRange, outputOffset, isFirstSample)) {
        isFirstSample = false;
        progress.update("video", processedSeconds);
      }
    }

    if (isFirstSample) {
      throw new Error("A retained video section did not contain any frames.");
    }

    outputOffset += trimRange.end - trimRange.start;
  }

  outputSource.close();
}

async function encodeBlankVideoRanges(
  outputSource: VideoSampleSource,
  trimRanges: readonly TrimRange[],
  fps: number,
  frameLayout: VideoFrameLayout,
  progress: ExportProgress,
  signal: AbortSignal | undefined
): Promise<void> {
  const { codedSize } = frameLayout;
  const canvas = new OffscreenCanvas(codedSize.width, codedSize.height);
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("The hidden video frame canvas is unavailable.");
  }

  context.fillStyle = "#000";
  context.fillRect(0, 0, codedSize.width, codedSize.height);
  const frameDuration = 1 / fps;
  let outputOffset = 0;
  for (const trimRange of trimRanges) {
    const rangeDuration = trimRange.end - trimRange.start;
    const frameCount = Math.max(1, Math.round(rangeDuration / frameDuration));
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      signal?.throwIfAborted();
      const frameStart = frameIndex * frameDuration;
      const isLastFrame = frameIndex === frameCount - 1;
      const sample = new VideoSample(canvas, {
        duration: isLastFrame ? Math.max(minimumSampleDurationSeconds, rangeDuration - frameStart) : frameDuration,
        rotation: frameLayout.sourceRotation,
        timestamp: outputOffset + frameStart
      });
      try {
        await outputSource.add(sample, { keyFrame: frameIndex === 0 });
      } finally {
        sample.close();
      }

      progress.update("video", outputOffset + Math.min(rangeDuration, frameStart + frameDuration));
    }

    outputOffset += rangeDuration;
  }

  outputSource.close();
}

async function encodeVideoSample(
  sample: VideoSample,
  outputSource: VideoSampleSource,
  trimRange: TrimRange,
  outputOffset: number,
  isFirstSample: boolean
): Promise<boolean> {
  try {
    const visibleStart = Math.max(sample.timestamp, trimRange.start);
    const visibleEnd = Math.min(sample.timestamp + sample.duration, trimRange.end);
    if (visibleEnd - visibleStart < minimumSampleDurationSeconds) {
      return false;
    }

    sample.setTimestamp(outputOffset + (isFirstSample ? 0 : visibleStart - trimRange.start));
    sample.setDuration(visibleEnd - visibleStart);
    if (isFirstSample) {
      await outputSource.add(sample, { keyFrame: true });
    } else {
      await outputSource.add(sample);
    }

    return true;
  } finally {
    sample.close();
  }
}

async function encodeAudioRanges(
  inputs: readonly LoadedAudioInput[],
  outputSource: AudioBufferSource,
  trimRanges: readonly TrimRange[],
  progress: ExportProgress,
  signal: AbortSignal | undefined
): Promise<void> {
  let outputOffset = 0;
  for (const trimRange of trimRanges) {
    let chunkStart = trimRange.start;
    while (chunkStart < trimRange.end) {
      signal?.throwIfAborted();
      const chunkEnd = Math.min(chunkStart + audioRenderChunkSeconds, trimRange.end);
      const buffer = await renderAudioChunk(inputs, chunkStart, chunkEnd);
      await outputSource.add(buffer);
      chunkStart = chunkEnd;
      progress.update("audio", outputOffset + chunkEnd - trimRange.start);
    }

    outputOffset += trimRange.end - trimRange.start;
  }

  outputSource.close();
}

async function renderAudioChunk(
  inputs: readonly LoadedAudioInput[],
  start: number,
  end: number
): Promise<AudioBuffer> {
  const frameCount = Math.max(1, Math.round((end - start) * recordingAudioSampleRate));
  const context = new OfflineAudioContext(
    recordingAudioChannelCount,
    frameCount,
    recordingAudioSampleRate
  );
  for (const input of inputs) {
    const gain = context.createGain();
    gain.gain.value = audioMixGain(inputs.length) * input.volume;
    gain.connect(context.destination);
    const sink = new AudioSampleSink(input.track);
    for await (const sample of sink.samples(start, end)) {
      scheduleAudioSample(context, gain, sample, start, end);
    }
  }

  return await context.startRendering();
}

function scheduleAudioSample(
  context: OfflineAudioContext,
  gain: GainNode,
  sample: AudioSample,
  start: number,
  end: number
): void {
  let activeSample = sample;
  try {
    const startFrame = activeSample.timestamp < start
      ? Math.min(activeSample.numberOfFrames, Math.round((start - activeSample.timestamp) * activeSample.sampleRate))
      : 0;
    const endFrame = activeSample.timestamp + activeSample.duration > end
      ? Math.max(0, Math.round((end - activeSample.timestamp) * activeSample.sampleRate))
      : activeSample.numberOfFrames;
    if (endFrame <= startFrame) {
      return;
    }

    if (startFrame > 0 || endFrame < activeSample.numberOfFrames) {
      const trimmedSample = activeSample.trim(startFrame, endFrame);
      activeSample.close();
      activeSample = trimmedSample;
    }

    const source = context.createBufferSource();
    source.buffer = activeSample.toAudioBuffer();
    source.connect(gain);
    source.start(Math.max(0, activeSample.timestamp - start));
  } finally {
    activeSample.close();
  }
}

function validateTrimRanges(trimRanges: readonly TrimRange[]): void {
  if (trimRanges.length === 0) {
    throw new RangeError("Edited video exports require at least one retained section.");
  }

  for (const trimRange of trimRanges) {
    if (!Number.isFinite(trimRange.start)
      || !Number.isFinite(trimRange.end)
      || trimRange.start < 0
      || trimRange.end <= trimRange.start) {
      throw new RangeError("Edited video sections must contain valid positive durations.");
    }
  }
}
