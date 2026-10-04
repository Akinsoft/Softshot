import type { TrimRange } from "./editor-export.js";

const missingTimelineSegmentMessage = "The selected timeline segment no longer exists.";

export interface TimelineSegment {
  id: number;
  sourceEnd: number;
  sourceStart: number;
}

export interface TimelineLocation {
  segment: TimelineSegment;
  segmentIndex: number;
  sourceTime: number;
  timelineEnd: number;
  timelineStart: number;
}

export interface TimelineSegmentBounds {
  timelineEnd: number;
  timelineStart: number;
}

export interface TimelineSplit {
  rightSegmentId: number;
  segments: TimelineSegment[];
}

export type TimelineSegmentEdge = "end" | "start";

export function timelineSegmentDuration(segment: TimelineSegment): number {
  const duration = segment.sourceEnd - segment.sourceStart;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new RangeError("Timeline segments must have a positive finite duration.");
  }

  return duration;
}

export function timelineDuration(segments: readonly TimelineSegment[]): number {
  requireTimelineSegments(segments);
  return segments.reduce((duration, segment) => duration + timelineSegmentDuration(segment), 0);
}

export function timelineLocationAt(segments: readonly TimelineSegment[], timelineTime: number): TimelineLocation {
  return locateTimelinePosition(segments, timelineTime, timelineDuration(segments));
}

export function timelineLocationsAt(
  segments: readonly TimelineSegment[],
  timelineTimes: readonly number[]
): TimelineLocation[] {
  const duration = timelineDuration(segments);
  return timelineTimes.map((time) => locateTimelinePosition(segments, time, duration));
}

function locateTimelinePosition(
  segments: readonly TimelineSegment[],
  timelineTime: number,
  duration: number
): TimelineLocation {
  if (!Number.isFinite(timelineTime)) {
    throw new RangeError("Timeline time must be finite.");
  }

  const safeTime = Math.min(Math.max(timelineTime, 0), duration);
  let timelineStart = 0;
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = requiredSegmentAt(segments, segmentIndex);
    const segmentDuration = timelineSegmentDuration(segment);
    const timelineEnd = timelineStart + segmentDuration;
    if (safeTime < timelineEnd || segmentIndex === segments.length - 1) {
      return {
        segment,
        segmentIndex,
        sourceTime: segment.sourceStart + Math.min(Math.max(safeTime - timelineStart, 0), segmentDuration),
        timelineEnd,
        timelineStart
      };
    }

    timelineStart = timelineEnd;
  }

  throw new Error("Could not locate the timeline position.");
}

export function timelineSegmentById(segments: readonly TimelineSegment[], segmentId: number): TimelineSegment {
  return requiredSegmentAt(segments, timelineSegmentIndex(segments, segmentId));
}

export function timelineSegmentBounds(
  segments: readonly TimelineSegment[],
  segmentId: number
): TimelineSegmentBounds {
  requireTimelineSegments(segments);
  let timelineStart = 0;
  for (const segment of segments) {
    const timelineEnd = timelineStart + timelineSegmentDuration(segment);
    if (segment.id === segmentId) {
      return { timelineEnd, timelineStart };
    }

    timelineStart = timelineEnd;
  }

  throw new Error(missingTimelineSegmentMessage);
}

export function splitTimelineAt(
  segments: readonly TimelineSegment[],
  timelineTime: number,
  rightSegmentId: number,
  minimumSegmentDuration: number
): TimelineSplit {
  if (!Number.isFinite(minimumSegmentDuration) || minimumSegmentDuration <= 0) {
    throw new RangeError("The minimum segment duration must be positive and finite.");
  }

  if (segments.some((segment) => segment.id === rightSegmentId)) {
    throw new Error("Timeline segment identifiers must be unique.");
  }

  const location = timelineLocationAt(segments, timelineTime);
  const leftDuration = location.sourceTime - location.segment.sourceStart;
  const rightDuration = location.segment.sourceEnd - location.sourceTime;
  if (leftDuration < minimumSegmentDuration || rightDuration < minimumSegmentDuration) {
    throw new RangeError("Move the playhead farther away from the segment edge before cutting.");
  }

  const leftSegment = {
    ...location.segment,
    sourceEnd: location.sourceTime
  };
  const rightSegment = {
    id: rightSegmentId,
    sourceEnd: location.segment.sourceEnd,
    sourceStart: location.sourceTime
  };
  return {
    rightSegmentId,
    segments: [
      ...segments.slice(0, location.segmentIndex),
      leftSegment,
      rightSegment,
      ...segments.slice(location.segmentIndex + 1)
    ]
  };
}

