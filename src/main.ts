import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  Display,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  screen,
  shell,
  Tray
} from "electron";

import type { EditorBootstrap, OverlayBootstrap, SaveDialogResult, SaveResult, VideoFps } from "./shared";

const appName = "Softshot";
const primaryShortcut = "PrintScreen";
const backupShortcuts = ["Control+Shift+PrintScreen", "Control+Alt+S"] as const;
const overlayReadyTimeoutMs = 3000;
const captureOnReadyDelayMs = 300;
const timestampPartWidth = 2;
const pngDataUrlPrefix = "data:image/png;base64,";
const clipboardFileEnvironmentName = "SOFTSHOT_CLIPBOARD_FILE";
const clipboardFolderName = "clipboard";
const editorWindowWidthPx = 860;
const editorWindowHeightPx = 560;
const editorWindowMinWidthPx = 720;
const editorWindowMinHeightPx = 460;
const powershellExecutable = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;

type CaptureFolder = "pictures" | "videos";
type CaptureExtension = "png" | "webm";
type RegisterShortcutResult = "registered" | "unavailable";

class SoftshotApp {
  private activeOverlay: BrowserWindow | null = null;

  private readonly editorDataByWebContents = new Map<number, EditorBootstrap>();

  private isPrintScreenUnavailable = false;

  private readonly overlayDataByWebContents = new Map<number, OverlayBootstrap>();

  private registeredShortcuts: string[] = [];

  private tray: Tray | null = null;

  private capture(): void {
    this.debugLog("capture requested");
    void this.openOverlayWithErrorHandling();
  }

  private closeSenderWindow(event: Electron.IpcMainInvokeEvent): void {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) {
      return;
    }

