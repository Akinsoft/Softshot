import { recordingAudioConstraints } from "./audio-quality.js";
import type { VideoFps } from "./shared.js";
import { getSoftshotApi } from "./softshot-api.js";

const loopbackVideoFrameRate = 1;
const loopbackVideoSizePx = 64;

interface DisplayCaptureVideoConstraints extends MediaTrackConstraints {
  cursor: "never";
  displaySurface: "monitor";
  frameRate: VideoFps;
}

interface DisplayCaptureOptions extends DisplayMediaStreamOptions {
  audio: false | MediaTrackConstraints;
  video: DisplayCaptureVideoConstraints;
}

interface LoopbackAudioCaptureOptions extends DisplayMediaStreamOptions {
  audio: MediaTrackConstraints;
  video: MediaTrackConstraints;
}

export async function getCursorlessDesktopStream(
  displayId: number,
  fps: VideoFps,
  shouldCaptureSystemAudio: boolean
): Promise<MediaStream> {
  const options: DisplayCaptureOptions = {
    audio: shouldCaptureSystemAudio && recordingAudioConstraints(),
    video: {
      cursor: "never",
      displaySurface: "monitor",
      frameRate: fps
    }
  };

  return await navigator.locks.request("softshot-display-capture", async (): Promise<MediaStream> => {
    await getSoftshotApi().selectCaptureDisplay(displayId);
    return await navigator.mediaDevices.getDisplayMedia(options);
  });
}

export async function getLoopbackAudioStream(): Promise<MediaStream> {
  const options: LoopbackAudioCaptureOptions = {
    audio: recordingAudioConstraints(),
    video: {
      frameRate: loopbackVideoFrameRate,
      height: { max: loopbackVideoSizePx },
      width: { max: loopbackVideoSizePx }
    }
  };
  const stream = await navigator.mediaDevices.getDisplayMedia(options);
  for (const track of stream.getVideoTracks()) {
    track.stop();
    stream.removeTrack(track);
  }

  return stream;
}

export function stopTracks(stream: MediaStream | null): void {
  if (!stream) {
    return;
  }

  for (const track of stream.getTracks()) {
    track.stop();
  }
}