export function deleteTimelineSegment(
  segments: readonly TimelineSegment[],
  segmentId: number
): TimelineSegment[] {
  requireTimelineSegments(segments);
  if (segments.length === 1) {
    throw new Error("The final timeline segment cannot be deleted.");
  }

  const segmentIndex = timelineSegmentIndex(segments, segmentId);
  return [
    ...segments.slice(0, segmentIndex),
    ...segments.slice(segmentIndex + 1)
  ];
}

export function moveTimelineSegment(
  segments: readonly TimelineSegment[],
  segmentId: number,
  targetIndex: number
): TimelineSegment[] {
  requireTimelineSegments(segments);
  if (!Number.isSafeInteger(targetIndex) || targetIndex < 0 || targetIndex >= segments.length) {
    throw new RangeError("The timeline clip destination is invalid.");
  }

  const segmentIndex = timelineSegmentIndex(segments, segmentId);
  const segment = requiredSegmentAt(segments, segmentIndex);
  const remainingSegments = [
    ...segments.slice(0, segmentIndex),
    ...segments.slice(segmentIndex + 1)
  ];
  return [
    ...remainingSegments.slice(0, targetIndex),
    segment,
    ...remainingSegments.slice(targetIndex)
  ];
}

export function resizeTimelineSegment(
  segments: readonly TimelineSegment[],
  segmentId: number,
  edge: TimelineSegmentEdge,
  sourceTime: number,
  minimumSegmentDuration: number,
  sourceDuration: number
): TimelineSegment[] {
  requireTimelineSegments(segments);
  if (!Number.isFinite(sourceTime)) {
    throw new RangeError("The timeline resize position must be finite.");
  }

  if (!Number.isFinite(minimumSegmentDuration) || minimumSegmentDuration <= 0) {
    throw new RangeError("The minimum segment duration must be positive and finite.");
  }

  if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) {
    throw new RangeError("The source duration must be positive and finite.");
  }

  const segmentIndex = timelineSegmentIndex(segments, segmentId);
  const sourceOrderedSegments = segments.toSorted(compareTimelineSegmentSourceStart);
  requireTimelineSourceBounds(sourceOrderedSegments, sourceDuration);
  const sourceSegmentIndex = timelineSegmentIndex(sourceOrderedSegments, segmentId);
  const segment = requiredSegmentAt(sourceOrderedSegments, sourceSegmentIndex);
  const previousSegment = sourceSegmentIndex > 0
    ? requiredSegmentAt(sourceOrderedSegments, sourceSegmentIndex - 1)
    : null;
  const nextSegment = sourceOrderedSegments.at(sourceSegmentIndex + 1);
  const lowerBound = edge === "start"
    ? previousSegment?.sourceEnd ?? 0
    : segment.sourceStart + minimumSegmentDuration;
  const upperBound = edge === "start"
    ? segment.sourceEnd - minimumSegmentDuration
    : nextSegment?.sourceStart ?? sourceDuration;
  if (segment.sourceStart < 0 || segment.sourceEnd > sourceDuration || lowerBound > upperBound) {
    throw new RangeError("Timeline segments must stay in source order and within the recording.");
  }

  const resizedSourceTime = Math.min(Math.max(sourceTime, lowerBound), upperBound);
  const resizedSegment = edge === "start"
    ? { ...segment, sourceStart: resizedSourceTime }
    : { ...segment, sourceEnd: resizedSourceTime };
  return [
    ...segments.slice(0, segmentIndex),
    resizedSegment,
    ...segments.slice(segmentIndex + 1)
  ];
}

