import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { isMissingFileError } from "./async-errors";

export interface WindowBounds {
  height: number;
  width: number;
  x: number;
  y: number;
}

export interface AppWindowState {
  bounds: WindowBounds;
  isMaximized: boolean;
}

const windowStateFileName = "window-state.json";
const windowStateTemporaryFileName = `${windowStateFileName}.tmp`;
const windowStateIndentSpaces = 2;
const minVisibleTitleBarWidthPx = 120;

export async function loadAppWindowState(userDataPath: string): Promise<AppWindowState | null> {
  try {
    const contents = await readFile(windowStateFilePath(userDataPath), "utf8");
    return appWindowStateFromJson(JSON.parse(contents));
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }

    throw error;
  }
}

export function saveAppWindowState(userDataPath: string, state: AppWindowState): void {
  const filePath = windowStateFilePath(userDataPath);
  const temporaryFilePath = path.join(userDataPath, windowStateTemporaryFileName);
  mkdirSync(userDataPath, { recursive: true });
  try {
    writeFileSync(temporaryFilePath, `${JSON.stringify(state, null, windowStateIndentSpaces)}\n`);
    renameSync(temporaryFilePath, filePath);
  } finally {
    rmSync(temporaryFilePath, { force: true });
  }
}

export function isTitleBarOnScreen(
  bounds: WindowBounds,
  titleBarHeightPx: number,
  workAreas: readonly WindowBounds[]
): boolean {
  const titleBar: WindowBounds = { ...bounds, height: titleBarHeightPx };
  return workAreas.some((workArea) => {
    const overlapWidth = Math.min(titleBar.x + titleBar.width, workArea.x + workArea.width) - Math.max(titleBar.x, workArea.x);
    const overlapHeight = Math.min(titleBar.y + titleBar.height, workArea.y + workArea.height) - Math.max(titleBar.y, workArea.y);
    return overlapWidth >= minVisibleTitleBarWidthPx && overlapHeight > 0;
  });
}

function appWindowStateFromJson(value: unknown): AppWindowState {
  if (!isJsonObject(value)) {
    throw new TypeError("Window state file must contain a JSON object.");
  }

  if (typeof value.isMaximized !== "boolean") {
    throw new TypeError("Window state isMaximized must be true or false.");
  }

  return { bounds: windowBoundsFromJson(value.bounds), isMaximized: value.isMaximized };
}

function windowBoundsFromJson(value: unknown): WindowBounds {
  if (!isJsonObject(value)) {
    throw new TypeError("Window state bounds must be an object.");
  }

  const { height, width, x, y } = value;
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) {
    throw new TypeError("Window state position must be whole numbers.");
  }

  if (!isPositiveInteger(width) || !isPositiveInteger(height)) {
    throw new TypeError("Window state size must be positive whole numbers.");
  }

  return { height, width, x: x as number, y: y as number };
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function windowStateFilePath(userDataPath: string): string {
  return path.join(userDataPath, windowStateFileName);
}
