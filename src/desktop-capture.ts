import type { VideoFps } from "./shared.js";

interface DisplayCaptureVideoConstraints extends MediaTrackConstraints {
  cursor: "never";
  displaySurface: "monitor";
  frameRate: VideoFps;
}

interface DisplayCaptureOptions extends DisplayMediaStreamOptions {
  audio: false;
  video: DisplayCaptureVideoConstraints;
}

export async function getCursorlessDesktopStream(fps: VideoFps): Promise<MediaStream> {
  const options: DisplayCaptureOptions = {
    audio: false,
    video: {
      cursor: "never",
      displaySurface: "monitor",
      frameRate: fps
    }
  };

  return await navigator.mediaDevices.getDisplayMedia(options);
}

export function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}