export function sourceRangesForTimeline(segments: readonly TimelineSegment[]): TrimRange[] {
  return sourceRangesForTimelineRange(segments, {
    end: timelineDuration(segments),
    start: 0
  });
}

export function sourceRangesForTimelineRange(
  segments: readonly TimelineSegment[],
  timelineRange: TrimRange
): TrimRange[] {
  const duration = timelineDuration(segments);
  if (!Number.isFinite(timelineRange.start)
    || !Number.isFinite(timelineRange.end)
    || timelineRange.start < 0
    || timelineRange.end > duration
    || timelineRange.end <= timelineRange.start) {
    throw new RangeError("The timeline export range is invalid.");
  }

  const ranges: TrimRange[] = [];
  let timelineStart = 0;
  for (const segment of segments) {
    const segmentDuration = timelineSegmentDuration(segment);
    const timelineEnd = timelineStart + segmentDuration;
    const overlapStart = Math.max(timelineRange.start, timelineStart);
    const overlapEnd = Math.min(timelineRange.end, timelineEnd);
    if (overlapEnd > overlapStart) {
      appendSourceRange(ranges, {
        end: segment.sourceStart + overlapEnd - timelineStart,
        start: segment.sourceStart + overlapStart - timelineStart
      });
    }

    timelineStart = timelineEnd;
  }

  if (ranges.length === 0) {
    throw new Error("The timeline export range does not contain any video.");
  }

  return ranges;
}

export function timelineTimeAfterDeletion(
  timelineTime: number,
  deletedRange: TimelineSegmentBounds
): number {
  if (deletedRange.timelineEnd <= deletedRange.timelineStart) {
    throw new RangeError("The deleted timeline range is invalid.");
  }

  if (timelineTime <= deletedRange.timelineStart) {
    return timelineTime;
  }

  if (timelineTime < deletedRange.timelineEnd) {
    return deletedRange.timelineStart;
  }

  return timelineTime - (deletedRange.timelineEnd - deletedRange.timelineStart);
}

function appendSourceRange(ranges: TrimRange[], sourceRange: TrimRange): void {
  const previousRange = ranges.at(-1);
  if (previousRange?.end === sourceRange.start) {
    previousRange.end = sourceRange.end;
    return;
  }

  ranges.push(sourceRange);
}

function compareTimelineSegmentSourceStart(left: TimelineSegment, right: TimelineSegment): number {
  return left.sourceStart - right.sourceStart;
}

function requireTimelineSegments(segments: readonly TimelineSegment[]): void {
  if (segments.length === 0) {
    throw new Error("The timeline must contain at least one segment.");
  }

  const segmentIds = new Set<number>();
  for (const segment of segments) {
    timelineSegmentDuration(segment);
    if (segmentIds.has(segment.id)) {
      throw new Error("Timeline segment identifiers must be unique.");
    }

    segmentIds.add(segment.id);
  }
}

function requireTimelineSourceBounds(segments: readonly TimelineSegment[], sourceDuration: number): void {
  let previousSourceEnd = 0;
  for (const segment of segments) {
    if (segment.sourceStart < previousSourceEnd || segment.sourceEnd > sourceDuration) {
      throw new RangeError("Timeline segments must stay in source order and within the recording.");
    }

    previousSourceEnd = segment.sourceEnd;
  }
}

function timelineSegmentIndex(segments: readonly TimelineSegment[], segmentId: number): number {
  const segmentIndex = segments.findIndex((segment) => segment.id === segmentId);
  if (segmentIndex === -1) {
    throw new Error(missingTimelineSegmentMessage);
  }

  return segmentIndex;
}

function requiredSegmentAt(segments: readonly TimelineSegment[], segmentIndex: number): TimelineSegment {
  const segment = segments.at(segmentIndex);
  if (!segment) {
    throw new Error("The timeline segment is missing.");
  }

  return segment;
}
