import type { TimelineSegment } from "./editor-timeline.js";
import { mediaElementError, mediaElementOperationTimeoutMs, waitForMediaMetadata } from "./media-element.js";
import { canvasToBlob, getCanvasContext } from "./overlay-dom.js";

const thumbnailImageMimeType = "image/webp";
const thumbnailImageQuality = 0.72;
const minimumCanvasDimensionPx = 1;
const half = 0.5;

export interface TimelineThumbnail {
  sourceTime: number;
  url: string;
}

export interface TimelineFilmstrip {
  offsetSeconds: number;
  thumbnails: TimelineThumbnail[];
}

export function timelineThumbnailTimes(durationSeconds: number, thumbnailCount: number): number[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new RangeError("The thumbnail duration must be positive and finite.");
  }

  if (!Number.isSafeInteger(thumbnailCount) || thumbnailCount <= 0) {
    throw new RangeError("The thumbnail count must be a positive integer.");
  }

  const times: number[] = [];
  for (let index = 0; index < thumbnailCount; index += 1) {
    times.push(((index + half) / thumbnailCount) * durationSeconds);
  }

  return times;
}

export function timelineFilmstrip(
  thumbnails: readonly TimelineThumbnail[],
  segment: TimelineSegment,
  tileDurationSeconds: number
): TimelineFilmstrip {
  if (!Number.isFinite(tileDurationSeconds) || tileDurationSeconds <= 0) {
    throw new RangeError("The filmstrip tile duration must be positive and finite.");
  }

  if (thumbnails.length === 0) {
    return { offsetSeconds: 0, thumbnails: [] };
  }

  const firstTileIndex = Math.floor(segment.sourceStart / tileDurationSeconds);
  const endTileIndex = Math.max(firstTileIndex + 1, Math.ceil(segment.sourceEnd / tileDurationSeconds));
  const tileThumbnails: TimelineThumbnail[] = [];
  for (let tileIndex = firstTileIndex; tileIndex < endTileIndex; tileIndex += 1) {
    tileThumbnails.push(nearestTimelineThumbnail(thumbnails, (tileIndex + half) * tileDurationSeconds));
  }

  return {
    offsetSeconds: segment.sourceStart - firstTileIndex * tileDurationSeconds,
    thumbnails: tileThumbnails
  };
}

function nearestTimelineThumbnail(thumbnails: readonly TimelineThumbnail[], sourceTime: number): TimelineThumbnail {
  let closestThumbnail = requiredFirstThumbnail(thumbnails);
  for (const candidate of thumbnails.slice(1)) {
    if (Math.abs(candidate.sourceTime - sourceTime) < Math.abs(closestThumbnail.sourceTime - sourceTime)) {
      closestThumbnail = candidate;
    }
  }

  return closestThumbnail;
}

function requiredFirstThumbnail(thumbnails: readonly TimelineThumbnail[]): TimelineThumbnail {
  const thumbnail = thumbnails.at(0);
  if (!thumbnail) {
    throw new Error("The timeline preview list is unexpectedly empty.");
  }

  return thumbnail;
}

export async function captureVideoTimelineThumbnails(
  sourceUrl: string,
  durationSeconds: number,
  thumbnailCount: number,
  thumbnailWidthPx: number
): Promise<TimelineThumbnail[]> {
  if (sourceUrl.length === 0) {
    throw new Error("The thumbnail video source is missing.");
  }

  if (!Number.isSafeInteger(thumbnailWidthPx) || thumbnailWidthPx <= 0) {
    throw new RangeError("The thumbnail width must be a positive integer.");
  }

  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = sourceUrl;
  const thumbnails: TimelineThumbnail[] = [];
  try {
    await waitForMediaMetadata(video);
    if (video.videoWidth < 1 || video.videoHeight < 1) {
      throw new Error("The recording has no video frames for timeline previews.");
    }

    const canvas = document.createElement("canvas");
    canvas.width = thumbnailWidthPx;
    canvas.height = Math.max(
      minimumCanvasDimensionPx,
      Math.round((thumbnailWidthPx * video.videoHeight) / video.videoWidth)
    );
    const context = getCanvasContext(canvas, "The timeline preview canvas is unavailable.");
    for (const sourceTime of timelineThumbnailTimes(durationSeconds, thumbnailCount)) {
      await seekVideo(video, sourceTime);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await canvasToBlob(canvas, thumbnailImageMimeType, thumbnailImageQuality);
      thumbnails.push({ sourceTime, url: URL.createObjectURL(blob) });
    }

    return thumbnails;
  } catch (error) {
    releaseTimelineThumbnailUrls(thumbnails);

    throw error;
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}

export function releaseTimelineThumbnailUrls(thumbnails: readonly TimelineThumbnail[]): void {
  for (const thumbnail of thumbnails) {
    URL.revokeObjectURL(thumbnail.url);
  }
}

async function seekVideo(video: HTMLVideoElement, sourceTime: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    function cleanup(): void {
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
      }

      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    }
    function onSeeked(): void {
      cleanup();
      resolve();
    }
    function onError(): void {
      cleanup();
      reject(mediaElementError(video, "loading a timeline preview frame"));
    }

    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
    timeoutHandle = setTimeout((): void => {
      cleanup();
      reject(new Error("Timed out loading a timeline preview frame."));
    }, mediaElementOperationTimeoutMs);
    try {
      video.currentTime = sourceTime;
    } catch (error) {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
