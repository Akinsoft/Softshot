import path from "node:path";

import { app, BrowserWindow, ipcMain, screen } from "electron";

import type { ToastMessage, ToastTone } from "./shared";

const toastPageRelativePath = path.join("src", "toast.html");
const toastShowChannel = "toast:show";
const toastWindowWidthPx = 420;
const toastWindowHeightPx = 150;
const idleCloseDelayMs = 60_000;
const transparentWindowBackground = "#00000000";

export interface ToastOptions {
  detail: string | null;
  onClick: (() => void) | null;
  title: string;
  tone: ToastTone;
}

interface ActiveToast {
  id: number;
  onClick: (() => void) | null;
}

export class ToastWindow {
  private active: ActiveToast | null = null;

  private idleTimeout: ReturnType<typeof setTimeout> | null = null;

  private loading: Promise<BrowserWindow> | null = null;

  private nextId = 1;

  private window: BrowserWindow | null = null;

  constructor(
    private readonly preloadScriptPath: () => string,
    private readonly reportError: (error: unknown) => void
  ) {}

  private async loadedWindow(): Promise<BrowserWindow> {
    this.loading ??= this.createWindow();
    try {
      return await this.loading;
    } catch (error) {
      this.loading = null;
      throw error;
    }
  }

  private async createWindow(): Promise<BrowserWindow> {
    const window = new BrowserWindow({
      alwaysOnTop: true,
      backgroundColor: transparentWindowBackground,
      focusable: false,
      frame: false,
      fullscreenable: false,
      hasShadow: false,
      height: toastWindowHeightPx,
      maximizable: false,
      minimizable: false,
      movable: false,
      resizable: false,
      roundedCorners: false,
      show: false,
      skipTaskbar: true,
      thickFrame: false,
      transparent: true,
      width: toastWindowWidthPx,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: this.preloadScriptPath()
      }
    });
    window.setAlwaysOnTop(true, "screen-saver");
    window.setContentProtection(true);
    window.on("closed", (): void => {
      if (this.window !== window) {
        return;
      }

      this.window = null;
      this.loading = null;
      this.active = null;
    });
    this.window = window;
    try {
      await window.loadFile(path.join(app.getAppPath(), toastPageRelativePath));
    } catch (error) {
      window.destroy();
      throw error;
    }

    return window;
  }

  private async showToast(options: ToastOptions): Promise<void> {
    const window = await this.loadedWindow();
    this.clearIdleTimeout();
    const id = this.nextId;
    this.nextId += 1;
    this.active = { id, onClick: options.onClick };
    const message: ToastMessage = {
      detail: options.detail,
      id,
      isClickable: options.onClick !== null,
      title: options.title,
      tone: options.tone
    };
    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    window.setBounds({
      height: toastWindowHeightPx,
      width: toastWindowWidthPx,
      x: workArea.x + workArea.width - toastWindowWidthPx,
      y: workArea.y
    });
    window.setIgnoreMouseEvents(true, { forward: message.isClickable });
    window.webContents.send(toastShowChannel, message);
    window.showInactive();
  }

  private activeToastFor(event: Electron.IpcMainInvokeEvent, toastId: unknown): ActiveToast | null {
    if (event.sender !== this.window?.webContents) {
      throw new Error("Only the Softshot toast can use toast controls.");
    }

    return this.active?.id === toastId ? this.active : null;
  }

  private hide(): void {
    this.active = null;
    this.window?.hide();
    this.clearIdleTimeout();
    this.idleTimeout = setTimeout((): void => {
      this.idleTimeout = null;
      this.window?.close();
    }, idleCloseDelayMs);
  }

  private clearIdleTimeout(): void {
    if (this.idleTimeout === null) {
      return;
    }

    clearTimeout(this.idleTimeout);
    this.idleTimeout = null;
  }

  bind(): void {
    ipcMain.handle("toast:clicked", (event, toastId: unknown): void => {
      const toast = this.activeToastFor(event, toastId);
      if (!toast?.onClick) {
        return;
      }

      this.hide();
      toast.onClick();
    });
    ipcMain.handle("toast:finished", (event, toastId: unknown): void => {
      if (this.activeToastFor(event, toastId)) {
        this.hide();
      }
    });
    ipcMain.handle("toast:set-pointer-inside", (event, toastId: unknown, isInside: unknown): void => {
      const toast = this.activeToastFor(event, toastId);
      if (toast?.onClick && typeof isInside === "boolean") {
        this.window?.setIgnoreMouseEvents(!isInside, { forward: true });
      }
    });
  }

  show(options: ToastOptions): void {
    void this.showToast(options).catch((error: unknown): void => {
      this.reportError(error);
    });
  }
}
