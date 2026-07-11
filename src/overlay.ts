import {
  audioInputDevices,
  defaultDeviceId,
  displayMicrophoneLabel,
  microphoneConstraints,
  microphoneDeviceOptionValue,
  microphoneSelectionLabel,
  normalizeMicrophoneDeviceId
} from "./audio-devices.js";
import { audioAnalyzerFftSize, audioLevelFromTimeDomainSamples } from "./audio-level.js";
import { getCanvasContext, getRequiredElement, loadImage } from "./overlay-dom.js";
import { drawAnnotations, drawArrow, drawSelectionFrame } from "./overlay-drawing.js";
import type {
  Annotation,
  DragState,
  PenAnnotation,
  Point,
  VideoButtonState
} from "./overlay-model.js";
import {
  clampPointToRect,
  defaultCaptureMode,
  defaultDrawingTool,
  defaultPenColor,
  defaultVideoQuality,
  distance,
  eventPoint,
  isPointInRect,
  minimumArrowLengthPx,
  minimumSelectionSizePx,
  normalizeArrow,
  normalizeRect
} from "./overlay-model.js";
import { RecordingHudController } from "./recording-hud.js";
import { type RecordingResult, RecordingSession } from "./recording-session.js";
import type { AppSettings, AppSettingsUpdate, CaptureMode, OverlayBootstrap, Rect, VideoFps, VideoQuality } from "./shared.js";
import { videoFpsOptions } from "./shared.js";
import { getSoftshotApi } from "./softshot-api.js";
import { setTooltipLabel, TooltipController } from "./ui-tooltip.js";

const canvasContextError = "Could not create the overlay drawing context.";
const copyShortcutKey = "c";
const defaultDevicePixelRatio = 1;
const dimColor = "rgba(0, 0, 0, 0.44)";
const enterKey = "Enter";
const escapeKey = "Escape";
const frameScale = { x: 1, y: 1 };
const screenshotCanvasContextError = "Could not create the screenshot canvas.";
const screenshotCopyAction = "copy";
const screenshotSaveAction = "save";
const spaceKey = " ";
const toolbarPulseDurationMs = 160;
const undoShortcutKey = "z";
const videoButtonAnimationDurationMs = 220;
const zeroPoint = { x: 0, y: 0 };
const mediaDeviceChangeEventName = "devicechange";
const countdownFirstValue = 3;
const countdownSecondValue = 2;
const countdownThirdValue = 1;
const countdownCompleteValue = 0;
const countdownValues = [countdownFirstValue, countdownSecondValue, countdownThirdValue, countdownCompleteValue] as const;
const countdownStepMs = 1000;
const countdownZeroHoldMs = 500;
const liveCaptureClassName = "live-capture";
const runIdIncrement = 1;
const videoButtonPopKeyframes = [
  { transform: "scale(1)" },
  { transform: "scale(1.08)" },
  { transform: "scale(1)" }
] satisfies Keyframe[];

type RecordingSessionPreparation =
  | { kind: "failed"; error: unknown }
  | { kind: "ready"; session: RecordingSession };

class OverlayApp {
  private readonly arrowButton = getRequiredElement("arrow-button", HTMLButtonElement);
  private readonly canvas = getRequiredElement("annotation-canvas", HTMLCanvasElement);
  private readonly closeButton = getRequiredElement("close-button", HTMLButtonElement);
  private readonly colorButton = getRequiredElement("color-button", HTMLButtonElement);
  private readonly colorMenu = getRequiredElement("color-menu", HTMLDivElement);
  private readonly context = getCanvasContext(this.canvas, canvasContextError);
  private readonly microphoneButton = getRequiredElement("microphone-button", HTMLButtonElement);
  private readonly microphoneMenu = getRequiredElement("microphone-menu", HTMLDivElement);
  private readonly penButton = getRequiredElement("pen-button", HTMLButtonElement);
  private readonly recordingHud = new RecordingHudController();
  private readonly screenImage = getRequiredElement("screen-image", HTMLImageElement);
  private readonly screenshotButton = getRequiredElement("screenshot-button", HTMLButtonElement);
  private readonly screenshotMenu = getRequiredElement("screenshot-menu", HTMLDivElement);
  private readonly settingsButton = getRequiredElement("settings-button", HTMLButtonElement);
  private readonly settingsMenu = getRequiredElement("settings-menu", HTMLDivElement);
  private readonly systemAudioButton = getRequiredElement("system-audio-button", HTMLButtonElement);
  private readonly toolbar = getRequiredElement("capture-toolbar", HTMLDivElement);
  private readonly tooltips = new TooltipController(this.toolbar);
  private readonly videoButton = getRequiredElement("video-button", HTMLButtonElement);
  private readonly screenshotToolButtons: HTMLButtonElement[] = [this.penButton, this.arrowButton, this.colorButton];
  private readonly videoToolButtons: HTMLButtonElement[] = [this.microphoneButton, this.systemAudioButton];
  private activeTool = defaultDrawingTool;
  private annotations: Annotation[] = [];
  private bootstrap: OverlayBootstrap | null = null;
  private captureMode: CaptureMode = defaultCaptureMode;
  private countdownRunId = 0;
  private dragState: DragState = null;
  private fps: VideoFps = videoFpsOptions.high;
  private isCountingDown = false;
  private isLiveCapture = false;
  private isLiveCaptureMousePassthrough = false;
  private isRecording = false;
  private isRenderQueued = false;
  private microphoneAnalyser: AnalyserNode | null = null;
  private microphoneAudioContext: AudioContext | null = null;
  private microphoneDeviceId: string | null = null;
  private microphoneDevices: MediaDeviceInfo[] = [];
  private microphoneLevelData: Uint8Array<ArrayBuffer> | null = null;
  private microphoneLevelFrame: number | null = null;
  private microphoneMonitorStream: MediaStream | null = null;
  private microphoneSource: MediaStreamAudioSourceNode | null = null;
  private quality: VideoQuality = defaultVideoQuality;
  private recordingSession: RecordingSession | null = null;
  private removeStopRecordingRequestHandler: (() => void) | null = null;
  private selectedColor = defaultPenColor;
  private selection: Rect | null = null;
  private systemAudioEnabled = true;