    window.close();
  }

  private createOverlayWindow(display: Display): BrowserWindow {
    return new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      resizable: true,
      movable: false,
      minimizable: false,
      maximizable: true,
      fullscreen: true,
      fullscreenable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      backgroundColor: "#050506",
      webPreferences: {
        preload: path.join(app.getAppPath(), "dist", "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });
  }

  private createEditorWindow(): BrowserWindow {
    return new BrowserWindow({
      width: editorWindowWidthPx,
      height: editorWindowHeightPx,
      minWidth: editorWindowMinWidthPx,
      minHeight: editorWindowMinHeightPx,
      frame: false,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: "#15171a",
      title: "Softshot Editor",
      webPreferences: {
        preload: path.join(app.getAppPath(), "dist", "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });
  }

  private createTray(): Tray {
    const currentTray = new Tray(this.createTrayImage());
    currentTray.setToolTip(`${appName} - ${this.currentShortcutLabel()}`);
    currentTray.setContextMenu(Menu.buildFromTemplate(this.trayMenuTemplate()));
    return currentTray;
  }

  private createTrayImage(): Electron.NativeImage {
    const svg = encodeURIComponent(`
      <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
        <rect x="4" y="7" width="24" height="18" rx="5" fill="#111827"/>
        <path d="M11 7l2-3h6l2 3" fill="#111827"/>
        <rect x="8" y="11" width="16" height="10" rx="3" fill="#38bdf8"/>
        <circle cx="16" cy="16" r="4" fill="#0f172a"/>
      </svg>
    `);

    const image = nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${svg}`);
    image.setTemplateImage(false);
    return image;
  }

  private currentShortcutLabel(): string {
    return this.registeredShortcuts.length > 0 ? this.registeredShortcuts.join(" or ") : "tray capture";
  }

  private debugLog(message: string): void {
    if (process.env.SOFTSHOT_DEBUG !== "1") {
      return;
    }

    process.stdout.write(`[softshot] ${message}\n`);
  }

  private async getDesktopSourceForDisplay(
    displayId: number,
    width: number,
    height: number,
    scaleFactor: number
  ): Promise<Electron.DesktopCapturerSource> {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      fetchWindowIcons: false,
      thumbnailSize: {
        width: Math.round(width * scaleFactor),
        height: Math.round(height * scaleFactor)
      }
    });

    const source = sources.find((candidate) => candidate.display_id === String(displayId));
    if (source) {
      return this.requireUsableThumbnail(source);
    }

    if (sources.length === 1) {
      return this.requireUsableThumbnail(sources[0]);
    }

    const availableIds = sources.map((candidate) => candidate.display_id || "(empty)").join(", ");
    throw new Error(`Could not match display ${String(displayId)} to a screen source. Available display ids: ${availableIds}.`);
  }

  private getOverlayData(event: Electron.IpcMainInvokeEvent): OverlayBootstrap {
    const data = this.overlayDataByWebContents.get(event.sender.id);
    if (!data) {
      throw new Error("Missing overlay bootstrap data.");
    }

    return data;
  }

  private handleOverlayReadinessTimeout(overlay: BrowserWindow): void {
    if (overlay.isDestroyed() || overlay.isVisible()) {
      return;
    }

    this.debugLog("overlay readiness timed out");
    overlay.close();
    void this.showError("Could not open the capture overlay.", new Error("The overlay did not become ready in time."));
  }

  private async initializeWhenReady(): Promise<void> {
    try {
      await app.whenReady();
      app.setName(appName);
      this.registerIpcHandlers();
      this.registerCaptureShortcuts();
      this.tray = this.createTray();
      await this.showShortcutWarningIfNeeded();

      if (process.env.SOFTSHOT_CAPTURE_ON_READY === "1") {
        setTimeout((): void => {
          this.capture();
        }, captureOnReadyDelayMs);
      }
    } catch (error) {
      await this.showError("Softshot could not start.", error);
    }
  }

  private notifySaved(title: string, filePath: string): void {
    if (!Notification.isSupported()) {
      return;
    }

    new Notification({
      title,
      body: filePath
    }).show();
  }

  private async openKeyboardSettings(): Promise<void> {
    try {
      await shell.openExternal("ms-settings:easeofaccess-keyboard");
    } catch (error) {
      await this.showError("Could not open Windows keyboard settings.", error);
    }
  }

  private async openOverlay(): Promise<void> {
    if (this.activeOverlay && !this.activeOverlay.isDestroyed()) {
      this.debugLog("focusing existing overlay");
      this.activeOverlay.focus();
      return;
    }

    this.debugLog("creating overlay");
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const source = await this.getDesktopSourceForDisplay(
      display.id,
      display.bounds.width,
      display.bounds.height,
      display.scaleFactor
    );
    const imageDataUrl = source.thumbnail.toDataURL();
    const thumbnailSize = source.thumbnail.getSize();
    this.debugLog(`captured thumbnail ${String(thumbnailSize.width)}x${String(thumbnailSize.height)}`);

    const overlay = this.createOverlayWindow(display);
    overlay.setFullScreen(true);
    overlay.setAlwaysOnTop(true, "screen-saver");
    overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    overlay.setContentProtection(true);
    this.wireOverlayDiagnostics(overlay);

    this.activeOverlay = overlay;
    const overlayWebContentsId = overlay.webContents.id;
    const readinessTimeout = setTimeout((): void => {
      this.handleOverlayReadinessTimeout(overlay);
    }, overlayReadyTimeoutMs);

    overlay.once("show", (): void => {
      clearTimeout(readinessTimeout);
    });

    this.overlayDataByWebContents.set(overlayWebContentsId, {
      sourceId: source.id,
      imageDataUrl,
      displayBounds: {
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height
      },
      scaleFactor: display.scaleFactor
    });

    overlay.on("closed", (): void => {
      clearTimeout(readinessTimeout);
      this.debugLog("overlay closed");
      this.overlayDataByWebContents.delete(overlayWebContentsId);
      if (this.activeOverlay === overlay) {
        this.activeOverlay = null;
      }
    });

    await overlay.loadFile(path.join(app.getAppPath(), "src", "overlay.html"));
    this.debugLog("overlay html loaded");
  }

  private async openOverlayWithErrorHandling(): Promise<void> {
    try {
      await this.openOverlay();
    } catch (error) {
      await this.showError("Could not open the capture overlay.", error);
    }
  }

  private async openVideoEditor(
    event: Electron.IpcMainInvokeEvent,
    bytes: Uint8Array,
    fps: VideoFps,
    durationSeconds: number,
    mimeType: string
  ): Promise<void> {
    if (bytes.byteLength === 0) {
      this.closeSenderWindow(event);
      return;
    }

    const overlay = BrowserWindow.fromWebContents(event.sender);
    const editor = this.createEditorWindow();
    const editorWebContentsId = editor.webContents.id;
    this.editorDataByWebContents.set(editorWebContentsId, {
      bytes,
      durationSeconds,
      fps,
      mimeType
    });

    editor.once("ready-to-show", (): void => {
      if (editor.isDestroyed()) {
        return;
      }

      editor.show();
      editor.focus();
    });

    editor.on("closed", (): void => {
      this.editorDataByWebContents.delete(editorWebContentsId);
    });

    await editor.loadFile(path.join(app.getAppPath(), "src", "editor.html"));

    if (overlay && !overlay.isDestroyed()) {
      overlay.close();
    }
  }

  private pngBufferFromDataUrl(dataUrl: string): Buffer {
    if (!dataUrl.startsWith(pngDataUrlPrefix)) {
      throw new Error("Screenshots must be PNG data URLs.");
    }

    return Buffer.from(dataUrl.slice(pngDataUrlPrefix.length), "base64");
  }

  private registerCaptureShortcut(shortcut: string): RegisterShortcutResult {
    const didRegisterShortcut = globalShortcut.register(shortcut, (): void => {
      this.capture();
    });

    return didRegisterShortcut ? "registered" : "unavailable";
  }

  private registerCaptureShortcuts(): void {
    if (this.registerCaptureShortcut(primaryShortcut) === "registered") {
      this.registeredShortcuts = [primaryShortcut];
      return;
    }

    this.isPrintScreenUnavailable = true;
    const shortcuts: string[] = [];
    for (const shortcut of backupShortcuts) {
      if (this.registerCaptureShortcut(shortcut) === "registered") {
        shortcuts.push(shortcut);
      }
    }

    this.registeredShortcuts = shortcuts;
  }

  private registerIpcHandlers(): void {
    ipcMain.handle("overlay:get-bootstrap", (event): OverlayBootstrap => this.getOverlayData(event));

    ipcMain.handle("overlay:close", (event): void => {
      this.closeSenderWindow(event);
    });

    ipcMain.handle("overlay:ready-to-show", (event): void => {
      const overlay = BrowserWindow.fromWebContents(event.sender);
      if (!overlay || overlay.isDestroyed()) {
        return;
      }

      this.debugLog("overlay ready to show");
      overlay.show();
      overlay.setFullScreen(true);
      overlay.setAlwaysOnTop(true, "screen-saver");
      overlay.focus();
    });

    ipcMain.handle("overlay:show-error", async (event, message: string): Promise<void> => {
      const parentWindow = BrowserWindow.fromWebContents(event.sender);
      const options: Electron.MessageBoxOptions = {
        message,
        title: appName,
        type: "error"
      };

      if (parentWindow && !parentWindow.isDestroyed()) {
        await dialog.showMessageBox(parentWindow, options);
        return;
      }

      await dialog.showMessageBox(options);
    });

    ipcMain.handle("capture:save-screenshot", async (event, dataUrl: string): Promise<SaveResult> => {
      const buffer = this.pngBufferFromDataUrl(dataUrl);
      const filePath = await this.writeCaptureFile("pictures", "png", buffer);
      clipboard.writeImage(nativeImage.createFromBuffer(buffer));
      this.notifySaved("Screenshot saved", filePath);
      this.closeSenderWindow(event);
      return { filePath };
    });

    ipcMain.handle("capture:copy-screenshot", (event, dataUrl: string): void => {
      const buffer = this.pngBufferFromDataUrl(dataUrl);
      clipboard.writeImage(nativeImage.createFromBuffer(buffer));
      this.closeSenderWindow(event);
    });

    ipcMain.handle(
      "recording:open-editor",
      async (event, bytes: Uint8Array, fps: VideoFps, durationSeconds: number, mimeType: string): Promise<void> => {
        await this.openVideoEditor(event, bytes, fps, durationSeconds, mimeType);
      }
    );

    ipcMain.handle("editor:get-bootstrap", (event): EditorBootstrap => {
      const data = this.editorDataByWebContents.get(event.sender.id);
      if (!data) {
        throw new Error("Missing editor recording data.");
      }

      return data;
    });

    ipcMain.handle("editor:save-video", async (event, bytes: Uint8Array): Promise<SaveDialogResult> => {
      if (bytes.byteLength === 0) {
        return { filePath: null };
      }

      const targetDirectory = path.join(app.getPath("videos"), appName);
      await mkdir(targetDirectory, { recursive: true });
      const parentWindow = BrowserWindow.fromWebContents(event.sender);
      const options: Electron.SaveDialogOptions = {
        defaultPath: path.join(targetDirectory, `${appName} ${this.timestamp()}.webm`),
        filters: [
          {
            name: "WebM video",
            extensions: ["webm"]
          }
        ],
        title: "Save recording"
      };
      const result = parentWindow && !parentWindow.isDestroyed()
        ? await dialog.showSaveDialog(parentWindow, options)
        : await dialog.showSaveDialog(options);

      if (result.canceled || !result.filePath) {
        return { filePath: null };
      }

      await writeFile(result.filePath, Buffer.from(bytes));
      this.notifySaved("Recording saved", result.filePath);
      return { filePath: result.filePath };
    });

    ipcMain.handle("editor:copy-video", async (event, bytes: Uint8Array): Promise<void> => {
      if (bytes.byteLength === 0) {
        return;
      }

      await this.copyVideoFileToClipboard(bytes);
      const editor = BrowserWindow.fromWebContents(event.sender);
      if (editor && !editor.isDestroyed()) {
        editor.focus();
      }
    });

    ipcMain.handle("editor:close", (event): void => {
      this.closeSenderWindow(event);
    });
  }

  private requireUsableThumbnail<TSource extends Electron.DesktopCapturerSource>(source: TSource): TSource {
    const size = source.thumbnail.getSize();
    if (source.thumbnail.isEmpty() || size.width <= 0 || size.height <= 0) {
      throw new Error(`Could not capture a frozen frame for ${source.name}.`);
    }

    return source;
  }

  private async showError(message: string, error?: unknown): Promise<void> {
    const options: Electron.MessageBoxOptions = {
      message,
      title: appName,
      type: "error"
    };

    if (error instanceof Error) {
      options.detail = error.message;
    }

    await dialog.showMessageBox(options);
  }

  private async showShortcutWarningIfNeeded(): Promise<void> {
    if (!this.isPrintScreenUnavailable || process.env.SOFTSHOT_SKIP_SHORTCUT_WARNING === "1") {
      return;
    }

    const fallbackText = this.registeredShortcuts.length > 0
      ? `Softshot is still running. Use ${this.registeredShortcuts.join(" or ")} for now, or use Capture from the tray menu.`
      : "Softshot is still running, but no keyboard shortcut could be registered. Use Capture from the tray menu.";

    const result = await dialog.showMessageBox({
      type: "warning",
      title: appName,
      message: `${appName} could not register the ${primaryShortcut} key.`,
      detail: `${fallbackText}\n\nTo let Softshot use PrintScreen, turn off Windows Settings > Accessibility > Keyboard > Use the Print screen key to open screen capture, close other screenshot apps, then restart Softshot.`,
      buttons: ["Open settings", "OK"],
      defaultId: 1,
      cancelId: 1
    });

    if (result.response === 0) {
      await this.openKeyboardSettings();
    }
  }

  private timestamp(): string {
    const value = new Date();
    const year = String(value.getFullYear());
    const month = padDatePart(value.getMonth() + 1);
    const day = padDatePart(value.getDate());
    const hours = padDatePart(value.getHours());
    const minutes = padDatePart(value.getMinutes());
    const seconds = padDatePart(value.getSeconds());
    return `${year}-${month}-${day} ${hours}.${minutes}.${seconds}`;
  }

  private trayMenuTemplate(): Electron.MenuItemConstructorOptions[] {
    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: "Capture",
        accelerator: this.registeredShortcuts[0],
        click: (): void => {
          this.capture();
        }
      }
    ];

    if (this.isPrintScreenUnavailable) {
      template.push(
        {
          label: `${primaryShortcut} unavailable`,
          enabled: false
        },
        {
          label: "Open keyboard settings",
          click: (): void => {
            void this.openKeyboardSettings();
          }
        }
      );
    }

    template.push(
      { type: "separator" },
      {
        label: "Quit",
        click: (): void => {
          app.quit();
        }
      }
    );

    return template;
  }

  private wireOverlayDiagnostics(overlay: BrowserWindow): void {
    if (process.env.SOFTSHOT_DEBUG !== "1") {
      return;
    }

    overlay.webContents.on("console-message", (event, level, message, line, sourceId): void => {
      this.debugLog(
        `renderer console level=${String(level)} ${sourceId}:${String(line)} ${message} observed=${String(event.defaultPrevented)}`
      );
    });

    overlay.webContents.on("did-fail-load", (event, errorCode, errorDescription, validatedUrl): void => {
      this.debugLog(
        `renderer did-fail-load code=${String(errorCode)} description=${errorDescription} url=${validatedUrl} observed=${String(event.defaultPrevented)}`
      );
    });

    overlay.webContents.on("render-process-gone", (event, details): void => {
      this.debugLog(`renderer gone reason=${details.reason} exitCode=${String(details.exitCode)} observed=${String(event.defaultPrevented)}`);
    });
  }

  private async writeCaptureFile(folderName: CaptureFolder, extension: CaptureExtension, data: Buffer): Promise<string> {
    const targetDirectory = path.join(app.getPath(folderName), appName);
    await mkdir(targetDirectory, { recursive: true });

    const filePath = path.join(targetDirectory, `${appName} ${this.timestamp()}.${extension}`);
    await writeFile(filePath, data);
    return filePath;
  }

  private async writeClipboardVideoFile(data: Buffer): Promise<string> {
    const targetDirectory = path.join(app.getPath("temp"), appName, clipboardFolderName);
    await mkdir(targetDirectory, { recursive: true });

    const filePath = path.join(targetDirectory, `${appName} ${this.timestamp()} ${randomUUID()}.webm`);
    await writeFile(filePath, data);
    return filePath;
  }

  private async copyVideoFileToClipboard(bytes: Uint8Array): Promise<void> {
    const filePath = await this.writeClipboardVideoFile(Buffer.from(bytes));
    await writeFileDropListToClipboard(filePath);
  }

  start(): void {
    if (!app.requestSingleInstanceLock()) {
      app.quit();
      return;
    }

    app.on("second-instance", (): void => {
      this.capture();
    });

    app.on("will-quit", (): void => {
      globalShortcut.unregisterAll();
    });

    app.on("window-all-closed", (): void => {
      this.debugLog("Kept tray app running after overlay closed.");
    });

    void this.initializeWhenReady();
  }
}

function padDatePart(part: number): string {
  return part.toString().padStart(timestampPartWidth, "0");
}

async function writeFileDropListToClipboard(filePath: string): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("Copying a recording as a file is only supported on Windows.");
  }

  await runPowershellClipboardScript(filePath);
}

async function runPowershellClipboardScript(filePath: string): Promise<void> {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$file = [Environment]::GetEnvironmentVariable("${clipboardFileEnvironmentName}")
if ([string]::IsNullOrWhiteSpace($file)) {
  throw "Missing ${clipboardFileEnvironmentName}."
}
$files = New-Object System.Collections.Specialized.StringCollection
[void] $files.Add($file)
[System.Windows.Forms.Clipboard]::SetFileDropList($files)
`;

  await new Promise<void>((resolve, reject) => {
    execFile(
      powershellExecutable,
      powershellClipboardArguments(script),
      {
        env: {
          ...process.env,
          [clipboardFileEnvironmentName]: filePath
        },
        windowsHide: true
      },
      (error, standardOutput, standardError): void => {
        if (error) {
          reject(new Error(powershellClipboardErrorMessage(error, standardOutput, standardError)));
          return;
        }

        resolve();
      }
    );
  });
}

function powershellClipboardArguments(script: string): string[] {
  return ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script];
}

function powershellClipboardErrorMessage(error: Error, standardOutput: string, standardError: string): string {
  const output = [standardError.trim(), standardOutput.trim()].filter(Boolean).join("\n");
  if (!output) {
    return `Could not put the recording file on the clipboard.\n${error.message}`;
  }

  return `Could not put the recording file on the clipboard.\n${output}`;
}

const softshotApp = new SoftshotApp();
softshotApp.start();
