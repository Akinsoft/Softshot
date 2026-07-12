import type { VideoFps } from "./shared.js";
import { videoFpsOptions } from "./shared.js";

const referenceVideoBitrate = 4_500_000;
const referenceVideoHeight = 720;
const referenceVideoWidth = 1280;
const minimumVideoBitrate = 1_000_000;
const maximumVideoBitrate = 20_000_000;
const highFpsBitrateMultiplier = 1.25;

export function videoBitrate(width: number, height: number, selectedFps: VideoFps): number {
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new RangeError("Video dimensions must be positive finite numbers.");
  }

  const pixelCount = width * height;
  const referencePixelCount = referenceVideoWidth * referenceVideoHeight;
  const resolutionAdjustedBitrate = referenceVideoBitrate * pixelCount / referencePixelCount;
  const adjustedBitrate = fpsAdjustedVideoBitrate(resolutionAdjustedBitrate, selectedFps);
  return Math.round(Math.min(maximumVideoBitrate, Math.max(minimumVideoBitrate, adjustedBitrate)));
}

function fpsAdjustedVideoBitrate(baseBitrate: number, selectedFps: VideoFps): number {
  return selectedFps === videoFpsOptions.high
    ? Math.round(baseBitrate * highFpsBitrateMultiplier)
    : baseBitrate;
}
