import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

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
  session,
  shell,
  Tray,
  webContents as electronWebContents
} from "electron";

import type {
  EditorBootstrap,
  OverlayBootstrap,
  PreparedVideoFile,
  RecordingFile,
  SaveDialogResult,
  SaveResult,
  VideoFps
} from "./shared";
import { hasWebmCluster, webmClusterSignatureLength } from "./webm";

const appName = "Softshot";
const primaryShortcut = "PrintScreen";
const backupShortcuts = ["Control+Shift+PrintScreen", "Control+Alt+S"] as const;
const overlayReadyTimeoutMs = 3000;
const captureOnReadyDelayMs = 300;
const timestampPartWidth = 2;
const pngDataUrlPrefix = "data:image/png;base64,";
const clipboardFileEnvironmentName = "SOFTSHOT_CLIPBOARD_FILE";
const clipboardFolderName = "clipboard";
const frozenCaptureFileEnvironmentName = "SOFTSHOT_FROZEN_CAPTURE_FILE";
const perMonitorDpiAwareV2 = -4;
const transparentWindowBackground = "#00000000";
const editorWindowWidthPx = 860;
const editorWindowHeightPx = 560;
const editorWindowMinWidthPx = 720;
const editorWindowMinHeightPx = 460;
const appLogoRelativePath = path.join("src", "assets", "app-logo.png");
const trayIconLogicalSizePx = 16;
const trayIconScaleFactor2x = 2;
const trayIconScaleFactor3x = 3;
const trayIconScaleFactors = [1, trayIconScaleFactor2x, trayIconScaleFactor3x] as const;
const powershellExecutable = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
const minimumRecordingByteLength = 1;
const webmScanChunkSizeBytes = 65_536;
const webmSignatureCarryByteLength = webmClusterSignatureLength - 1;

type CaptureFolder = "pictures" | "videos";
type CaptureExtension = "png" | "webm";
type RegisterShortcutResult = "registered" | "unavailable";

interface PendingOverlayBootstrap {
  promise: Promise<OverlayBootstrap>;
  reject(error: Error): void;
  resolve(data: OverlayBootstrap): void;
}

interface RecordingTemporaryFile {
  byteLength: number;
  filePath: string;
}

class SoftshotApp {
  private activeOverlay: BrowserWindow | null = null;

  private readonly editorDataByWebContents = new Map<number, EditorBootstrap>();

  private readonly editorSavePathsByWebContents = new Map<number, Set<string>>();

  private readonly editorTempFilesByWebContents = new Map<number, Set<string>>();

  private readonly displayMediaDisplayIdsByWebContents = new Map<number, number>();

  private isPrintScreenUnavailable = false;

  private isQuitting = false;

  private liveCaptureOverlayWebContentsId: number | null = null;

  private readonly overlayDataByWebContents = new Map<number, OverlayBootstrap>();

  private readonly overlayLoadPromisesByWebContents = new Map<number, Promise<void>>();

  private readonly pendingOverlayBootstrapsByWebContents = new Map<number, PendingOverlayBootstrap>();

  private preparedOverlay: BrowserWindow | null = null;

  private readonly recordingTempFilesById = new Map<string, RecordingTemporaryFile>();

  private registeredShortcuts: string[] = [];

  private tray: Tray | null = null;

  private capture(): void {
    if (this.requestActiveOverlayStop()) {
      return;
    }

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

  private assertEditorSavePath(webContentsId: number, filePath: string): void {
    if (this.editorSavePathsByWebContents.get(webContentsId)?.has(filePath)) {
      return;
    }

    throw new Error("The save path was not selected by this editor.");
  }

  private assertEditorTempFile(webContentsId: number, filePath: string): void {
    if (this.editorTempFilesByWebContents.get(webContentsId)?.has(filePath)) {
      return;
    }

    throw new Error("The prepared recording file does not belong to this editor.");
  }

  private registerEditorSavePath(webContentsId: number, filePath: string): void {
    const savePaths = this.editorSavePathsByWebContents.get(webContentsId) ?? new Set<string>();
    savePaths.add(filePath);
    this.editorSavePathsByWebContents.set(webContentsId, savePaths);
  }

  private registerEditorTempFile(webContentsId: number, filePath: string): void {
    const temporaryFiles = this.editorTempFilesByWebContents.get(webContentsId) ?? new Set<string>();
    temporaryFiles.add(filePath);
    this.editorTempFilesByWebContents.set(webContentsId, temporaryFiles);
  }

  private async appendRecordingFileChunk(recordingId: string, bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength === 0) {
      throw new Error("Cannot append an empty recording chunk.");
    }

    const recordingFile = this.getRecordingTempFile(recordingId);
    await appendFile(recordingFile.filePath, Buffer.from(bytes));
    recordingFile.byteLength += bytes.byteLength;
  }

