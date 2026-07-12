import { audioMixGain, recordingAudioBitrate, recordingAudioSampleRate } from "./audio-quality.js";
import { mediaElementError, mediaElementOperationTimeoutMs, playMedia, waitForMediaMetadata } from "./media-element.js";
import { RecordingFileWriter, stopMediaRecorder } from "./recording-file-writer.js";
import type { VideoFileExtension, VideoFps } from "./shared.js";
import { videoBitrate } from "./video-bitrate.js";
import {
  supportedAudioVideoMp4MimeTypes,
  supportedAudioVideoWebmMimeTypes,
  supportedMp4MimeTypes,
  supportedWebmMimeTypes
} from "./video-recorder-profile.js";

const minimumOutputDimensionPx = 2;
const seekToleranceSeconds = 0.001;
const minimumPlaybackTimeoutMs = 30_000;
const playbackTimeoutMultiplier = 2;
const millisecondsPerSecond = 1000;

export interface TrimRange {
  end: number;
  start: number;
}

export interface ExportAudioTrack {
  sourceUrl: string;
}

export interface ExportedVideo {
  mimeType: string;
  recordingId: string;
}

interface AudioMix {
  context: AudioContext;
  sources: MediaElementAudioSourceNode[];
  stream: MediaStream;
}

export async function exportTrimmedVideo(
  sourceUrl: string,
  preferredMimeType: string,
  fps: VideoFps,
  trimRange: TrimRange,
  audioTracks: ExportAudioTrack[]
): Promise<ExportedVideo> {
  const video = await createLoadedVideo(sourceUrl);
  const audioElements = await createLoadedAudioElements(audioTracks);
  return await recordVideoSegment(video, audioElements, preferredMimeType, fps, trimRange);
}

async function createLoadedVideo(sourceUrl: string): Promise<HTMLVideoElement> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = sourceUrl;
  await waitForMediaMetadata(video);
  if (video.videoWidth < 1 || video.videoHeight < 1) {
    throw new Error("The source recording does not contain a usable video track.");
  }

  return video;
}

async function createLoadedAudioElements(audioTracks: ExportAudioTrack[]): Promise<HTMLAudioElement[]> {
  return await Promise.all(audioTracks.map(async (audioTrack): Promise<HTMLAudioElement> => {
    const audio = new Audio();
    audio.preload = "auto";
    audio.src = audioTrack.sourceUrl;
    await waitForMediaMetadata(audio);
    return audio;
  }));
}

function createAudioMix(audioElements: HTMLAudioElement[]): AudioMix | null {
  if (audioElements.length === 0) {
    return null;
  }

  const context = new AudioContext({ sampleRate: recordingAudioSampleRate });
  const destination = context.createMediaStreamDestination();
  const gain = context.createGain();
  gain.gain.value = audioMixGain(audioElements.length);
  gain.connect(destination);
  const sources = audioElements.map((audioElement) => {
    const source = context.createMediaElementSource(audioElement);
    source.connect(gain);
    return source;
  });
  return {
    context,
    sources,
    stream: destination.stream
  };
}

async function prepareSegment(
  video: HTMLVideoElement,
  audioElements: HTMLAudioElement[],
  context: CanvasRenderingContext2D,
  trimRange: TrimRange,
  width: number,
  height: number
): Promise<void> {
  await Promise.all([
    seekMedia(video, trimRange.start),
    ...audioElements.map(async (audioElement) => await seekMedia(audioElement, trimRange.start))
  ]);
  context.drawImage(video, 0, 0, width, height);
}

