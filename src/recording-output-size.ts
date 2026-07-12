import type { Rect, VideoQuality } from "./shared.js";
import { videoQualityDimensions } from "./shared.js";

const minimumVideoDimensionPx = 2;

interface Dimensions {
  height: number;
  width: number;
}

export function recordingOutputSize(
  rect: Rect,
  selectedQuality: VideoQuality,
  source: Dimensions,
  viewport: Dimensions
): Dimensions {
  validateDimensions(source, "Source video");
  validateDimensions(viewport, "Capture viewport");
  if (!Number.isFinite(rect.width) || rect.width <= 0 || !Number.isFinite(rect.height) || rect.height <= 0) {
    throw new RangeError("The recording region must have positive finite dimensions.");
  }

  const target = selectedQuality === "720p" ? videoQualityDimensions.low : videoQualityDimensions.high;
  const sourceWidth = rect.width * source.width / viewport.width;
  const sourceHeight = rect.height * source.height / viewport.height;
  const outputScale = Math.min(1, target.width / sourceWidth, target.height / sourceHeight);
  return {
    height: evenVideoDimension(sourceHeight * outputScale),
    width: evenVideoDimension(sourceWidth * outputScale)
  };
}

function evenVideoDimension(value: number): number {
  return Math.max(minimumVideoDimensionPx, Math.round(value / minimumVideoDimensionPx) * minimumVideoDimensionPx);
}

function validateDimensions(dimensions: Dimensions, label: string): void {
  if (!Number.isFinite(dimensions.width)
    || dimensions.width <= 0
    || !Number.isFinite(dimensions.height)
    || dimensions.height <= 0) {
    throw new RangeError(`${label} dimensions must be positive finite numbers.`);
  }
}
