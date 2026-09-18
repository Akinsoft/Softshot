import { recordingAudioConstraints } from "./audio-quality.js";
import type { VideoFps } from "./shared.js";
import { getSoftshotApi } from "./softshot-api.js";

interface DisplayCaptureVideoConstraints extends MediaTrackConstraints {
  cursor: "never";
  displaySurface: "monitor";
  frameRate: VideoFps;
}

interface DisplayCaptureOptions extends DisplayMediaStreamOptions {
  audio: false | MediaTrackConstraints;
  video: DisplayCaptureVideoConstraints;
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

export function stopTracks(stream: MediaStream | null): void {
  if (!stream) {
    return;
  }

  for (const track of stream.getTracks()) {
    track.stop();
  }
}
