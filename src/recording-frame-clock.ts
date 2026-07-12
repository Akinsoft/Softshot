export function nextRecordingFrameDeadline(
  currentDeadlineMs: number,
  completedAtMs: number,
  frameIntervalMs: number
): number {
  if (!Number.isFinite(currentDeadlineMs)
    || !Number.isFinite(completedAtMs)
    || !Number.isFinite(frameIntervalMs)
    || frameIntervalMs <= 0) {
    throw new RangeError("Recording frame timing values must be finite and the interval must be positive.");
  }

  const elapsedIntervals = Math.floor(Math.max(0, completedAtMs - currentDeadlineMs) / frameIntervalMs);
  return currentDeadlineMs + (elapsedIntervals + 1) * frameIntervalMs;
}
