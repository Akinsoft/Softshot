import type { AudioSourceKind, VideoFps } from "./shared.js";
import { exportedVideoBitrate } from "./video-bitrate.js";
import { hasWebmCluster } from "./webm.js";

const minimumOutputDimensionPx = 2;
const trimToleranceSeconds = 0.04;
const supportedMimeTypes = ["video/webm;codecs=vp8", "video/webm;codecs=vp9", "video/webm"] as const;
const supportedAudioVideoMimeTypes = [
  "video/webm;codecs=vp8,opus",
  "video/webm;codecs=vp9,opus",
  "video/webm"
] as const;
const supportedMp4MimeTypes = [
  "video/mp4;codecs=avc1.640028",
  "video/mp4;codecs=avc1.42E01E"
] as const;
const supportedAudioVideoMp4MimeTypes = [
  "video/mp4;codecs=avc1.640028,mp4a.40.2",
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2"
] as const;

export interface TrimRange {
  end: number;
  start: number;
}

export interface ExportAudioTrack {
  kind: AudioSourceKind;
  mimeType: string;
  sourceUrl: string;
}

interface LoadedVideo {
  video: HTMLVideoElement;
}

interface AudioMix {
  context: AudioContext;
  sources: MediaElementAudioSourceNode[];
  stream: MediaStream;
}

export async function exportTrimmedVideo(
  sourceUrl: string,
  mimeType: string,
  fps: VideoFps,
  trimRange: TrimRange,
  audioTracks: ExportAudioTrack[]
): Promise<Uint8Array> {
  const loadedVideo = await createLoadedVideo(sourceUrl);
  const audioElements = await createLoadedAudioElements(audioTracks);
  return await recordVideoSegment(loadedVideo.video, audioElements, mimeType, fps, trimRange);
}

async function createLoadedVideo(sourceUrl: string): Promise<LoadedVideo> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = sourceUrl;
  await waitForVideoMetadata(video);
  return { video };
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

  const context = new AudioContext();
  const destination = context.createMediaStreamDestination();
  const sources = audioElements.map((audioElement) => {
    const source = context.createMediaElementSource(audioElement);
    source.connect(destination);
    return source;
  });
  return {
    context,
    sources,
    stream: destination.stream
  };
}

async function playSegment(
  video: HTMLVideoElement,
  audioElements: HTMLAudioElement[],
  context: CanvasRenderingContext2D,
  trimRange: TrimRange,
  width: number,
  height: number
): Promise<void> {
  await Promise.all([
    seekMedia(video, trimRange.start),
    ...audioElements.map(async (audioElement) => {
      await seekMedia(audioElement, trimRange.start);
    })
  ]);
  await Promise.all([
    video.play(),
    ...audioElements.map(async (audioElement) => audioElement.play())
  ]);

  await new Promise<void>((resolve) => {
    const drawFrame = (): void => {
      context.drawImage(video, 0, 0, width, height);

      if (video.currentTime >= trimRange.end || video.ended) {
        video.pause();
        pauseMediaElements(audioElements);
        resolve();
        return;
      }

      requestAnimationFrame(drawFrame);
    };

    drawFrame();
  });
}

async function recordVideoSegment(
  video: HTMLVideoElement,
  audioElements: HTMLAudioElement[],
  preferredMimeType: string,
  fps: VideoFps,
  trimRange: TrimRange
): Promise<Uint8Array> {
  const width = Math.max(minimumOutputDimensionPx, video.videoWidth);
  const height = Math.max(minimumOutputDimensionPx, video.videoHeight);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Could not create the video export canvas.");
  }

  const stream = canvas.captureStream(fps);
  const audioMix = createAudioMix(audioElements);
  const mixedAudioTracks = audioMix?.stream.getAudioTracks() ?? [];
  for (const audioTrack of mixedAudioTracks) {
    stream.addTrack(audioTrack);
  }

  const recorder = new MediaRecorder(stream, {
    mimeType: supportedVideoMimeType(preferredMimeType, audioElements.length > 0),
    videoBitsPerSecond: exportedVideoBitrate(height, fps)
  });
  const chunks: Blob[] = [];
  const stopped = new Promise<Blob>((resolve) => {
    recorder.addEventListener("stop", () => {
      resolve(new Blob(chunks, { type: recorder.mimeType }));
    }, { once: true });
  });

  recorder.addEventListener("dataavailable", (event): void => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  });

  let outputBlob: Blob;
  try {
    recorder.start();
    await playSegment(video, audioElements, context, trimRange, width, height);
    recorder.stop();
    outputBlob = await stopped;
  } finally {
    if (recorder.state !== "inactive") {
      recorder.stop();
    }

    stopTracks(stream);
    await closeAudioMix(audioMix);
    pauseMediaElements(audioElements);
  }

  if (outputBlob.size === 0) {
    throw new Error("The trimmed recording did not contain any video data.");
  }

  const outputBytes = new Uint8Array(await outputBlob.arrayBuffer());
  if (!hasWebmCluster(outputBytes)) {
    throw new Error("The trimmed recording did not contain any video frames.");
  }

  return outputBytes;
}

async function closeAudioMix(audioMix: AudioMix | null): Promise<void> {
  if (!audioMix) {
    return;
  }

  for (const source of audioMix.sources) {
    source.disconnect();
  }

  await audioMix.context.close();
}

function pauseMediaElements(elements: HTMLMediaElement[]): void {
  for (const element of elements) {
    element.pause();
  }
}

async function seekMedia(media: HTMLMediaElement, timeSeconds: number): Promise<void> {
  if (Math.abs(media.currentTime - timeSeconds) <= trimToleranceSeconds) {
    return;
  }

  await new Promise<void>((resolve) => {
    media.addEventListener("seeked", () => {
      resolve();
    }, { once: true });
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
    mimeTypes = hasAudio ? supportedAudioVideoMimeTypes : supportedMimeTypes;
  }
  const supported = mimeTypes.find((mimeType) => MediaRecorder.isTypeSupported(mimeType));
  if (!supported) {
    throw new Error(`This system does not support ${isMp4 ? "MP4" : "WebM"} video export.`);
  }

  return supported;
}

async function waitForVideoMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.videoWidth > 0 && video.videoHeight > 0) {
    return;
  }

  await waitForMediaMetadata(video);
}

async function waitForMediaMetadata(media: HTMLMediaElement): Promise<void> {
  if (media.readyState >= HTMLMediaElement.HAVE_METADATA) {
    return;
  }

  await new Promise<void>((resolve) => {
    media.addEventListener("loadedmetadata", () => {
      resolve();
    }, { once: true });
  });
}
