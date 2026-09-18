import {
  timelineDuration,
  timelineLocationsAt,
  type TimelineSegment
} from "./editor-timeline.js";

const waveformBarSpacingPx = 2;
const waveformMinimumBarHeightPx = 1;
const half = 0.5;

export function timelineWaveformPeaks(
  sourcePeaks: readonly number[],
  sourceDurationSeconds: number,
  segments: readonly TimelineSegment[],
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

  const editedDurationSeconds = timelineDuration(segments);
  const outputIndexes = Array.from({ length: outputPeakCount }).keys();
  const timelineTimes = Array.from(
    outputIndexes,
    (outputIndex) => ((outputIndex + half) / outputPeakCount) * editedDurationSeconds
  );
  return timelineLocationsAt(segments, timelineTimes).map(({ sourceTime }) => {
    const sourceIndex = Math.min(
      Math.floor((sourceTime / sourceDurationSeconds) * sourcePeaks.length),
      sourcePeaks.length - 1
    );
    return sourcePeaks[sourceIndex] ?? 0;
  });
}

export function drawTimelineWaveform(
  canvas: HTMLCanvasElement,
  sourcePeaks: readonly number[],
  sourceDurationSeconds: number,
  segments: readonly TimelineSegment[],
  isMuted: boolean
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
  const outputPeakCount = Math.max(1, Math.floor(bounds.width / waveformBarSpacingPx));
  const peaks = timelineWaveformPeaks(sourcePeaks, sourceDurationSeconds, segments, outputPeakCount);
  const centerY = bounds.height / waveformBarSpacingPx;
  const maximumHeight = Math.max(waveformMinimumBarHeightPx, centerY - waveformMinimumBarHeightPx);
  context.fillStyle = isMuted ? "rgba(180, 188, 198, 0.5)" : "rgba(96, 202, 246, 0.92)";
  for (const [peakIndex, peak] of peaks.entries()) {
    const height = Math.max(waveformMinimumBarHeightPx, peak * maximumHeight);
    context.fillRect(
      peakIndex * waveformBarSpacingPx,
      centerY - height,
      waveformMinimumBarHeightPx,
      height * waveformBarSpacingPx
    );
  }
}
