import {
  ALL_FORMATS,
  AppendOnlyStreamTarget,
  AudioBufferSource,
  type AudioSample,
  AudioSampleSink,
  canEncodeAudio,
  canEncodeVideo,
  CustomSource,
  Input,
  type InputAudioTrack,
  type InputVideoTrack,
  Mp4OutputFormat,
  Output,
  type VideoSample,
  VideoSampleSink,
  VideoSampleSource,
  WebMOutputFormat
} from "mediabunny";

import {
  audioMixGain,
  recordingAudioBitrate,
  recordingAudioChannelCount,
  recordingAudioSampleRate
} from "./audio-quality.js";
import { RecordingFileWriter } from "./recording-file-writer.js";
import type { AudioSourceKind, VideoFileExtension, VideoFps } from "./shared.js";
import { getSoftshotApi } from "./softshot-api.js";
import { videoBitrate } from "./video-bitrate.js";

const audioRenderChunkSeconds = 5;
const keyframeIntervalSeconds = 2;
const minimumSampleDurationSeconds = 1e-6;
const mp4MimeType = "video/mp4";
const preferredHardwareAcceleration = "prefer-hardware";
const webmMimeType = "video/webm";

export interface TrimRange {
  end: number;
  start: number;
}

export interface ExportAudioTrack {
  kind: AudioSourceKind;
}

export interface ExportedVideo {
  mimeType: string;
  recordingId: string;
}

interface EditorByteSource {
  getSize(): Promise<number>;
  read(start: number, end: number): Promise<Uint8Array>;
}

interface LoadedAudioInput {
  input: Input;
  track: InputAudioTrack;
}

interface LoadedVideoInput {
  input: Input;
  track: InputVideoTrack;
}

export async function exportEditedVideo(
  preferredMimeType: string,
  fps: VideoFps,
  trimRanges: readonly TrimRange[],
  audioTracks: readonly ExportAudioTrack[]
): Promise<ExportedVideo> {
  validateTrimRanges(trimRanges);
  const videoInput = createVideoInput();
  const audioInputs = audioTracks.map((audioTrack) => createAudioInput(audioTrack.kind));
  let writer: RecordingFileWriter | null = null;
  let output: Output | null = null;
  try {
    const loadedVideo = await loadVideoInput(videoInput);
    const loadedAudioInputs = await Promise.all(audioInputs.map(async (input) => await loadAudioInput(input)));
    const isMp4 = preferredMimeType.startsWith(mp4MimeType);
    const fileExtension: VideoFileExtension = isMp4 ? "mp4" : "webm";
    const mimeType = isMp4 ? mp4MimeType : webmMimeType;
    const videoCodec = isMp4 ? "avc" : "vp9";
    const audioCodec = isMp4 ? "aac" : "opus";
    const width = await loadedVideo.track.getCodedWidth();
    const height = await loadedVideo.track.getCodedHeight();
    const bitrate = videoBitrate(width, height, fps);
    await assertEncodingSupport(videoCodec, audioCodec, bitrate, width, height, loadedAudioInputs.length > 0);

    writer = await RecordingFileWriter.create(fileExtension);
    output = new Output({
      format: isMp4
        ? new Mp4OutputFormat({ fastStart: "fragmented", minimumFragmentDuration: 1 })
        : new WebMOutputFormat(),
      target: new AppendOnlyStreamTarget(writer.writableStream())
    });
    const videoSource = new VideoSampleSource({
      bitrate,
      codec: videoCodec,
      contentHint: "detail",
      hardwareAcceleration: preferredHardwareAcceleration,
      keyFrameInterval: keyframeIntervalSeconds
    });
    const audioSource = loadedAudioInputs.length > 0
      ? new AudioBufferSource({ bitrate: recordingAudioBitrate, codec: audioCodec })
      : null;
    output.addVideoTrack(videoSource, {
      frameRate: fps,
      rotation: await loadedVideo.track.getRotation()
    });
    if (audioSource) {
      output.addAudioTrack(audioSource);
    }

    await output.start();
    await Promise.all([
      encodeVideoRanges(loadedVideo.track, videoSource, trimRanges),
      ...(audioSource
        ? [encodeAudioRanges(loadedAudioInputs, audioSource, trimRanges)]
        : [])
    ]);
    await output.finalize();
    await writer.finalize();
    return { mimeType, recordingId: writer.recordingId };
  } catch (error) {
    return await discardFailedExport(output, writer, error);
  } finally {
    videoInput.dispose();
    for (const audioInput of audioInputs) {
      audioInput.dispose();
    }
  }
}

async function discardFailedExport(
  output: Output | null,
  writer: RecordingFileWriter | null,
  exportError: unknown
): Promise<never> {
  const errors = [exportError];
  if (output && output.state !== "canceled" && output.state !== "finalized") {
    try {
      await output.cancel();
    } catch (error) {
      errors.push(error);
    }
  }

  if (writer) {
    try {
      await writer.discard();
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length > 1) {
    throw new AggregateError(errors, "Could not export or clean up the edited recording.");
  }

  throw exportError;
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

async function loadVideoInput(input: Input): Promise<LoadedVideoInput> {
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

  return { input, track };
}

async function loadAudioInput(input: Input): Promise<LoadedAudioInput> {
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

  return { input, track };
}

async function assertEncodingSupport(
  videoCodec: "avc" | "vp9",
  audioCodec: "aac" | "opus",
  bitrate: number,
  width: number,
  height: number,
  hasAudio: boolean
): Promise<void> {
  const supportsVideo = await canEncodeVideo(videoCodec, {
    bitrate,
    hardwareAcceleration: preferredHardwareAcceleration,
    height,
    width
  });
  if (!supportsVideo) {
    throw new Error(`This system cannot encode edited ${videoCodec.toUpperCase()} video.`);
  }

  if (hasAudio && !await canEncodeAudio(audioCodec, {
    bitrate: recordingAudioBitrate,
    numberOfChannels: recordingAudioChannelCount,
    sampleRate: recordingAudioSampleRate
  })) {
    throw new Error(`This system cannot encode edited ${audioCodec.toUpperCase()} audio.`);
  }
}

async function encodeVideoRanges(
  inputTrack: InputVideoTrack,
  outputSource: VideoSampleSource,
  trimRanges: readonly TrimRange[]
): Promise<void> {
  let outputOffset = 0;
  for (const trimRange of trimRanges) {
    const sink = new VideoSampleSink(inputTrack, { hardwareAcceleration: preferredHardwareAcceleration });
    let isFirstSample = true;
    for await (const sample of sink.samples(trimRange.start, trimRange.end)) {
      if (await encodeVideoSample(sample, outputSource, trimRange, outputOffset, isFirstSample)) {
        isFirstSample = false;
      }
    }

    if (isFirstSample) {
      throw new Error("A retained video section did not contain any frames.");
    }

    outputOffset += trimRange.end - trimRange.start;
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
  trimRanges: readonly TrimRange[]
): Promise<void> {
  for (const trimRange of trimRanges) {
    let chunkStart = trimRange.start;
    while (chunkStart < trimRange.end) {
      const chunkEnd = Math.min(chunkStart + audioRenderChunkSeconds, trimRange.end);
      const buffer = await renderAudioChunk(inputs, chunkStart, chunkEnd);
      await outputSource.add(buffer);
      chunkStart = chunkEnd;
    }
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
  const gain = context.createGain();
  gain.gain.value = audioMixGain(inputs.length);
  gain.connect(context.destination);
  for (const input of inputs) {
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
