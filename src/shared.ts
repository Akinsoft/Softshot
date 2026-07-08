const standardVideoFps = 30;
const highVideoFps = 60;
const lowVideoHeight = 720;
const highVideoHeight = 1080;

export const videoFpsOptions = {
  standard: standardVideoFps,
  high: highVideoFps
} as const;

export const videoQualityHeights = {
  low: lowVideoHeight,
  high: highVideoHeight
} as const;

export type CaptureMode = "screenshot" | "video";
export type DrawingTool = "select" | "pen" | "arrow";
export type VideoQuality = "720p" | "1080p";
export type VideoFps = (typeof videoFpsOptions)[keyof typeof videoFpsOptions];

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OverlayBootstrap {
  sourceId: string;
  imageDataUrl: string;
  displayBounds: Rect;
  scaleFactor: number;
}

export interface SaveResult {
  filePath: string;
}

export interface SoftshotApi {
  getBootstrap(): Promise<OverlayBootstrap>;
  saveScreenshot(dataUrl: string): Promise<SaveResult>;
  copyScreenshot(dataUrl: string): Promise<void>;
  saveVideo(bytes: Uint8Array): Promise<SaveResult>;
  readyToShow(): Promise<void>;
  closeOverlay(): Promise<void>;
  showError(message: string): Promise<void>;
}