async function playSegment(
  video: HTMLVideoElement,
  audioElements: HTMLAudioElement[],
  context: CanvasRenderingContext2D,
  writer: RecordingFileWriter,
  trimRange: TrimRange,
  width: number,
  height: number
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let frameHandle: number | null = null;
    let isSettled = false;
    let removeWriterErrorHandler: (() => void) | null = null;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const segmentDurationSeconds = Math.max(0, trimRange.end - trimRange.start);
    const playbackTimeoutMs = Math.max(
      minimumPlaybackTimeoutMs,
      Math.ceil(segmentDurationSeconds * playbackTimeoutMultiplier * millisecondsPerSecond)
    );
    function cleanup(): void {
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
      }

      if (frameHandle !== null) {
        video.cancelVideoFrameCallback(frameHandle);
      }

      removeWriterErrorHandler?.();
      removeWriterErrorHandler = null;

      video.removeEventListener("ended", finish);
      video.removeEventListener("error", onError);
      video.removeEventListener("timeupdate", finishAtTrimEnd);
      for (const audioElement of audioElements) {
        audioElement.removeEventListener("error", onAudioError);
      }
    }
    function didSettle(): boolean {
      if (isSettled) {
        return false;
      }

      isSettled = true;
      cleanup();
      video.pause();
      pauseMediaElements(audioElements);
      return true;
    }
    function finish(): void {
      if (didSettle()) {
        resolve();
      }
    }
    function fail(error: unknown): void {
      if (didSettle()) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    function finishAtTrimEnd(): void {
      if (video.currentTime >= trimRange.end || video.ended) {
        finish();
      }
    }
    function onError(): void {
      fail(mediaElementError(video, "playing the source recording"));
    }
    function onAudioError(event: Event): void {
      if (event.currentTarget instanceof HTMLMediaElement) {
        fail(mediaElementError(event.currentTarget, "playing a recording audio track"));
      }
    }
    function drawFrame(): void {
      frameHandle = null;
      context.drawImage(video, 0, 0, width, height);
      if (video.currentTime >= trimRange.end || video.ended) {
        finish();
        return;
      }

      frameHandle = video.requestVideoFrameCallback(drawFrame);
    }

    video.addEventListener("ended", finish, { once: true });
    video.addEventListener("error", onError, { once: true });
    video.addEventListener("timeupdate", finishAtTrimEnd);
    for (const audioElement of audioElements) {
      audioElement.addEventListener("error", onAudioError, { once: true });
    }
    frameHandle = video.requestVideoFrameCallback(drawFrame);
    timeoutHandle = setTimeout((): void => {
      fail(new Error("Timed out while exporting the selected video segment."));
    }, playbackTimeoutMs);
    removeWriterErrorHandler = writer.onError((error): void => {
      fail(new Error("The video encoder failed during export.", { cause: error }));
    });
    void Promise.all([
      playMedia(video),
      ...audioElements.map(async (audioElement) => await playMedia(audioElement))
    ]).catch(fail);
  });
}