  private async reportAsyncError(task: Promise<void>, message: string): Promise<void> {
    try {
      await task;
    } catch (error) {
      await this.reportError(message, error);
    }
  }

  private runAsync(task: Promise<void>, message: string): void {
    void this.reportAsyncError(task, message);
  }

  private bindEvents(): void {
    addEventListener("resize", (): void => {
      this.resizeCanvas();
      this.recordingHud.refresh();
      this.requestRender();
    });
    this.bindPointerEvents();
    this.bindKeyboardEvents();
    this.bindToolbarEvents();
    this.bindMenuEvents();
    this.bindLiveCaptureEvents();
    this.bindMainEvents();
    navigator.mediaDevices.addEventListener(mediaDeviceChangeEventName, (): void => {
      this.runAsync(this.refreshMicrophoneDevices(), "Could not refresh microphone devices.");
    });
  }

  private bindKeyboardEvents(): void {
    addEventListener("keydown", (event): void => {
      if (event.key === escapeKey) {
        this.runAsync(this.closeOverlay(), "Could not close the overlay.");
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === copyShortcutKey) {
        event.preventDefault();
        this.runAsync(this.copyScreenshot(), "Could not copy the screenshot.");
        return;
      }

      if (event.ctrlKey && event.key.toLowerCase() === undoShortcutKey) {
        event.preventDefault();
        this.undoLastAnnotation();
        return;
      }

      if (event.key === enterKey && this.captureMode === "screenshot") {
        this.runAsync(this.saveScreenshot(), "Could not save the screenshot.");
        return;
      }

      if (event.key === spaceKey && this.captureMode === "video") {
        event.preventDefault();
        this.runAsync(this.toggleRecording(), "Could not toggle recording.");
      }
    });
  }

  private bindLiveCaptureEvents(): void {
    addEventListener("mousemove", (event): void => {
      this.updateLiveCaptureMousePassthrough(event);
    });
  }

  private bindMainEvents(): void {
    this.removeStopRecordingRequestHandler = getSoftshotApi().onStopRecordingRequest((): void => {
      this.runAsync(this.handleStopRecordingRequest(), "Could not stop the recording.");
    });
  }