  private async createRecordingFile(): Promise<RecordingFile> {
    const id = randomUUID();
    const filePath = await this.createTemporaryVideoFilePath();
    await writeFile(filePath, "");
    this.recordingTempFilesById.set(id, {
      byteLength: 0,
      filePath
    });
    return { id };
  }

  private async discardRecordingFile(recordingId: string): Promise<void> {
    const recordingFile = this.takeRecordingTempFile(recordingId);
    await rm(recordingFile.filePath, { force: true });
  }

  private async fileHasWebmCluster(filePath: string): Promise<boolean> {
    let carry: Uint8Array = new Uint8Array();
    const stream = createReadStream(filePath, { highWaterMark: webmScanChunkSizeBytes });

    for await (const chunk of stream as AsyncIterable<Buffer>) {
      const scanBytes = joinedBytes(carry, chunk);
      if (hasWebmCluster(scanBytes)) {
        return true;
      }

      carry = trailingBytes(scanBytes, webmSignatureCarryByteLength);
    }

    return false;
  }

  private getRecordingTempFile(recordingId: string): RecordingTemporaryFile {
    const recordingFile = this.recordingTempFilesById.get(recordingId);
    if (!recordingFile) {
      throw new Error("The recording file does not belong to this capture session.");
    }

    return recordingFile;
  }

  private async hasUsableRecordingFile(recordingFile: RecordingTemporaryFile): Promise<boolean> {
    return recordingFile.byteLength >= minimumRecordingByteLength && await this.fileHasWebmCluster(recordingFile.filePath);
  }

  private takeRecordingTempFile(recordingId: string): RecordingTemporaryFile {
    const recordingFile = this.getRecordingTempFile(recordingId);
    this.recordingTempFilesById.delete(recordingId);
    return recordingFile;
  }

  private createOverlayWindow(display: Display): BrowserWindow {
    return new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreen: true,
      fullscreenable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      backgroundColor: transparentWindowBackground,
      hasShadow: false,
      transparent: true,
      webPreferences: {
        preload: path.join(app.getAppPath(), "dist", "preload.js"),
        backgroundThrottling: false,
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
      icon: this.appLogoPath(),
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
    const logoPath = this.appLogoPath();
    const sourceImage = nativeImage.createFromPath(logoPath);
    if (sourceImage.isEmpty()) {
      throw new Error(`Could not load app logo from ${logoPath}.`);
    }

    const trayImage = nativeImage.createEmpty();
    for (const scaleFactor of trayIconScaleFactors) {
      const size = trayIconLogicalSizePx * scaleFactor;
      const representation = sourceImage.resize({ height: size, quality: "best", width: size });
      trayImage.addRepresentation({ dataURL: representation.toDataURL(), scaleFactor });
    }

    if (trayImage.isEmpty()) {
      throw new Error(`Could not create tray icon from ${logoPath}.`);
    }

    trayImage.setTemplateImage(false);
    return trayImage;
  }

  private appLogoPath(): string {
    return path.join(app.getAppPath(), appLogoRelativePath);
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
    displayId: number
  ): Promise<Electron.DesktopCapturerSource> {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      fetchWindowIcons: false,
      thumbnailSize: {
        height: 0,
        width: 0
      }
    });

    const source = sources.find((candidate) => candidate.display_id === String(displayId));
    if (source) {
      return source;
    }

    if (sources.length === 1) {
      return sources[0];
    }