async function recordVideoSegment(
  video: HTMLVideoElement,
  audioElements: HTMLAudioElement[],
  preferredMimeType: string,
  fps: VideoFps,
  trimRange: TrimRange
): Promise<ExportedVideo> {
  const width = Math.max(minimumOutputDimensionPx, video.videoWidth);
  const height = Math.max(minimumOutputDimensionPx, video.videoHeight);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d", { alpha: false, desynchronized: true });
  if (!context) {
    throw new Error("Could not create the video export canvas.");
  }

  const stream = canvas.captureStream(fps);
  for (const videoTrack of stream.getVideoTracks()) {
    videoTrack.contentHint = "detail";
  }

  const audioMix = createAudioMix(audioElements);
  const mixedAudioTracks = audioMix?.stream.getAudioTracks() ?? [];
  for (const audioTrack of mixedAudioTracks) {
    stream.addTrack(audioTrack);
  }

  const mimeType = supportedVideoMimeType(preferredMimeType, audioElements.length > 0);
  let recorder: MediaRecorder | null = null;
  let writer: RecordingFileWriter | null = null;
  const errors: unknown[] = [];
  try {
    await prepareSegment(video, audioElements, context, trimRange, width, height);
    if (audioMix?.context.state === "suspended") {
      await audioMix.context.resume();
    }

    writer = await RecordingFileWriter.create(videoFileExtension(mimeType));
    recorder = new MediaRecorder(stream, {
      ...((audioElements.length > 0) && { audioBitsPerSecond: recordingAudioBitrate }),
      mimeType,
      videoBitsPerSecond: videoBitrate(width, height, fps)
    });
    writer.connect(recorder);
    writer.start(recorder);
    await playSegment(video, audioElements, context, writer, trimRange, width, height);
    await stopMediaRecorder(recorder, writer);
  } catch (error) {
    errors.push(error);
    if (recorder && writer && recorder.state !== "inactive") {
      try {
        await stopMediaRecorder(recorder, writer);
      } catch (stopError) {
        errors.push(stopError);
      }
    }
  }

  stopTracks(stream);
  pauseMediaElements(audioElements);
  try {
    await closeAudioMix(audioMix);
  } catch (error) {
    errors.push(error);
  }

  if (errors.length > 0 || !writer || !recorder) {
    if (writer) {
      try {
        await writer.discard();
      } catch (discardError) {
        errors.push(discardError);
      }
    }

    throwExportErrors(errors);
  }

  return {
    mimeType: recorder.mimeType.length > 0 ? recorder.mimeType : mimeType,
    recordingId: writer.recordingId
  };
}

async function closeAudioMix(audioMix: AudioMix | null): Promise<void> {
  if (!audioMix) {
    return;
  }

  for (const source of audioMix.sources) {
    source.disconnect();
  }

  if (audioMix.context.state !== "closed") {
    await audioMix.context.close();
  }
}

function pauseMediaElements(elements: HTMLMediaElement[]): void {
  for (const element of elements) {
    element.pause();
  }
}

async function seekMedia(media: HTMLMediaElement, timeSeconds: number): Promise<void> {
  if (Math.abs(media.currentTime - timeSeconds) <= seekToleranceSeconds) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    function cleanup(): void {
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
      }

      media.removeEventListener("seeked", onSeeked);
      media.removeEventListener("error", onError);
    }
    function onSeeked(): void {
      cleanup();
      resolve();
    }
    function onError(): void {
      cleanup();
      reject(mediaElementError(media, "seeking the recording"));
    }

    media.addEventListener("seeked", onSeeked, { once: true });
    media.addEventListener("error", onError, { once: true });
    timeoutHandle = setTimeout((): void => {
      cleanup();
      reject(new Error("Timed out seeking the recording."));
    }, mediaElementOperationTimeoutMs);
    media.currentTime = timeSeconds;
  });
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

function supportedVideoMimeType(preferredMimeType: string, hasAudio: boolean): string {
  const isMp4 = preferredMimeType.startsWith("video/mp4");
  let mimeTypes: readonly string[];
  if (isMp4) {
    mimeTypes = hasAudio ? supportedAudioVideoMp4MimeTypes : supportedMp4MimeTypes;
  } else {
    mimeTypes = hasAudio ? supportedAudioVideoWebmMimeTypes : supportedWebmMimeTypes;
  }

  const supported = mimeTypes.find((mimeType) => MediaRecorder.isTypeSupported(mimeType));
  if (!supported) {
    throw new Error(`This system does not support ${isMp4 ? "MP4" : "WebM"} video export.`);
  }

  return supported;
}

function videoFileExtension(mimeType: string): VideoFileExtension {
  return mimeType.startsWith("video/mp4") ? "mp4" : "webm";
}

function throwExportErrors(errors: unknown[]): never {
  const actualErrors = errors.length > 0 ? errors : [new Error("The video export did not create an output file.")];
  const details = actualErrors.map((error) => error instanceof Error ? error.message : String(error)).join("\n");
  throw new AggregateError(actualErrors, `Could not export the recording.\n${details}`);
}
