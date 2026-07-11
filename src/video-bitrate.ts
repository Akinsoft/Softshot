import type { VideoFps, VideoQuality } from "./shared.js";
import { videoFpsOptions, videoQualityHeights } from "./shared.js";

const highQualityVideoBitrate = 8_000_000;
const standardQualityVideoBitrate = 4_500_000;
const highFpsBitrateMultiplier = 1.25;

export function exportedVideoBitrate(height: number, selectedFps: VideoFps): number {
  const baseBitrate = height <= videoQualityHeights.low
    ? standardQualityVideoBitrate
    : highQualityVideoBitrate;
  return fpsAdjustedVideoBitrate(baseBitrate, selectedFps);
}

export function recordingVideoBitrate(selectedQuality: VideoQuality, selectedFps: VideoFps): number {
  const baseBitrate = selectedQuality === "720p"
    ? standardQualityVideoBitrate
    : highQualityVideoBitrate;
  return fpsAdjustedVideoBitrate(baseBitrate, selectedFps);
}

function fpsAdjustedVideoBitrate(baseBitrate: number, selectedFps: VideoFps): number {
  return selectedFps === videoFpsOptions.high
    ? Math.round(baseBitrate * highFpsBitrateMultiplier)
    : baseBitrate;
}