    const availableIds = sources.map((candidate) => candidate.display_id || "(empty)").join(", ");
    throw new Error(`Could not match display ${String(displayId)} to a screen source. Available display ids: ${availableIds}.`);
  }

  private async captureFrozenScreenDataUrl(): Promise<string> {
    const targetDirectory = path.join(app.getPath("temp"), appName);
    await mkdir(targetDirectory, { recursive: true });

    const filePath = path.join(targetDirectory, `${appName} frozen ${randomUUID()}.png`);
    try {
      await captureScreenWithoutCursor(filePath);
      const data = await readFile(filePath);
      return `${pngDataUrlPrefix}${data.toString("base64")}`;
    } finally {
      await rm(filePath, { force: true });
    }
  }

  private getDisplayMediaDisplayId(request: Electron.DisplayMediaRequestHandlerHandlerRequest): number {
    if (!request.videoRequested) {
      throw new Error("Softshot display capture requires a video stream.");
    }

    if (!request.frame) {
      throw new Error("Softshot could not identify the display capture frame.");
    }

    const requestWebContents = electronWebContents.fromFrame(request.frame);
    if (!requestWebContents) {
      throw new Error("Softshot could not identify the display capture window.");
    }

    const displayId = this.displayMediaDisplayIdsByWebContents.get(requestWebContents.id);
    if (typeof displayId !== "number") {
      throw new TypeError("Softshot received an unexpected display capture request.");
    }

    return displayId;
  }

  private async handleDisplayMediaRequest(
    request: Electron.DisplayMediaRequestHandlerHandlerRequest,
    callback: (streams: Electron.Streams) => void
  ): Promise<void> {
    try {
      const displayId = this.getDisplayMediaDisplayId(request);
      const source = await this.getDesktopSourceForDisplay(displayId);
      callback({ video: source });
    } catch (error) {
      this.debugLog(`display media request failed: ${errorMessage(error)}`);
      callback({});
    }
  }

  private getOverlayData(event: Electron.IpcMainInvokeEvent): OverlayBootstrap | Promise<OverlayBootstrap> {
    const data = this.overlayDataByWebContents.get(event.sender.id);
    if (data) {
      return data;
    }

    return this.waitForOverlayBootstrap(event.sender.id);
  }

  private getSenderOverlay(event: Electron.IpcMainInvokeEvent): BrowserWindow {
    const overlay = BrowserWindow.fromWebContents(event.sender);
    if (!overlay || overlay.isDestroyed()) {
      throw new Error("Missing overlay window.");
    }

    if (this.activeOverlay !== overlay) {
      throw new Error("Only the active capture overlay can change live capture state.");
    }

    return overlay;
  }

  private handleOverlayReadinessTimeout(overlay: BrowserWindow): void {
    if (overlay.isDestroyed() || overlay.isVisible()) {
      return;
    }

    this.debugLog("overlay readiness timed out");
    overlay.close();
    void this.showError("Could not open the capture overlay.", new Error("The overlay did not become ready in time."));
  }

  private loadOverlayWindow(overlay: BrowserWindow): void {
    const overlayWebContentsId = overlay.webContents.id;
    const loadPromise = this.loadOverlayWindowFile(overlay);
    this.overlayLoadPromisesByWebContents.set(overlayWebContentsId, loadPromise);
    void loadPromise.catch((error: unknown): void => {
      this.debugLog(`prepared overlay load failed: ${errorMessage(error)}`);
      if (this.preparedOverlay === overlay) {
        this.preparedOverlay = null;
      }

      if (!overlay.isDestroyed()) {
        overlay.close();
      }
    });
  }

  private async loadOverlayWindowFile(overlay: BrowserWindow): Promise<void> {
    await overlay.loadFile(path.join(app.getAppPath(), "src", "overlay.html"));
    this.debugLog("overlay html loaded");
  }

  private prepareNextOverlay(): void {
    if (this.isQuitting || this.activeOverlay || this.preparedOverlay) {
      return;
    }

    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const overlay = this.createOverlayWindow(display);
    this.preparedOverlay = overlay;
    this.trackOverlayWindow(overlay);
    this.wireOverlayDiagnostics(overlay);
    this.loadOverlayWindow(overlay);
  }

  private provideOverlayBootstrap(webContentsId: number, data: OverlayBootstrap): void {
    this.overlayDataByWebContents.set(webContentsId, data);
    const pendingBootstrap = this.pendingOverlayBootstrapsByWebContents.get(webContentsId);
    if (!pendingBootstrap) {
      return;
    }

    this.pendingOverlayBootstrapsByWebContents.delete(webContentsId);
    pendingBootstrap.resolve(data);
  }

  private async initializeWhenReady(): Promise<void> {
    try {
      await app.whenReady();
      app.setName(appName);
      this.registerDisplayMediaRequestHandler();
      this.registerIpcHandlers();
      this.registerCaptureShortcuts();
      this.tray = this.createTray();
      await this.showShortcutWarningIfNeeded();
      this.prepareNextOverlay();

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

  private requestActiveOverlayStop(): boolean {
    const overlay = this.activeOverlay;
    if (!overlay || overlay.isDestroyed() || overlay.webContents.id !== this.liveCaptureOverlayWebContentsId) {
      return false;
    }

    this.debugLog("forwarding capture request to live overlay");
    overlay.webContents.send("overlay:stop-recording");
    return true;
  }

  private setLiveCaptureMouseMode(overlay: BrowserWindow, isPassthrough: boolean): void {
    if (isPassthrough) {
      overlay.setIgnoreMouseEvents(true, { forward: true });
      overlay.setFocusable(false);
      overlay.blur();
      return;
    }

    overlay.setIgnoreMouseEvents(false);
    overlay.setFocusable(true);
    overlay.focus();
  }

  private setLiveCaptureMousePassthrough(event: Electron.IpcMainInvokeEvent, isPassthrough: boolean): void {
    if (typeof isPassthrough !== "boolean") {
      throw new TypeError("Live capture mouse passthrough state must be a boolean.");
    }

    if (event.sender.id !== this.liveCaptureOverlayWebContentsId) {
      throw new Error("Only the live capture overlay can change mouse passthrough state.");
    }

    this.setLiveCaptureMouseMode(this.getSenderOverlay(event), isPassthrough);
  }

  private setLiveCaptureState(event: Electron.IpcMainInvokeEvent, isLive: boolean): void {
    if (typeof isLive !== "boolean") {
      throw new TypeError("Live capture state must be a boolean.");
    }

    if (isLive) {
      const overlay = this.getSenderOverlay(event);
      this.liveCaptureOverlayWebContentsId = event.sender.id;
      this.setLiveCaptureMouseMode(overlay, false);
      return;
    }

    const overlay = this.getSenderOverlay(event);
    this.setLiveCaptureMouseMode(overlay, false);

    if (this.liveCaptureOverlayWebContentsId === event.sender.id) {
      this.liveCaptureOverlayWebContentsId = null;
    }
  }

  private preparedOverlayForCapture(display: Display): BrowserWindow {
    if (!this.preparedOverlay || this.preparedOverlay.isDestroyed()) {
      this.prepareNextOverlay();
    }

    const overlay = this.preparedOverlay;
    if (!overlay || overlay.isDestroyed()) {
      throw new Error("Could not prepare the capture overlay.");
    }

    overlay.setFullScreen(false);
    overlay.setBounds(display.bounds);
    this.preparedOverlay = null;
    return overlay;
  }

  private rejectOverlayBootstrap(webContentsId: number, error: Error): void {
    const pendingBootstrap = this.pendingOverlayBootstrapsByWebContents.get(webContentsId);
    if (!pendingBootstrap) {
      return;
    }

    this.pendingOverlayBootstrapsByWebContents.delete(webContentsId);
    pendingBootstrap.reject(error);
  }

  private trackOverlayWindow(overlay: BrowserWindow): void {
    const overlayWebContentsId = overlay.webContents.id;
    overlay.on("closed", (): void => {
      this.debugLog("overlay closed");
      this.overlayDataByWebContents.delete(overlayWebContentsId);
      this.displayMediaDisplayIdsByWebContents.delete(overlayWebContentsId);
      this.overlayLoadPromisesByWebContents.delete(overlayWebContentsId);
      this.rejectOverlayBootstrap(overlayWebContentsId, new Error("The overlay closed before capture started."));

      if (this.liveCaptureOverlayWebContentsId === overlayWebContentsId) {
        this.liveCaptureOverlayWebContentsId = null;
      }

      if (this.activeOverlay === overlay) {
        this.activeOverlay = null;
      }

      if (this.preparedOverlay === overlay) {
        this.preparedOverlay = null;
      }

      this.prepareNextOverlay();
    });
  }

  private async waitForOverlayBootstrap(webContentsId: number): Promise<OverlayBootstrap> {
    const pendingBootstrap = this.pendingOverlayBootstrapsByWebContents.get(webContentsId);
    if (pendingBootstrap) {
      return await pendingBootstrap.promise;
    }

    const {
      promise,
      reject: rejectBootstrap,
      resolve: resolveBootstrap
    } = Promise.withResolvers<OverlayBootstrap>();
    this.pendingOverlayBootstrapsByWebContents.set(webContentsId, {
      promise,
      reject: rejectBootstrap,
      resolve: resolveBootstrap
    });
    return await promise;
  }

  private async chooseEditorVideoSavePath(event: Electron.IpcMainInvokeEvent): Promise<SaveDialogResult> {
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

    this.registerEditorSavePath(event.sender.id, result.filePath);
    return { filePath: result.filePath };
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
    const imageDataUrl = await this.captureFrozenScreenDataUrl();
    const overlay = this.preparedOverlayForCapture(display);
    overlay.setFullScreen(true);
    overlay.setAlwaysOnTop(true, "screen-saver");
    overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    overlay.setContentProtection(true);

    this.activeOverlay = overlay;
    const overlayWebContentsId = overlay.webContents.id;
    const readinessTimeout = setTimeout((): void => {
      this.handleOverlayReadinessTimeout(overlay);
    }, overlayReadyTimeoutMs);

    overlay.once("show", (): void => {
      clearTimeout(readinessTimeout);
    });
    overlay.once("closed", (): void => {
      clearTimeout(readinessTimeout);
    });

    this.provideOverlayBootstrap(overlayWebContentsId, {
      imageDataUrl,
      displayBounds: {
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height
      },
      scaleFactor: display.scaleFactor
    });
    this.displayMediaDisplayIdsByWebContents.set(overlayWebContentsId, display.id);
  }

  private async openOverlayWithErrorHandling(): Promise<void> {
    try {
      await this.openOverlay();
    } catch (error) {
      await this.showError("Could not open the capture overlay.", error);
    }
  }

  private showEditorWindow(editor: BrowserWindow): void {
    if (editor.isDestroyed()) {
      return;
    }

    if (!editor.isVisible()) {
      editor.show();
    }

    editor.focus();
  }

  private async openVideoEditor(
    event: Electron.IpcMainInvokeEvent,
    recordingId: string,
    fps: VideoFps,
    durationSeconds: number,
    mimeType: string
  ): Promise<void> {
    const recordingFile = this.takeRecordingTempFile(recordingId);
    let isRecordingFileOwnedByEditor = false;
    try {
      if (!await this.hasUsableRecordingFile(recordingFile)) {
        await rm(recordingFile.filePath, { force: true });
        this.closeSenderWindow(event);
        return;
      }

      const overlay = BrowserWindow.fromWebContents(event.sender);
      const editor = this.createEditorWindow();
      const editorWebContentsId = editor.webContents.id;
      this.editorDataByWebContents.set(editorWebContentsId, {
        durationSeconds,
        fps,
        mimeType,
        sourceFilePath: recordingFile.filePath,
        sourceUrl: pathToFileURL(recordingFile.filePath).toString()
      });
      this.registerEditorTempFile(editorWebContentsId, recordingFile.filePath);
      isRecordingFileOwnedByEditor = true;

      editor.once("ready-to-show", (): void => {
        this.showEditorWindow(editor);
      });

      editor.on("closed", (): void => {
        this.editorDataByWebContents.delete(editorWebContentsId);
        this.editorSavePathsByWebContents.delete(editorWebContentsId);
        void this.cleanupEditorTempFiles(editorWebContentsId).catch((error: unknown): void => {
          this.debugLog(`editor temp cleanup failed: ${errorMessage(error)}`);
        });
      });

      try {
        await editor.loadFile(path.join(app.getAppPath(), "src", "editor.html"));
        this.showEditorWindow(editor);
      } catch (error) {
        if (!editor.isDestroyed()) {
          editor.close();
        }

        throw error;
      }

      if (overlay && !overlay.isDestroyed()) {
        overlay.close();
      }
    } catch (error) {
      if (!isRecordingFileOwnedByEditor) {
        await rm(recordingFile.filePath, { force: true });
      }

      throw error;
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

  private registerDisplayMediaRequestHandler(): void {
    session.defaultSession.setDisplayMediaRequestHandler((request, callback): void => {
      void this.handleDisplayMediaRequest(request, callback);
    });
  }

  private registerIpcHandlers(): void {
    ipcMain.handle("overlay:get-bootstrap", (event): OverlayBootstrap | Promise<OverlayBootstrap> => this.getOverlayData(event));

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

    ipcMain.handle("overlay:set-live-capture", (event, isLive: boolean): void => {
      this.setLiveCaptureState(event, isLive);
    });

    ipcMain.handle("overlay:set-live-capture-mouse-passthrough", (event, isPassthrough: boolean): void => {
      this.setLiveCaptureMousePassthrough(event, isPassthrough);
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

    ipcMain.handle("recording:create-file", async (event): Promise<RecordingFile> => {
      this.getSenderOverlay(event);
      return await this.createRecordingFile();
    });

    ipcMain.handle("recording:append-file-chunk", async (event, recordingId: string, bytes: Uint8Array): Promise<void> => {
      this.getSenderOverlay(event);
      await this.appendRecordingFileChunk(recordingId, bytes);
    });

    ipcMain.handle("recording:discard-file", async (event, recordingId: string): Promise<void> => {
      this.getSenderOverlay(event);
      await this.discardRecordingFile(recordingId);
    });

    ipcMain.handle(
      "recording:open-editor",
      async (event, recordingId: string, fps: VideoFps, durationSeconds: number, mimeType: string): Promise<void> => {
        await this.openVideoEditor(event, recordingId, fps, durationSeconds, mimeType);
      }
    );

    ipcMain.handle("editor:get-bootstrap", (event): EditorBootstrap => {
      const data = this.editorDataByWebContents.get(event.sender.id);
      if (!data) {
        throw new Error("Missing editor recording data.");
      }

      return data;
    });

    ipcMain.handle("editor:choose-save-path", async (event): Promise<SaveDialogResult> => {
      return await this.chooseEditorVideoSavePath(event);
    });

    ipcMain.handle("editor:prepare-video-file", async (event, bytes: Uint8Array): Promise<PreparedVideoFile> => {
      if (bytes.byteLength === 0) {
        throw new Error("Cannot prepare an empty recording.");
      }

      return await this.prepareEditorVideoFile(event.sender.id, bytes);
    });

    ipcMain.handle("editor:save-prepared-video", async (event, preparedFilePath: string, targetFilePath: string): Promise<SaveResult> => {
      await this.savePreparedEditorVideo(event.sender.id, preparedFilePath, targetFilePath);
      return { filePath: targetFilePath };
    });

    ipcMain.handle("editor:copy-prepared-video", async (event, filePath: string): Promise<void> => {
      this.assertEditorTempFile(event.sender.id, filePath);
      await writeFileDropListToClipboard(filePath);
      const editor = BrowserWindow.fromWebContents(event.sender);
      if (editor && !editor.isDestroyed()) {
        editor.focus();
      }
    });

    ipcMain.handle("editor:close", (event): void => {
      this.closeSenderWindow(event);
    });
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

  private async cleanupEditorTempFiles(webContentsId: number): Promise<void> {
    const temporaryFiles = this.editorTempFilesByWebContents.get(webContentsId);
    this.editorTempFilesByWebContents.delete(webContentsId);
    if (!temporaryFiles) {
      return;
    }

    await Promise.all([...temporaryFiles].map(async (filePath): Promise<void> => {
      await rm(filePath, { force: true });
    }));
  }

  private async prepareEditorVideoFile(webContentsId: number, bytes: Uint8Array): Promise<PreparedVideoFile> {
    const filePath = await this.writeTemporaryVideoFile(Buffer.from(bytes));
    this.registerEditorTempFile(webContentsId, filePath);
    return { filePath };
  }

  private async savePreparedEditorVideo(webContentsId: number, preparedFilePath: string, targetFilePath: string): Promise<void> {
    this.assertEditorTempFile(webContentsId, preparedFilePath);
    this.assertEditorSavePath(webContentsId, targetFilePath);
    await mkdir(path.dirname(targetFilePath), { recursive: true });
    await copyFile(preparedFilePath, targetFilePath);
    this.editorSavePathsByWebContents.get(webContentsId)?.delete(targetFilePath);
    this.notifySaved("Recording saved", targetFilePath);
  }

  private async createTemporaryVideoFilePath(): Promise<string> {
    const targetDirectory = path.join(app.getPath("temp"), appName, clipboardFolderName);
    await mkdir(targetDirectory, { recursive: true });

    return path.join(targetDirectory, `${appName} ${this.timestamp()} ${randomUUID()}.webm`);
  }

  private async writeTemporaryVideoFile(data: Buffer): Promise<string> {
    const filePath = await this.createTemporaryVideoFilePath();
    await writeFile(filePath, data);
    return filePath;
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
      this.isQuitting = true;
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

function joinedBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(left.byteLength + right.byteLength);
  bytes.set(left);
  bytes.set(right, left.byteLength);
  return bytes;
}

function trailingBytes(bytes: Uint8Array, maxByteLength: number): Uint8Array {
  const start = Math.max(0, bytes.byteLength - maxByteLength);
  return bytes.slice(start);
}

async function writeFileDropListToClipboard(filePath: string): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("Copying a recording as a file is only supported on Windows.");
  }

  await runPowershellClipboardScript(filePath);
}

async function captureScreenWithoutCursor(filePath: string): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("Cursor-free frozen screenshots are only supported on Windows.");
  }

  await runPowershellFrozenCaptureScript(filePath);
}

async function runPowershellFrozenCaptureScript(filePath: string): Promise<void> {
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class SoftshotDpiAwareness {
  [DllImport("user32.dll")]
  public static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);
}
"@
$dpiContext = [IntPtr]::new(${String(perMonitorDpiAwareV2)})
if (-not [SoftshotDpiAwareness]::SetProcessDpiAwarenessContext($dpiContext)) {
  throw "Could not enable per-monitor DPI awareness for frozen screen capture."
}
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$out = [Environment]::GetEnvironmentVariable("${frozenCaptureFileEnvironmentName}")
if ([string]::IsNullOrWhiteSpace($out)) {
  throw "Missing ${frozenCaptureFileEnvironmentName}."
}
$screen = [System.Windows.Forms.Screen]::FromPoint([System.Windows.Forms.Cursor]::Position)
$bounds = $screen.Bounds
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $bitmap.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}
`;

  await new Promise<void>((resolve, reject) => {
    execFile(
      powershellExecutable,
      powershellArguments(script),
      {
        env: {
          ...process.env,
          [frozenCaptureFileEnvironmentName]: filePath
        },
        windowsHide: true
      },
      (error, standardOutput, standardError): void => {
        if (error) {
          reject(new Error(powershellFrozenCaptureErrorMessage(error, standardOutput, standardError)));
          return;
        }

        resolve();
      }
    );
  });
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
      powershellArguments(script),
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

function powershellArguments(script: string): string[] {
  return ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script];
}

function powershellFrozenCaptureErrorMessage(error: Error, standardOutput: string, standardError: string): string {
  const output = [standardError.trim(), standardOutput.trim()].filter(Boolean).join("\n");
  if (!output) {
    return `Could not capture the frozen screen without the cursor.\n${error.message}`;
  }

  return `Could not capture the frozen screen without the cursor.\n${output}`;
}

function powershellClipboardErrorMessage(error: Error, standardOutput: string, standardError: string): string {
  const output = [standardError.trim(), standardOutput.trim()].filter(Boolean).join("\n");
  if (!output) {
    return `Could not put the recording file on the clipboard.\n${error.message}`;
  }

  return `Could not put the recording file on the clipboard.\n${output}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const softshotApp = new SoftshotApp();
softshotApp.start();
