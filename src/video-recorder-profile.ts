import type { RecordingEncoder, VideoFileExtension, VideoFps } from "./shared.js";

export interface VideoRecorderProfile {
  encoder: RecordingEncoder;
  fileExtension: VideoFileExtension;
  mimeType: string;
}

const hardwareVideoCodec = "avc1.640028";
const hardwareVideoMimeType = `video/mp4;codecs=${hardwareVideoCodec}`;
const hardwareAudioVideoMimeType = `${hardwareVideoMimeType},mp4a.40.2`;
const audioBitrate = 192_000;
const audioChannelCount = 2;
const audioSampleRate = 48_000;

const compatibilityMimeTypes = ["video/webm;codecs=vp8", "video/webm;codecs=vp9", "video/webm"] as const;
const compatibilityAudioMimeTypes = [
  "video/webm;codecs=vp8,opus",
  "video/webm;codecs=vp9,opus",
  "video/webm"
] as const;

export async function selectVideoRecorderProfile(
  width: number,
  height: number,
  fps: VideoFps,
  bitrate: number,
  hasAudio: boolean
): Promise<VideoRecorderProfile> {
  if (typeof VideoEncoder !== "undefined") {
    const videoSupport = await VideoEncoder.isConfigSupported({
      bitrate,
      codec: hardwareVideoCodec,
      framerate: fps,
      hardwareAcceleration: "prefer-hardware",
      height,
      latencyMode: "realtime",
      width
    });
    let isAudioSupported = !hasAudio;
    if (hasAudio && typeof AudioEncoder !== "undefined") {
      const audioSupport = await AudioEncoder.isConfigSupported({
        bitrate: audioBitrate,
        codec: "mp4a.40.2",
        numberOfChannels: audioChannelCount,
        sampleRate: audioSampleRate
      });
      isAudioSupported = audioSupport.supported ?? false;
    }
    if (videoSupport.supported && isAudioSupported) {
      return {
        encoder: "hardware",
        fileExtension: "mp4",
        mimeType: hasAudio ? hardwareAudioVideoMimeType : hardwareVideoMimeType
      };
    }
  }

  const mimeTypes = hasAudio ? compatibilityAudioMimeTypes : compatibilityMimeTypes;
  const mimeType = mimeTypes.find((candidate) => MediaRecorder.isTypeSupported(candidate));
  if (!mimeType) {
    throw new Error("This system does not support screen recording through MediaRecorder.");
  }

  return {
    encoder: "compatibility",
    fileExtension: "webm",
    mimeType
  };
}
