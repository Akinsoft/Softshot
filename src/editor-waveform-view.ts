import { type TimelineSegment, timelineSegmentDuration } from "./editor-timeline.js";

const waveformBarSpacingPx = 2;
const waveformClipGapPx = 2;
const waveformClipRadiusPx = 5;
const waveformMinimumBarHeightPx = 1;
const half = 0.5;
const activeWaveformColors = { bars: "rgba(94, 234, 212, 0.88)", clip: "rgba(45, 212, 191, 0.13)" };
const mutedWaveformColors = { bars: "rgba(180, 188, 198, 0.42)", clip: "rgba(148, 163, 184, 0.08)" };

export function segmentWaveformPeaks(
  sourcePeaks: readonly number[],
  sourceDurationSeconds: number,
  segment: TimelineSegment,
  outputPeakCount: number
): number[] {
  if (sourcePeaks.length === 0 || sourcePeaks.some((peak) => !Number.isFinite(peak) || peak < 0 || peak > 1)) {
    throw new RangeError("Waveform peaks must contain normalized finite values.");
  }

  if (!Number.isFinite(sourceDurationSeconds) || sourceDurationSeconds <= 0) {
    throw new RangeError("The waveform source duration must be positive and finite.");
  }

  if (!Number.isSafeInteger(outputPeakCount) || outputPeakCount <= 0) {
    throw new RangeError("The waveform output peak count must be a positive integer.");
  }

  const segmentDurationSeconds = timelineSegmentDuration(segment);
  const sourcePeaksPerSecond = sourcePeaks.length / sourceDurationSeconds;
  return Array.from(Array.from({ length: outputPeakCount }).keys(), (outputIndex) => {
    const binStartSeconds = segment.sourceStart + (outputIndex / outputPeakCount) * segmentDurationSeconds;
    const binEndSeconds = segment.sourceStart + ((outputIndex + 1) / outputPeakCount) * segmentDurationSeconds;
    const firstPeakIndex = Math.min(Math.floor(binStartSeconds * sourcePeaksPerSecond), sourcePeaks.length - 1);
    const endPeakIndex = Math.min(
      Math.max(firstPeakIndex + 1, Math.ceil(binEndSeconds * sourcePeaksPerSecond)),
      sourcePeaks.length
    );
    let peak = 0;
    for (let peakIndex = firstPeakIndex; peakIndex < endPeakIndex; peakIndex += 1) {
      peak = Math.max(peak, sourcePeaks[peakIndex] ?? 0);
    }

    return peak;
  });
}

export function drawTimelineWaveform(
  canvas: HTMLCanvasElement,
  sourcePeaks: readonly number[],
  sourceDurationSeconds: number,
  segment: TimelineSegment,
  isMuted: boolean,
  volume: number
): void {
  const bounds = canvas.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) {
    return;
  }

  const deviceScale = window.devicePixelRatio;
  canvas.width = Math.max(1, Math.round(bounds.width * deviceScale));
  canvas.height = Math.max(1, Math.round(bounds.height * deviceScale));
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("The audio waveform canvas is unavailable.");
  }

  context.setTransform(deviceScale, 0, 0, deviceScale, 0, 0);
  context.clearRect(0, 0, bounds.width, bounds.height);
  const colors = isMuted ? mutedWaveformColors : activeWaveformColors;
  context.beginPath();
  context.roundRect(
    waveformClipGapPx * half,
    0,
    Math.max(0, bounds.width - waveformClipGapPx),
    bounds.height,
    waveformClipRadiusPx
  );
  context.fillStyle = colors.clip;
  context.fill();
  context.clip();

  const outputPeakCount = Math.max(1, Math.floor(bounds.width / waveformBarSpacingPx));
  const peaks = segmentWaveformPeaks(sourcePeaks, sourceDurationSeconds, segment, outputPeakCount);
  const centerY = bounds.height / waveformBarSpacingPx;
  const maximumHeight = Math.max(waveformMinimumBarHeightPx, centerY - waveformMinimumBarHeightPx);
  context.fillStyle = colors.bars;
  for (const [peakIndex, peak] of peaks.entries()) {
    const height = Math.max(waveformMinimumBarHeightPx, Math.min(peak * volume, 1) * maximumHeight);
    context.fillRect(
      peakIndex * waveformBarSpacingPx,
      centerY - height,
      waveformMinimumBarHeightPx,
      height * waveformBarSpacingPx
    );
  }
}
