import type { Rect } from "./shared.js";

export const defaultCaptureMode = "screenshot";
export const defaultDrawingTool = "select";
export const defaultPenColor = "#38bdf8";
export const defaultVideoQuality = "1080p";
export const minimumArrowLengthPx = 6;
export const minimumPenPointCount = 2;
export const minimumSelectionSizePx = 8;

export interface Point {
  x: number;
  y: number;
}

export interface PenAnnotation {
  color: string;
  kind: "pen";
  points: Point[];
}

export interface ArrowAnnotation {
  color: string;
  from: Point;
  kind: "arrow";
  to: Point;
}

export interface SelectDragState {
  current: Point;
  kind: "select";
  start: Point;
}

export interface PenDragState {
  annotation: PenAnnotation;
  kind: "pen";
}

export interface ArrowDragState {
  current: Point;
  kind: "arrow";
  start: Point;
}

export type Annotation = PenAnnotation | ArrowAnnotation;
export type DragState = ArrowDragState | PenDragState | SelectDragState | null;
export type VideoButtonState = "start" | "stop" | "video";

export function clampPointToRect(point: Point, rect: Rect | null): Point {
  if (!rect) {
    return point;
  }

  return {
    x: Math.min(Math.max(point.x, rect.x), rect.x + rect.width),
    y: Math.min(Math.max(point.y, rect.y), rect.y + rect.height)
  };
}

export function distance(from: Point, to: Point): number {
  return Math.hypot(to.x - from.x, to.y - from.y);
}

export function eventPoint(event: PointerEvent): Point {
  return {
    x: event.clientX,
    y: event.clientY
  };
}

export function isPointInRect(point: Point, rect: Rect): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}

export function normalizeArrow(annotation: ArrowAnnotation, selection: Rect | null): ArrowAnnotation {
  return {
    ...annotation,
    from: clampPointToRect(annotation.from, selection),
    to: clampPointToRect(annotation.to, selection)
  };
}

export function normalizeRect(start: Point, end: Point): Rect {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  const width = Math.abs(end.x - start.x);
  const height = Math.abs(end.y - start.y);
  return { x, y, width, height };
}
