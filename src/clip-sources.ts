import { BrowserWindow, desktopCapturer, type Display, screen } from "electron";

import { GameLibrary } from "./game-library";
import { type WindowProcess, windowProcesses } from "./powershell";
import type { ClipDisplayOption, ClipSource, ClipSourceOptions, ClipWindowOption } from "./shared";

const sourceIdSeparator = ":";
const desktopClipName = "Desktop";
const gameSourceName = "a game";
const sharedHostProcessNames: ReadonlySet<string> = new Set(["ApplicationFrameHost"]);
const emptyThumbnailSize = { height: 0, width: 0 };

export interface ResolvedClipSource {
  clipName: string;
  display: Display | null;
  name: string;
  source: Electron.DesktopCapturerSource;
}

type WindowClipSource = Extract<ClipSource, { kind: "window" }>;

export class ClipSourceResolver {
  private gameLibrary: GameLibrary | null = null;

  private readonly processesBySourceId = new Map<string, WindowProcess | null>();

  private async loadProcesses(windows: readonly Electron.DesktopCapturerSource[]): Promise<void> {
    if (windows.every((window) => this.processesBySourceId.has(window.id))) {
      return;
    }

    const processes = await windowProcesses();
    this.gameLibrary = null;
    this.processesBySourceId.clear();
    for (const window of windows) {
      const windowProcess = processes.get(windowHandle(window.id)) ?? null;
      this.processesBySourceId.set(
        window.id,
        windowProcess === null || sharedHostProcessNames.has(windowProcess.name) ? null : windowProcess
      );
    }
  }

  private processName(sourceId: string): string | null {
    return this.processesBySourceId.get(sourceId)?.name ?? null;
  }

  private async resolveGame(): Promise<ResolvedClipSource | null> {
    const windows = await capturableWindows(false);
    await this.loadProcesses(windows);
    const gameLibrary = this.gameLibrary ?? await GameLibrary.load();
    this.gameLibrary = gameLibrary;
    const game = windows.find((window) => {
      const executablePath = this.processesBySourceId.get(window.id)?.executablePath ?? null;
      return executablePath !== null && gameLibrary.isGame(executablePath);
    });
    return game ? windowClipSource(game) : null;
  }

  private async resolveWindow(saved: WindowClipSource): Promise<ResolvedClipSource | null> {
    const windows = await capturableWindows(false);
    if (saved.processName === null) {
      const match = windows.find((window) => window.name === saved.title);
      return match ? windowClipSource(match) : null;
    }

    await this.loadProcesses(windows);
    const matchingWindows = windows.filter((window) => this.processName(window.id) === saved.processName);
    const match = matchingWindows.find((window) => window.name === saved.title) ?? matchingWindows.at(0);
    return match ? windowClipSource(match) : null;
  }

  async listOptions(): Promise<ClipSourceOptions> {
    const windows = await capturableWindows(true);
    await this.loadProcesses(windows);
    return {
      displays: displayOptions(),
      windows: windows.map((window): ClipWindowOption => ({
        iconDataUrl: window.appIcon.isEmpty() ? null : window.appIcon.toDataURL(),
        processName: this.processName(window.id),
        title: window.name
      }))
    };
  }

  async resolve(source: ClipSource): Promise<ResolvedClipSource | null> {
    if (source.kind === "display") {
      return await resolveDisplay(source.displayId);
    }

    return source.kind === "game" ? await this.resolveGame() : await this.resolveWindow(source);
  }
}

export async function primaryScreenSource(): Promise<Electron.DesktopCapturerSource> {
  const primaryDisplayId = String(screen.getPrimaryDisplay().id);
  const sources = await desktopCapturer.getSources({
    fetchWindowIcons: false,
    thumbnailSize: emptyThumbnailSize,
    types: ["screen"]
  });
  const source = sources.find((candidate) => candidate.display_id === primaryDisplayId);
  if (!source) {
    throw new Error("Could not find the primary monitor for desktop audio.");
  }

  return source;
}

export function clipSourceName(source: ClipSource): string {
  if (source.kind === "window") {
    return source.title;
  }

  if (source.kind === "game") {
    return gameSourceName;
  }

  const displays = screen.getAllDisplays();
  const display = clipDisplay(displays, source.displayId);
  return display ? displayLabel(display, displays.indexOf(display)) : "the selected monitor";
}

async function resolveDisplay(displayId: number | null): Promise<ResolvedClipSource | null> {
  const displays = screen.getAllDisplays();
  const display = clipDisplay(displays, displayId);
  if (!display) {
    return null;
  }

  const sources = await desktopCapturer.getSources({
    fetchWindowIcons: false,
    thumbnailSize: emptyThumbnailSize,
    types: ["screen"]
  });
  const source = sources.find((candidate) => candidate.display_id === String(display.id));
  return source
    ? { clipName: desktopClipName, display, name: displayLabel(display, displays.indexOf(display)), source }
    : null;
}

async function capturableWindows(shouldFetchIcons: boolean): Promise<Electron.DesktopCapturerSource[]> {
  const ownSourceIds = new Set(BrowserWindow.getAllWindows().map((window) => window.getMediaSourceId()));
  const sources = await desktopCapturer.getSources({
    fetchWindowIcons: shouldFetchIcons,
    thumbnailSize: emptyThumbnailSize,
    types: ["window"]
  });
  return sources.filter((source) => !ownSourceIds.has(source.id) && source.name.trim().length > 0);
}

function clipDisplay(displays: readonly Display[], displayId: number | null): Display | undefined {
  const targetDisplayId = displayId ?? screen.getPrimaryDisplay().id;
  return displays.find((display) => display.id === targetDisplayId);
}

function displayOptions(): ClipDisplayOption[] {
  const primaryDisplayId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((display, index): ClipDisplayOption => ({
    height: Math.round(display.size.height * display.scaleFactor),
    id: display.id,
    isPrimary: display.id === primaryDisplayId,
    label: displayLabel(display, index),
    width: Math.round(display.size.width * display.scaleFactor)
  }));
}

function displayLabel(display: Display, index: number): string {
  return display.label.trim() || `Display ${String(index + 1)}`;
}

function windowClipSource(source: Electron.DesktopCapturerSource): ResolvedClipSource {
  return { clipName: source.name, display: null, name: source.name, source };
}

export function windowHandle(sourceId: string): string {
  return sourceId.split(sourceIdSeparator).at(1) ?? "";
}
