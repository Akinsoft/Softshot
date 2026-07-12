import type { Annotation, ArrowAnnotation, PenAnnotation, Point } from "./overlay-model.js";
import { minimumPenPointCount } from "./overlay-model.js";
import type { Rect } from "./shared.js";

const arrowHeadLengthPx = 16;
const arrowHeadWidthPx = 10;
const arrowLineWidthPx = 4;
const halfTurnDivisor = 2;
const penLineWidthPx = 4;
const selectionDashGapPx = 7;
const selectionDashLengthPx = 8;
const selectionLineInsetPx = 1;
const selectionLineOffsetPx = 0.5;
const selectionLineWidthPx = 2;

export interface AnnotationTransform {
  clip: Rect | null;
  offset: Point;
  scale: Point;
}

export function drawAnnotations(
  targetContext: CanvasRenderingContext2D,
  annotations: Annotation[],
  transform: AnnotationTransform
): void {
  targetContext.save();
  applyClip(targetContext, transform);
  targetContext.scale(transform.scale.x, transform.scale.y);
  targetContext.translate(-transform.offset.x, -transform.offset.y);

  for (const annotation of annotations) {
    if (annotation.kind === "pen") {
      drawPen(targetContext, annotation);
    } else {
      drawArrow(targetContext, annotation);
    }
  }

  targetContext.restore();
}

export function drawArrow(targetContext: CanvasRenderingContext2D, annotation: ArrowAnnotation): void {
  const angle = Math.atan2(annotation.to.y - annotation.from.y, annotation.to.x - annotation.from.x);
  const headBase = {
    x: annotation.to.x - arrowHeadLengthPx * Math.cos(angle),
    y: annotation.to.y - arrowHeadLengthPx * Math.sin(angle)
  };
  const left = arrowHeadSide(headBase, angle - Math.PI / halfTurnDivisor);
  const right = arrowHeadSide(headBase, angle + Math.PI / halfTurnDivisor);
  const shaftPath = new Path2D();
  shaftPath.moveTo(annotation.from.x, annotation.from.y);
  shaftPath.lineTo(headBase.x, headBase.y);

  const headPath = new Path2D();
  headPath.moveTo(annotation.to.x, annotation.to.y);
  headPath.lineTo(left.x, left.y);
  headPath.lineTo(right.x, right.y);
  headPath.closePath();

  targetContext.save();
  targetContext.strokeStyle = annotation.color;
  targetContext.fillStyle = annotation.color;
  targetContext.lineWidth = arrowLineWidthPx;
  targetContext.lineCap = "round";
  targetContext.lineJoin = "round";
  targetContext.stroke(shaftPath);
  fillCanvasPath(targetContext, headPath);
  targetContext.restore();
}

export function drawSelectionFrame(
  targetContext: CanvasRenderingContext2D,
  rect: Rect,
  isRecordingState: boolean
): void {
  targetContext.save();
  targetContext.strokeStyle = isRecordingState ? "#f87171" : "#38bdf8";
  targetContext.lineWidth = selectionLineWidthPx;
  targetContext.setLineDash([selectionDashLengthPx, selectionDashGapPx]);
  targetContext.strokeRect(
    rect.x + selectionLineOffsetPx,
    rect.y + selectionLineOffsetPx,
    rect.width - selectionLineInsetPx,
    rect.height - selectionLineInsetPx
  );
  targetContext.restore();
}

function applyClip(targetContext: CanvasRenderingContext2D, transform: AnnotationTransform): void {
  if (!transform.clip) {
    return;
  }

  const clipPath = new Path2D();
  clipPath.rect(
    (transform.clip.x - transform.offset.x) * transform.scale.x,
    (transform.clip.y - transform.offset.y) * transform.scale.y,
    transform.clip.width * transform.scale.x,
    transform.clip.height * transform.scale.y
  );
  targetContext.clip(clipPath);
}

function arrowHeadSide(base: Point, angle: number): Point {
  return {
    x: base.x + arrowHeadWidthPx * Math.cos(angle),
    y: base.y + arrowHeadWidthPx * Math.sin(angle)
  };
}

function drawPen(targetContext: CanvasRenderingContext2D, annotation: PenAnnotation): void {
  if (annotation.points.length < minimumPenPointCount) {
    return;
  }

  const path = new Path2D();
  path.moveTo(annotation.points[0].x, annotation.points[0].y);

  for (const point of annotation.points.slice(1)) {
    path.lineTo(point.x, point.y);
  }

  targetContext.save();
  targetContext.strokeStyle = annotation.color;
  targetContext.lineWidth = penLineWidthPx;
  targetContext.lineCap = "round";
  targetContext.lineJoin = "round";
  targetContext.stroke(path);
  targetContext.restore();
}

function fillCanvasPath(targetContext: CanvasRenderingContext2D, path: Path2D): void {
  targetContext.fill(path, "nonzero");
}