  private bindMenuEvents(): void {
    this.screenshotMenu.addEventListener("click", (event): void => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-screenshot-action]");
      if (!button) {
        return;
      }

      this.hideMenu(this.screenshotMenu);
      this.runScreenshotAction(button.dataset.screenshotAction);
    });

    this.colorMenu.addEventListener("click", (event): void => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-color]");
      if (!button) {
        return;
      }

      this.selectedColor = button.dataset.color ?? this.selectedColor;
      this.hideMenu(this.colorMenu);
      this.syncToolbar();
      this.requestRender();
    });

    this.microphoneMenu.addEventListener("click", (event): void => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-microphone-id]");
      if (!button || this.isRecording || this.isCountingDown) {
        return;
      }

      const deviceId = normalizeMicrophoneDeviceId(button.dataset.microphoneId ?? microphoneDeviceOptionValue(null));
      this.runAsync(this.setMicrophoneDevice(deviceId), "Could not update the microphone.");
    });

    this.settingsMenu.addEventListener("click", (event): void => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-quality], [data-fps]");
      if (!button || this.isRecording || this.isCountingDown) {
        return;
      }

      this.updateRecordingSetting(button);
      this.syncToolbar();
    });

    addEventListener("pointerdown", (event): void => {
      if (!(event.target as HTMLElement).closest(".toolbar")) {
        this.closeMenus();
      }
    });
  }

  private bindPointerEvents(): void {
    addEventListener("pointerdown", (event): void => {
      this.onPointerDown(event);
    });
    addEventListener("pointermove", (event): void => {
      this.onPointerMove(event);
    });
    addEventListener("pointerup", (event): void => {
      this.onPointerUp(event);
    });
    addEventListener("pointercancel", (): void => {
      this.cancelDrag();
    });
  }

  private bindToolbarEvents(): void {
    this.tooltips.bind();
    this.toolbar.addEventListener("pointerdown", (event): void => {
      event.stopPropagation();
    });
    this.screenshotButton.addEventListener("click", (): void => {
      this.onScreenshotButtonClick();
    });
    this.videoButton.addEventListener("click", (): void => {
      this.onVideoButtonClick();
    });
    this.penButton.addEventListener("click", (): void => {
      this.selectTool("pen");
    });
    this.arrowButton.addEventListener("click", (): void => {
      this.selectTool("arrow");
    });
    this.colorButton.addEventListener("click", (): void => {
      this.toggleMenu(this.colorMenu, [this.screenshotMenu, this.microphoneMenu, this.settingsMenu]);
    });
    this.microphoneButton.addEventListener("click", (): void => {
      if (this.captureMode !== "video") {
        return;
      }

      this.toggleMenu(this.microphoneMenu, [this.screenshotMenu, this.colorMenu, this.settingsMenu]);
    });
    this.systemAudioButton.addEventListener("click", (): void => {
      this.runAsync(this.toggleSystemAudio(), "Could not update desktop audio.");
    });
    this.settingsButton.addEventListener("click", (): void => {
      this.toggleMenu(this.settingsMenu, [this.screenshotMenu, this.colorMenu, this.microphoneMenu]);
    });
    this.closeButton.addEventListener("click", (): void => {
      this.runAsync(this.closeOverlay(), "Could not close the overlay.");
    });
  }

  private async cancelCountdown(): Promise<void> {
    this.countdownRunId += runIdIncrement;
    this.isCountingDown = false;
    this.recordingHud.clearCountdown();
    this.syncToolbar();
    this.requestRender();
    await this.exitLiveCapture();
    await this.syncMicrophoneMonitor();
  }

  private cancelDrag(): void {
    this.dragState = null;
    this.requestRender();
  }

  private closeMenus(): void {
    this.hideMenu(this.screenshotMenu);
    this.hideMenu(this.colorMenu);
    this.hideMenu(this.microphoneMenu);
    this.hideMenu(this.settingsMenu);
  }

  private hideMenu(menu: HTMLDivElement): void {
    if (menu.hidden || menu.classList.contains("closing")) {
      return;
    }

    menu.classList.add("closing");
    menu.addEventListener(
      "animationend",
      (): void => {
        if (!menu.classList.contains("closing")) {
          return;
        }

        menu.hidden = true;
        menu.classList.remove("closing");
      },
      { once: true }
    );
  }

  private showMenu(menu: HTMLDivElement): void {
    menu.classList.remove("closing");
    menu.hidden = false;
  }

  private toggleMenu(menu: HTMLDivElement, otherMenus: HTMLDivElement[]): void {
    const shouldShowMenu = menu.hidden || menu.classList.contains("closing");
    for (const otherMenu of otherMenus) {
      this.hideMenu(otherMenu);
    }

    if (shouldShowMenu) {
      this.showMenu(menu);
      return;
    }

    this.hideMenu(menu);
  }

  private showScreenshotMenu(): void {
    for (const menu of [this.colorMenu, this.microphoneMenu, this.settingsMenu]) {
      this.hideMenu(menu);
    }

    this.showMenu(this.screenshotMenu);
  }

  private async closeOverlay(): Promise<void> {
    if (this.isCountingDown) {
      await this.cancelCountdown();
    }

    if (this.isRecording) {
      await this.stopRecording();
      return;
    }

    this.unbindMainEvents();
    this.stopMicrophoneMonitor();
    await this.exitLiveCapture();
    await getSoftshotApi().closeOverlay();
  }

  private async applyAppSettings(settings: AppSettings): Promise<void> {
    const previousMicrophoneDeviceId = this.microphoneDeviceId;
    this.microphoneDeviceId = settings.microphoneDeviceId;
    this.systemAudioEnabled = settings.systemAudioEnabled;
    this.syncToolbar();

    if (previousMicrophoneDeviceId !== this.microphoneDeviceId) {
      await this.syncMicrophoneMonitor();
    }
  }

  private microphoneChoiceButton(label: string, deviceId: string | null): HTMLButtonElement {
    const button = document.createElement("button");
    button.className = "menu-choice";
    button.type = "button";
    button.dataset.microphoneId = microphoneDeviceOptionValue(deviceId);
    button.textContent = label;
    button.classList.toggle("selected", this.microphoneDeviceId === deviceId);
    return button;
  }

  private renderMicrophoneMenu(): void {
    const buttons = [
      this.microphoneChoiceButton("Off", null),
      this.microphoneChoiceButton("Default", defaultDeviceId),
      ...this.microphoneDevices.map((device, index) =>
        this.microphoneChoiceButton(displayMicrophoneLabel(device, index), device.deviceId)
      )
    ];
    this.microphoneMenu.replaceChildren(...buttons);
  }

  private async refreshMicrophoneDevices(): Promise<void> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    this.microphoneDevices = audioInputDevices(devices);
    this.renderMicrophoneMenu();
    this.syncAudioButtons(this.captureMode === "video");
  }

  private async setMicrophoneDevice(deviceId: string | null): Promise<void> {
    this.hideMenu(this.microphoneMenu);
    await this.updateAppSettings({ microphoneDeviceId: deviceId });
  }

  private setMicrophoneLevel(level: number): void {
    this.microphoneButton.style.setProperty("--meter-level", String(level));
  }

  private startMicrophoneLevelLoop(): void {
    if (!this.microphoneAnalyser || !this.microphoneLevelData) {
      return;
    }

    this.microphoneAnalyser.getByteTimeDomainData(this.microphoneLevelData);
    this.setMicrophoneLevel(audioLevelFromTimeDomainSamples(this.microphoneLevelData));
    this.microphoneLevelFrame = requestAnimationFrame((): void => {
      this.startMicrophoneLevelLoop();
    });
  }

  private async startMicrophoneMonitor(): Promise<void> {
    const deviceId = this.microphoneDeviceId;
    if (deviceId === null || !this.shouldMonitorMicrophone()) {
      this.setMicrophoneLevel(0);
      return;
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: microphoneConstraints(deviceId),
      video: false
    });
    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = audioAnalyzerFftSize;
    this.microphoneSource = audioContext.createMediaStreamSource(stream);
    this.microphoneSource.connect(analyser);
    this.microphoneMonitorStream = stream;
    this.microphoneAudioContext = audioContext;
    this.microphoneAnalyser = analyser;
    this.microphoneLevelData = new Uint8Array(analyser.fftSize);
    this.startMicrophoneLevelLoop();
    await this.refreshMicrophoneDevices();
  }

  private stopMicrophoneMonitor(): void {
    if (this.microphoneLevelFrame !== null) {
      cancelAnimationFrame(this.microphoneLevelFrame);
      this.microphoneLevelFrame = null;
    }

    stopMicrophoneResources(this.microphoneMonitorStream, this.microphoneAudioContext);
    this.microphoneMonitorStream = null;
    this.microphoneAudioContext = null;
    this.microphoneAnalyser = null;
    this.microphoneLevelData = null;
    this.microphoneSource = null;
    this.setMicrophoneLevel(0);
  }

  private async syncMicrophoneMonitor(): Promise<void> {
    this.stopMicrophoneMonitor();
    if (!this.shouldMonitorMicrophone()) {
      return;
    }

    try {
      await this.startMicrophoneMonitor();
    } catch (error) {
      await this.reportError("Could not start microphone monitoring.", error);
    }
  }

  private async toggleSystemAudio(): Promise<void> {
    if (this.captureMode !== "video" || this.isRecording || this.isCountingDown) {
      return;
    }

    await this.updateAppSettings({ systemAudioEnabled: !this.systemAudioEnabled });
  }

  private async updateAppSettings(update: AppSettingsUpdate): Promise<void> {
    const settings = await getSoftshotApi().updateSettings(update);
    await this.applyAppSettings(settings);
  }

  private async copyScreenshot(): Promise<void> {
    const dataUrl = this.renderSelectionDataUrl();
    if (!dataUrl) {
      return;
    }

    await getSoftshotApi().copyScreenshot(dataUrl);
  }

  private drawCurrentArrow(): void {
    if (this.dragState?.kind !== "arrow") {
      return;
    }

    drawArrow(this.context, {
      color: this.selectedColor,
      from: this.dragState.start,
      kind: "arrow",
      to: this.dragState.current
    });
  }

  private enterVideoMode(): void {
    this.closeMenus();
    this.captureMode = "video";
    this.activeTool = "select";
    this.syncToolbar();
    this.runAsync(this.refreshMicrophoneDevices(), "Could not refresh microphone devices.");
    this.runAsync(this.syncMicrophoneMonitor(), "Could not update microphone monitoring.");
  }

  private async enterLiveCapture(): Promise<void> {
    if (this.isLiveCapture) {
      return;
    }

    this.isLiveCapture = true;
    this.dragState = null;
    document.documentElement.classList.add(liveCaptureClassName);
    this.requestRender();

    try {
      await getSoftshotApi().setLiveCapture(true);
      this.isLiveCaptureMousePassthrough = false;
    } catch (error) {
      this.isLiveCapture = false;
      this.isLiveCaptureMousePassthrough = false;
      document.documentElement.classList.remove(liveCaptureClassName);
      this.requestRender();
      throw error;
    }
  }

  private async exitLiveCapture(): Promise<void> {
    if (!this.isLiveCapture) {
      return;
    }

    this.isLiveCapture = false;
    this.isLiveCaptureMousePassthrough = false;
    document.documentElement.classList.remove(liveCaptureClassName);
    this.requestRender();
    await getSoftshotApi().setLiveCapture(false);
  }

  private async finishRecording(result: RecordingResult): Promise<void> {
    this.recordingSession?.stopTracks();
    this.recordingSession = null;
    this.isRecording = false;
    this.recordingHud.stopRecording();
    this.syncToolbar();
    await this.exitLiveCapture();
    this.unbindMainEvents();
    this.stopMicrophoneMonitor();

    await getSoftshotApi().openVideoEditor(
      result.recordingId,
      this.fps,
      result.durationSeconds,
      result.mimeType,
      result.encoder,
      result.audioTracks
    );
  }

  private async handleStopRecordingRequest(): Promise<void> {
    if (this.isRecording) {
      await this.stopRecording();
      return;
    }

    if (this.isCountingDown) {
      await this.cancelCountdown();
    }
  }

  private async setLiveCaptureMousePassthrough(isPassthrough: boolean): Promise<void> {
    if (!this.isLiveCapture || this.isLiveCaptureMousePassthrough === isPassthrough) {
      return;
    }

    const wasPassthrough = this.isLiveCaptureMousePassthrough;
    this.isLiveCaptureMousePassthrough = isPassthrough;

    try {
      await getSoftshotApi().setLiveCaptureMousePassthrough(isPassthrough);
    } catch (error) {
      this.isLiveCaptureMousePassthrough = wasPassthrough;
      throw error;
    }
  }

  private onPointerDown(event: PointerEvent): void {
    if (this.shouldIgnorePointerDown(event)) {
      return;
    }

    const point = eventPoint(event);
    if (!this.selection || this.activeTool === "select") {
      this.startSelectionDrag(point, event.pointerId);
      return;
    }

    if (!isPointInRect(point, this.selection)) {
      this.activeTool = "select";
      this.startSelectionDrag(point, event.pointerId);
      this.syncToolbar();
      return;
    }

    this.startAnnotationDrag(point, event.pointerId);
  }

  private onPointerMove(event: PointerEvent): void {
    if (!this.dragState) {
      return;
    }

    const point = eventPoint(event);
    if (this.dragState.kind === "select") {
      this.dragState.current = point;
    } else if (this.dragState.kind === "pen") {
      this.dragState.annotation.points.push(clampPointToRect(point, this.selection));
    } else {
      this.dragState.current = clampPointToRect(point, this.selection);
    }

    this.requestRender();
  }

  private onPointerUp(event: PointerEvent): void {
    if (!this.dragState) {
      return;
    }

    const completedDrag = this.dragState;
    this.dragState = null;
    this.releasePointerCapture(event.pointerId);
    this.finishDrag(completedDrag);
    this.syncToolbar();
    this.requestRender();
  }

  private onScreenshotButtonClick(): void {
    this.captureMode = "screenshot";
    this.activeTool = "select";
    this.stopMicrophoneMonitor();
    this.syncToolbar();

    if (!this.selection) {
      this.closeMenus();
      this.pulseToolbar();
      return;
    }

    this.showScreenshotMenu();
  }

  private onVideoButtonClick(): void {
    this.closeMenus();
    if (this.captureMode !== "video") {
      this.enterVideoMode();
      return;
    }

    this.runAsync(this.toggleRecording(), "Could not toggle recording.");
  }

  private pulseToolbar(): void {
    this.toolbar.animate(
      [
        { transform: "translateX(-50%) scale(1)" },
        { transform: "translateX(-50%) scale(1.035)" },
        { transform: "translateX(-50%) scale(1)" }
      ],
      { duration: toolbarPulseDurationMs, easing: "ease-out" }
    );
  }

  private releasePointerCapture(pointerId: number): void {
    if (this.canvas.hasPointerCapture(pointerId)) {
      this.canvas.releasePointerCapture(pointerId);
    }
  }

  private render(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.context.clearRect(zeroPoint.x, zeroPoint.y, width, height);

    if (this.isLiveCapture) {
      this.renderSelection();
      this.recordingHud.refresh();
      return;
    }

    this.context.fillStyle = dimColor;
    this.context.fillRect(zeroPoint.x, zeroPoint.y, width, height);
    this.renderSelection();
    drawAnnotations(this.context, this.annotations, { clip: this.selection, offset: zeroPoint, scale: frameScale });
    this.drawCurrentArrow();
    this.recordingHud.refresh();
  }

  private async renderOnce(): Promise<void> {
    return new Promise((resolve) => {
      requestAnimationFrame((): void => {
        this.render();
        resolve();
      });
    });
  }

  private renderSelection(): void {
    const activeSelection = this.dragState?.kind === "select"
      ? normalizeRect(this.dragState.start, this.dragState.current)
      : this.selection;
    if (!activeSelection) {
      return;
    }

    this.context.clearRect(activeSelection.x, activeSelection.y, activeSelection.width, activeSelection.height);
    drawSelectionFrame(this.context, activeSelection, this.isRecording || this.isCountingDown);
  }

  private renderSelectionDataUrl(): string | null {
    if (!this.selection) {
      this.pulseToolbar();
      return null;
    }

    const output = document.createElement("canvas");
    const imageScaleX = this.screenImage.naturalWidth / window.innerWidth;
    const imageScaleY = this.screenImage.naturalHeight / window.innerHeight;
    output.width = Math.max(defaultDevicePixelRatio, Math.round(this.selection.width * imageScaleX));
    output.height = Math.max(defaultDevicePixelRatio, Math.round(this.selection.height * imageScaleY));

    const outputContext = getCanvasContext(output, screenshotCanvasContextError);
    outputContext.drawImage(
      this.screenImage,
      this.selection.x * imageScaleX,
      this.selection.y * imageScaleY,
      this.selection.width * imageScaleX,
      this.selection.height * imageScaleY,
      zeroPoint.x,
      zeroPoint.y,
      output.width,
      output.height
    );
    drawAnnotations(outputContext, this.annotations, {
      clip: this.selection,
      offset: { x: this.selection.x, y: this.selection.y },
      scale: {
        x: output.width / this.selection.width,
        y: output.height / this.selection.height
      }
    });
    return output.toDataURL("image/png");
  }

  private async reportError(message: string, error: unknown): Promise<void> {
    const detail = error instanceof Error ? `${message}\n\n${error.message}` : message;
    await getSoftshotApi().showError(detail);
  }

  private requestRender(): void {
    if (this.isRenderQueued) {
      return;
    }

    this.isRenderQueued = true;
    requestAnimationFrame((): void => {
      this.isRenderQueued = false;
      this.render();
    });
  }

  private resizeCanvas(): void {
    const ratio = devicePixelRatio === 0 ? defaultDevicePixelRatio : devicePixelRatio;
    this.canvas.width = Math.round(innerWidth * ratio);
    this.canvas.height = Math.round(innerHeight * ratio);
    this.canvas.style.width = `${String(innerWidth)}px`;
    this.canvas.style.height = `${String(innerHeight)}px`;
    this.context.setTransform(ratio, zeroPoint.x, zeroPoint.y, ratio, zeroPoint.x, zeroPoint.y);
  }

  private async saveScreenshot(): Promise<void> {
    const dataUrl = this.renderSelectionDataUrl();
    if (!dataUrl) {
      return;
    }

    await getSoftshotApi().saveScreenshot(dataUrl);
  }

  private runScreenshotAction(action: string | undefined): void {
    if (action === screenshotCopyAction) {
      this.runAsync(this.copyScreenshot(), "Could not copy the screenshot.");
      return;
    }

    if (action === screenshotSaveAction) {
      this.runAsync(this.saveScreenshot(), "Could not save the screenshot.");
    }
  }

  private async prepareRecordingSession(): Promise<RecordingSessionPreparation> {
    if (!this.bootstrap || !this.selection) {
      return {
        error: new Error("A selected screen region is required before recording."),
        kind: "failed"
      };
    }

    try {
      const session = await RecordingSession.create({
        annotations: [...this.annotations],
        crop: this.selection,
        fps: this.fps,
        microphoneDeviceId: this.microphoneDeviceId,
        quality: this.quality,
        systemAudioEnabled: this.systemAudioEnabled
      });
      return { kind: "ready", session };
    } catch (error) {
      return { error, kind: "failed" };
    }
  }

  private selectTool(tool: "arrow" | "pen"): void {
    this.closeMenus();
    this.activeTool = tool;
    this.syncToolbar();
  }

  private setVideoButtonState(state: VideoButtonState): void {
    const previousState = this.videoButton.dataset.state;
    this.videoButton.dataset.state = state;

    for (const icon of this.videoButton.querySelectorAll<HTMLElement>("[data-video-icon]")) {
      icon.classList.toggle("active", icon.dataset.videoIcon === state);
    }

    if (previousState && previousState !== state) {
      this.videoButton.animate(videoButtonPopKeyframes, {
        duration: videoButtonAnimationDurationMs,
        easing: "cubic-bezier(0.2, 0.85, 0.28, 1.2)"
      });
    }
  }

  private shouldIgnorePointerDown(event: PointerEvent): boolean {
    const isToolbarTarget = Boolean((event.target as HTMLElement).closest(".toolbar"));
    const isRecordingSelectionLocked = this.isRecording && this.activeTool === "select";
    return this.isLiveCapture || isToolbarTarget || this.isCountingDown || isRecordingSelectionLocked;
  }

  private startAnnotationDrag(point: Point, pointerId: number): void {
    if (this.activeTool === "pen") {
      const annotation: PenAnnotation = {
        color: this.selectedColor,
        kind: "pen",
        points: [point]
      };
      this.annotations.push(annotation);
      this.dragState = { annotation, kind: "pen" };
    } else {
      this.dragState = { current: point, kind: "arrow", start: point };
    }

    this.canvas.setPointerCapture(pointerId);
    this.requestRender();
  }

  private async discardPreparedRecordingSession(sessionPromise: Promise<RecordingSessionPreparation>): Promise<void> {
    const preparation = await sessionPromise;
    if (preparation.kind === "ready") {
      await preparation.session.discard();
    }
  }

  private async startRecording(session: RecordingSession): Promise<void> {
    if (!this.bootstrap || !this.selection || this.isRecording) {
      await session.discard();
      return;
    }

    try {
      this.captureMode = "video";
      this.isRecording = true;
      this.recordingSession = session;
      this.syncToolbar();
      this.stopMicrophoneMonitor();
      this.recordingHud.showRecordingPending();
      this.requestRender();
      await session.start();
      this.recordingHud.startRecordingTimer();
    } catch (error) {
      this.isRecording = false;
      await session.discard();
      this.recordingSession = null;
      this.recordingHud.stopRecording();
      this.syncToolbar();
      await this.exitLiveCapture();
      await this.syncMicrophoneMonitor();
      await this.reportError("Could not start the recording.", error);
    }
  }

  private async startRecordingCountdown(): Promise<void> {
    if (!this.selection || this.isRecording || this.isCountingDown) {
      return;
    }

    this.countdownRunId += runIdIncrement;
    const runId = this.countdownRunId;
    this.isCountingDown = true;
    this.syncToolbar();
    try {
      await this.enterLiveCapture();
    } catch (error) {
      this.isCountingDown = false;
      this.recordingHud.clearCountdown();
      this.syncToolbar();
      throw error;
    }
    this.stopMicrophoneMonitor();
    const sessionPromise = this.prepareRecordingSession();

    for (const value of countdownValues) {
      if (this.shouldStopCountdown(runId)) {
        this.runAsync(
          this.discardPreparedRecordingSession(sessionPromise),
          "Could not discard the prepared recording."
        );
        return;
      }

      this.recordingHud.setCountdown(value);
      this.requestRender();
      await delay(value === 0 ? countdownZeroHoldMs : countdownStepMs);
    }

    if (this.shouldStopCountdown(runId)) {
      this.runAsync(
        this.discardPreparedRecordingSession(sessionPromise),
        "Could not discard the prepared recording."
      );
      return;
    }

    try {
      this.recordingHud.clearCountdown();
      this.recordingHud.showRecordingPending();
      this.requestRender();
      const preparation = await sessionPromise;
      if (this.shouldStopCountdown(runId)) {
        if (preparation.kind === "ready") {
          await preparation.session.discard();
        }

        return;
      }

      if (preparation.kind === "failed") {
        throw preparation.error;
      }

      this.isCountingDown = false;
      await this.startRecording(preparation.session);
    } catch (error) {
      this.isCountingDown = false;
      this.recordingHud.clearCountdown();
      this.recordingHud.stopRecording();
      this.syncToolbar();
      await this.exitLiveCapture();
      await this.syncMicrophoneMonitor();
      await this.reportError("Could not start the recording.", error);
    }
  }

  private startSelectionDrag(point: Point, pointerId: number): void {
    this.dragState = { current: point, kind: "select", start: point };
    this.canvas.setPointerCapture(pointerId);
    this.requestRender();
  }

  private async stopRecording(): Promise<void> {
    if (!this.recordingSession) {
      return;
    }

    const session = this.recordingSession;
    const result = await session.stop();
    await this.finishRecording(result);
  }

  private syncToolbar(): void {
    const videoState = this.videoButtonState();
    const isVideoMode = this.captureMode === "video";
    this.toolbar.classList.toggle("video-mode", isVideoMode);
    this.screenshotButton.classList.toggle("active", this.captureMode === "screenshot");
    this.videoButton.classList.toggle("active", this.captureMode === "video");
    this.videoButton.classList.toggle("recording", this.isRecording || this.isCountingDown);
    setTooltipLabel(this.videoButton, this.videoButtonTitle(videoState));
    this.setVideoButtonState(videoState);
    this.penButton.classList.toggle("active", this.activeTool === "pen");
    this.arrowButton.classList.toggle("active", this.activeTool === "arrow");
    this.syncScreenshotToolAvailability(isVideoMode);
    document.documentElement.style.setProperty("--accent", this.selectedColor);
    this.syncColorMenu();
    this.syncVideoToolAvailability(isVideoMode);
    this.syncAudioButtons(isVideoMode);
    this.syncSettingsMenu();
  }

  private syncAudioButtons(isVideoMode: boolean): void {
    if (!isVideoMode) {
      this.hideMenu(this.microphoneMenu);
    }

    const microphoneLabel = microphoneSelectionLabel(this.microphoneDeviceId, this.microphoneDevices);
    this.microphoneButton.classList.toggle("muted", this.microphoneDeviceId === null);
    setTooltipLabel(this.microphoneButton, `Microphone: ${microphoneLabel}`);
    this.systemAudioButton.classList.toggle("active", this.systemAudioEnabled);
    this.systemAudioButton.classList.toggle("muted", !this.systemAudioEnabled);
    setTooltipLabel(this.systemAudioButton, this.systemAudioEnabled ? "Desktop audio: on" : "Desktop audio: off");
    this.renderMicrophoneMenu();
  }

  private syncColorMenu(): void {
    for (const button of this.colorMenu.querySelectorAll<HTMLButtonElement>("[data-color]")) {
      button.classList.toggle("selected", button.dataset.color === this.selectedColor);
    }
  }

  private syncSettingsMenu(): void {
    for (const button of this.settingsMenu.querySelectorAll<HTMLButtonElement>("[data-quality]")) {
      button.classList.toggle("selected", button.dataset.quality === this.quality);
    }

    for (const button of this.settingsMenu.querySelectorAll<HTMLButtonElement>("[data-fps]")) {
      button.classList.toggle("selected", Number(button.dataset.fps) === this.fps);
    }
  }

  private syncScreenshotToolAvailability(isVideoMode: boolean): void {
    for (const button of this.screenshotToolButtons) {
      button.disabled = isVideoMode;
      button.ariaHidden = String(isVideoMode);
      button.tabIndex = isVideoMode ? -1 : 0;
    }
  }

  private syncVideoToolAvailability(isVideoMode: boolean): void {
    for (const button of this.videoToolButtons) {
      button.disabled = !isVideoMode;
      button.ariaHidden = String(!isVideoMode);
      button.tabIndex = isVideoMode ? 0 : -1;
    }
  }

  private async toggleRecording(): Promise<void> {
    this.enterVideoMode();

    if (this.isRecording) {
      await this.stopRecording();
      return;
    }

    if (this.isCountingDown) {
      await this.cancelCountdown();
      return;
    }

    if (!this.selection) {
      this.syncToolbar();
      this.pulseToolbar();
      return;
    }

    await this.startRecordingCountdown();
  }

  private unbindMainEvents(): void {
    this.removeStopRecordingRequestHandler?.();
    this.removeStopRecordingRequestHandler = null;
  }

  private updateLiveCaptureMousePassthrough(event: MouseEvent): void {
    if (!this.isLiveCapture) {
      return;
    }

    const isToolbarTarget = event.target instanceof Node && this.toolbar.contains(event.target);
    this.runAsync(
      this.setLiveCaptureMousePassthrough(!isToolbarTarget),
      "Could not update live capture mouse passthrough."
    );
  }

  private updateRecordingSetting(button: HTMLButtonElement): void {
    const { fps, quality } = button.dataset;
    if (quality === "720p" || quality === "1080p") {
      this.quality = quality;
    }

    if (fps === "30" || fps === "60") {
      this.fps = Number(fps) as VideoFps;
    }
  }

  private undoLastAnnotation(): void {
    if (this.dragState || this.isCountingDown || this.isRecording || this.annotations.length === 0) {
      return;
    }

    this.annotations.pop();
    this.requestRender();
  }

  private videoButtonState(): VideoButtonState {
    if (this.isRecording || this.isCountingDown) {
      return "stop";
    }

    if (this.captureMode === "video" && this.selection) {
      return "start";
    }

    return "video";
  }

  private videoButtonTitle(state: VideoButtonState): string {
    if (state === "stop") {
      return this.isCountingDown ? "Cancel countdown" : "Stop recording";
    }

    if (state === "start") {
      return "Start recording";
    }

    return "Video";
  }

  private finishDrag(completedDrag: Exclude<DragState, null>): void {
    if (completedDrag.kind === "select") {
      this.finishSelectionDrag(completedDrag.start, completedDrag.current);
    } else if (completedDrag.kind === "arrow") {
      this.finishArrowDrag(completedDrag);
    }
  }

  private finishArrowDrag(completedDrag: { current: Point; start: Point }): void {
    const arrow = normalizeArrow({
      color: this.selectedColor,
      from: completedDrag.start,
      kind: "arrow",
      to: completedDrag.current
    }, this.selection);
    if (distance(arrow.from, arrow.to) >= minimumArrowLengthPx) {
      this.annotations.push(arrow);
    }
  }

  private finishSelectionDrag(start: Point, current: Point): void {
    const nextSelection = normalizeRect(start, current);
    if (nextSelection.width < minimumSelectionSizePx || nextSelection.height < minimumSelectionSizePx) {
      return;
    }

    this.selection = nextSelection;
    this.annotations = [];
    this.activeTool = "select";
    this.recordingHud.setSelection(this.selection);
    if (this.captureMode === "screenshot") {
      this.showScreenshotMenu();
    }
  }

  private shouldStopCountdown(runId: number): boolean {
    return !this.isCountingDown || runId !== this.countdownRunId;
  }

  private shouldMonitorMicrophone(): boolean {
    return this.captureMode === "video"
      && this.microphoneDeviceId !== null
      && !this.isCountingDown
      && !this.isRecording;
  }

  async initialize(): Promise<void> {
    try {
      const [bootstrap, settings] = await Promise.all([
        getSoftshotApi().getBootstrap(),
        getSoftshotApi().getSettings()
      ]);
      this.bootstrap = bootstrap;
      await this.applyAppSettings(settings);
      await loadImage(this.screenImage, this.bootstrap.imageDataUrl, "Timed out loading the frozen screen image.");
      this.resizeCanvas();
      this.bindEvents();
      this.syncToolbar();
      await this.renderOnce();
      await getSoftshotApi().readyToShow();
    } catch (error) {
      await this.reportError("Could not prepare the capture overlay.", error);
      await this.closeOverlay();
    }
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function stopMicrophoneResources(stream: MediaStream | null, audioContext: AudioContext | null): void {
  if (stream) {
    for (const track of stream.getTracks()) {
      track.stop();
    }
  }

  if (audioContext) {
    void audioContext.close();
  }
}

const overlayApp = new OverlayApp();
await overlayApp.initialize();
