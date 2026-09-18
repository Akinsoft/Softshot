import type { CaptureDisplay, Rect } from "./shared.js";

export function desktopBounds(displays: CaptureDisplay[]): Rect {
  if (displays.length === 0) {
    throw new Error("No monitors are available to capture.");
  }

  const x = Math.min(...displays.map((display) => display.bounds.x));
  const y = Math.min(...displays.map((display) => display.bounds.y));
  return {
    x,
    y,
    width: Math.max(...displays.map((display) => display.bounds.x + display.bounds.width)) - x,
    height: Math.max(...displays.map((display) => display.bounds.y + display.bounds.height)) - y
  };
}

export function displaysInViewport(displays: CaptureDisplay[], viewport: { width: number; height: number }): CaptureDisplay[] {
  const desktop = desktopBounds(displays);
  const scaleX = viewport.width / desktop.width;
  const scaleY = viewport.height / desktop.height;
  return displays.map((display) => {
    const x = (display.bounds.x - desktop.x) * scaleX;
    const y = (display.bounds.y - desktop.y) * scaleY;
    return {
      id: display.id,
      bounds: {
        x,
        y,
        width: (display.bounds.x + display.bounds.width - desktop.x) * scaleX - x,
        height: (display.bounds.y + display.bounds.height - desktop.y) * scaleY - y
      }
    };
  });
}

export function intersectRects(first: Rect, second: Rect): Rect | null {
  const x = Math.max(first.x, second.x);
  const y = Math.max(first.y, second.y);
  const width = Math.min(first.x + first.width, second.x + second.width) - x;
  const height = Math.min(first.y + first.height, second.y + second.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}
