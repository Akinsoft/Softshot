type CaptureMode = "screenshot" | "video";
type DrawingTool = "select" | "pen" | "arrow";
type VideoQuality = "720p" | "1080p";
type VideoFps = 30 | 60;
type VideoButtonState = "video" | "start" | "stop";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface OverlayBootstrap {
  sourceId: string;
  imageDataUrl: string;
  displayBounds: Rect;
  scaleFactor: number;
}

type Point = {
  x: number;
  y: number;
};

type PenAnnotation = {
  kind: "pen";
  color: string;
  points: Point[];
};

type ArrowAnnotation = {
  kind: "arrow";
  color: string;
  from: Point;
  to: Point;
};

type Annotation = PenAnnotation | ArrowAnnotation;
type DragState =
  | { kind: "select"; start: Point; current: Point }
  | { kind: "pen"; annotation: PenAnnotation }
  | { kind: "arrow"; start: Point; current: Point }
  | null;

const screenImage = element<HTMLImageElement>("screen-image");
const canvas = element<HTMLCanvasElement>("annotation-canvas");
const screenshotButton = element<HTMLButtonElement>("screenshot-button");
const videoButton = element<HTMLButtonElement>("video-button");
const penButton = element<HTMLButtonElement>("pen-button");
const arrowButton = element<HTMLButtonElement>("arrow-button");
const colorButton = element<HTMLButtonElement>("color-button");
const settingsButton = element<HTMLButtonElement>("settings-button");
const closeButton = element<HTMLButtonElement>("close-button");
const colorMenu = element<HTMLDivElement>("color-menu");
const settingsMenu = element<HTMLDivElement>("settings-menu");
const recordingHud = new RecordingHudController();

const context = canvasContext(canvas, "Could not create the overlay drawing context.");
const videoButtonIcons: Record<VideoButtonState, string> = {
  video: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="6" width="12" height="12" rx="2.5"></rect>
      <path d="m15.5 10 5-3v10l-5-3Z"></path>
    </svg>
  `,
  start: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 5.5v13l10-6.5Z"></path>
    </svg>
  `,
  stop: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="1.8"></rect>
    </svg>
  `
};

let bootstrap: OverlayBootstrap | null = null;
let captureMode: CaptureMode = "screenshot";
let activeTool: DrawingTool = "select";
let selectedColor = "#38bdf8";
let quality: VideoQuality = "1080p";
let fps: VideoFps = 60;
let selection: Rect | null = null;
let dragState: DragState = null;
let annotations: Annotation[] = [];
let needsRender = false;
let isRecording = false;
let isCountingDown = false;
let countdownValue: number | null = null;
let countdownRunId = 0;
let recordingSession: RecordingSession | null = null;

void initialize();

async function initialize(): Promise<void> {
  try {
    bootstrap = await window.softshot.getBootstrap();
    await loadImage(screenImage, bootstrap.imageDataUrl, "Timed out loading the frozen screen image.");

    resizeCanvas();
    bindEvents();
    syncToolbar();
    await renderOnce();
    await window.softshot.readyToShow();
  } catch (error) {
    await reportError("Could not prepare the capture overlay.", error);
    await closeOverlay();
  }
}

function bindEvents(): void {
  window.addEventListener("resize", () => {
    resizeCanvas();
    recordingHud.refresh();
    requestRender();
  });

  window.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", cancelDrag);

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      void closeOverlay();
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
      event.preventDefault();
      void copyScreenshot();
      return;
    }

    if (event.key === "Enter" && captureMode === "screenshot") {
      void saveScreenshot();
      return;
    }

    if (event.key === " " && captureMode === "video") {
      event.preventDefault();
      void toggleRecording();
    }
  });

  document.querySelector(".toolbar")?.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
  });

  screenshotButton.addEventListener("click", () => {
    closeMenus();
    captureMode = "screenshot";
    activeTool = "select";
    syncToolbar();

    if (selection) {
      void saveScreenshot();
    }
  });

  videoButton.addEventListener("click", () => {
    closeMenus();
    if (captureMode !== "video") {
      enterVideoMode();
      return;
    }

    void toggleRecording();
  });

  penButton.addEventListener("click", () => {
    closeMenus();
    activeTool = "pen";
    syncToolbar();
  });

  arrowButton.addEventListener("click", () => {
    closeMenus();
    activeTool = "arrow";
    syncToolbar();
  });

  colorButton.addEventListener("click", () => {
    settingsMenu.hidden = true;
    colorMenu.hidden = !colorMenu.hidden;
  });

  settingsButton.addEventListener("click", () => {
    colorMenu.hidden = true;
    settingsMenu.hidden = !settingsMenu.hidden;
  });

  closeButton.addEventListener("click", () => {
    void closeOverlay();
  });

  colorMenu.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-color]");
    if (!button) {
      return;
    }

    selectedColor = button.dataset.color ?? selectedColor;
    syncToolbar();
    requestRender();
  });

  settingsMenu.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-quality], [data-fps]");
    if (!button || isRecording || isCountingDown) {
      return;
    }

    if (button.dataset.quality === "720p" || button.dataset.quality === "1080p") {
      quality = button.dataset.quality;
    }

    if (button.dataset.fps === "30" || button.dataset.fps === "60") {
      fps = Number(button.dataset.fps) as VideoFps;
    }

    syncToolbar();
  });

  window.addEventListener("pointerdown", (event) => {
    if (!(event.target as HTMLElement).closest(".toolbar")) {
      closeMenus();
    }
  });
}

function onPointerDown(event: PointerEvent): void {
  if ((event.target as HTMLElement).closest(".toolbar") || isCountingDown || isRecording && activeTool === "select") {
    return;
  }

  const point = eventPoint(event);

  if (!selection || activeTool === "select") {
    dragState = { kind: "select", start: point, current: point };
    canvas.setPointerCapture(event.pointerId);
    requestRender();
    return;
  }

  if (!pointInRect(point, selection)) {
    activeTool = "select";
    dragState = { kind: "select", start: point, current: point };
    canvas.setPointerCapture(event.pointerId);
    syncToolbar();
    requestRender();
    return;
  }

  if (activeTool === "pen") {
    const annotation: PenAnnotation = {
      kind: "pen",
      color: selectedColor,
      points: [point]
    };
    annotations.push(annotation);
    dragState = { kind: "pen", annotation };
    canvas.setPointerCapture(event.pointerId);
    requestRender();
    return;
  }

  if (activeTool === "arrow") {
    dragState = { kind: "arrow", start: point, current: point };
    canvas.setPointerCapture(event.pointerId);
    requestRender();
  }
}

function onPointerMove(event: PointerEvent): void {
  if (!dragState) {
    return;
  }

  const point = eventPoint(event);

  if (dragState.kind === "select") {
    dragState.current = point;
  }

  if (dragState.kind === "pen") {
    dragState.annotation.points.push(clampToSelection(point));
  }

  if (dragState.kind === "arrow") {
    dragState.current = clampToSelection(point);
  }

  requestRender();
}

function onPointerUp(event: PointerEvent): void {
  if (!dragState) {
    return;
  }

  const completedDrag = dragState;
  dragState = null;

  if (canvas.hasPointerCapture(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }

  if (completedDrag.kind === "select") {
    const nextSelection = normalizeRect(completedDrag.start, completedDrag.current);
    if (nextSelection.width >= 8 && nextSelection.height >= 8) {
      selection = nextSelection;
      annotations = [];
      activeTool = "select";
      recordingHud.setSelection(selection);
    }
  }

  if (completedDrag.kind === "arrow") {
    const arrow = normalizeArrow({
      kind: "arrow",
      color: selectedColor,
      from: completedDrag.start,
      to: completedDrag.current
    });
    if (distance(arrow.from, arrow.to) >= 6) {
      annotations.push(arrow);
    }
  }

  syncToolbar();
  requestRender();
}

function cancelDrag(): void {
  dragState = null;
  requestRender();
}

async function saveScreenshot(): Promise<void> {
  try {
    const dataUrl = renderSelectionDataUrl();
    if (!dataUrl) {
      return;
    }

    await window.softshot.saveScreenshot(dataUrl);
  } catch (error) {
    await reportError("Could not save the screenshot.", error);
  }
}

async function copyScreenshot(): Promise<void> {
  try {
    const dataUrl = renderSelectionDataUrl();
    if (!dataUrl) {
      return;
    }

    await window.softshot.copyScreenshot(dataUrl);
  } catch (error) {
    await reportError("Could not copy the screenshot.", error);
  }
}

function renderSelectionDataUrl(): string | null {
  if (!selection) {
    pulseToolbar();
    return null;
  }

  const output = document.createElement("canvas");
  const imageScaleX = screenImage.naturalWidth / window.innerWidth;
  const imageScaleY = screenImage.naturalHeight / window.innerHeight;
  output.width = Math.max(1, Math.round(selection.width * imageScaleX));
  output.height = Math.max(1, Math.round(selection.height * imageScaleY));

  const outputContext = canvasContext(output, "Could not create the screenshot canvas.");
  outputContext.drawImage(
    screenImage,
    selection.x * imageScaleX,
    selection.y * imageScaleY,
    selection.width * imageScaleX,
    selection.height * imageScaleY,
    0,
    0,
    output.width,
    output.height
  );

  drawAnnotations(outputContext, {
    offset: { x: selection.x, y: selection.y },
    scale: { x: output.width / selection.width, y: output.height / selection.height },
    clip: selection
  });

  return output.toDataURL("image/png");
}

async function toggleRecording(): Promise<void> {
  enterVideoMode();

  if (isRecording) {
    await stopRecording();
    return;
  }

  if (isCountingDown) {
    cancelCountdown();
    return;
  }

  if (!selection) {
    syncToolbar();
    pulseToolbar();
    return;
  }

  await startRecordingCountdown();
}

function enterVideoMode(): void {
  captureMode = "video";
  activeTool = "select";
  syncToolbar();
}

async function startRecordingCountdown(): Promise<void> {
  if (!selection || isRecording || isCountingDown) {
    return;
  }

  const runId = ++countdownRunId;
  isCountingDown = true;
  syncToolbar();

  for (const value of [3, 2, 1, 0]) {
    if (!isCountingDown || runId !== countdownRunId) {
      return;
    }

    countdownValue = value;
    recordingHud.setCountdown(value);
    requestRender();
    await delay(value === 0 ? 500 : 1000);
  }

  if (!isCountingDown || runId !== countdownRunId) {
    return;
  }

  isCountingDown = false;
  countdownValue = null;
  recordingHud.clearCountdown();
  await startRecording();
}

function cancelCountdown(): void {
  countdownRunId++;
  isCountingDown = false;
  countdownValue = null;
  recordingHud.clearCountdown();
  syncToolbar();
  requestRender();
}

async function startRecording(): Promise<void> {
  if (!bootstrap || !selection || isRecording) {
    return;
  }

  try {
    captureMode = "video";
    isRecording = true;
    syncToolbar();
    recordingHud.showRecordingPending();
    requestRender();

    const sourceStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: bootstrap.sourceId,
          maxFrameRate: fps
        }
      } as MediaTrackConstraints
    });

    const sourceVideo = document.createElement("video");
    sourceVideo.muted = true;
    sourceVideo.playsInline = true;
    sourceVideo.srcObject = sourceStream;
    await sourceVideo.play();
    await waitForVideoMetadata(sourceVideo);

    const outputSize = videoOutputSize(selection, quality);
    const outputCanvas = document.createElement("canvas");
    outputCanvas.width = outputSize.width;
    outputCanvas.height = outputSize.height;

    const outputContext = outputCanvas.getContext("2d");
    if (!outputContext) {
      throw new Error("Could not create the recording canvas.");
    }

    const outputStream = outputCanvas.captureStream(fps);
    const recorder = new MediaRecorder(outputStream, {
      mimeType: supportedVideoMimeType(),
      videoBitsPerSecond: videoBitrate(quality, fps)
    });

    const chunks: Blob[] = [];
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    });

    recorder.addEventListener("stop", () => {
      void finishRecording(chunks, sourceStream, outputStream);
    });

    recordingSession = new RecordingSession({
      recorder,
      sourceStream,
      outputStream,
      sourceVideo,
      outputCanvas,
      outputContext,
      animationHandle: null,
      crop: { ...selection },
      outputSize
    });

    drawRecordingFrame();
    recorder.start(500);
    recordingHud.startRecordingTimer();
  } catch (error) {
    isRecording = false;
    recordingHud.stopRecording();
    recordingSession?.stopTracks();
    recordingSession = null;
    syncToolbar();
    await reportError("Could not start the recording.", error);
  }
}

async function stopRecording(): Promise<void> {
  if (!recordingSession || recordingSession.recorder.state === "inactive") {
    return;
  }

  recordingSession.recorder.stop();
}

async function finishRecording(chunks: Blob[], sourceStream: MediaStream, outputStream: MediaStream): Promise<void> {
  const session = recordingSession;
  recordingSession = null;
  isRecording = false;
  recordingHud.stopRecording();
  syncToolbar();

  if (session?.animationHandle !== null && session?.animationHandle !== undefined) {
    cancelAnimationFrame(session.animationHandle);
  }

  stopTracks(sourceStream);
  stopTracks(outputStream);

  try {
    const blob = new Blob(chunks, { type: supportedVideoMimeType() });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await window.softshot.saveVideo(bytes);
  } catch (error) {
    await reportError("Could not save the recording.", error);
  }
}

function drawRecordingFrame(): void {
  if (!recordingSession) {
    return;
  }

  const { sourceVideo, outputCanvas, outputContext, crop } = recordingSession;
  const sourceScaleX = sourceVideo.videoWidth / window.innerWidth;
  const sourceScaleY = sourceVideo.videoHeight / window.innerHeight;

  outputContext.clearRect(0, 0, outputCanvas.width, outputCanvas.height);
  outputContext.drawImage(
    sourceVideo,
    crop.x * sourceScaleX,
    crop.y * sourceScaleY,
    crop.width * sourceScaleX,
    crop.height * sourceScaleY,
    0,
    0,
    outputCanvas.width,
    outputCanvas.height
  );

  drawAnnotations(outputContext, {
    offset: { x: crop.x, y: crop.y },
    scale: { x: outputCanvas.width / crop.width, y: outputCanvas.height / crop.height },
    clip: crop
  });

  recordingSession.animationHandle = requestAnimationFrame(drawRecordingFrame);
}

function requestRender(): void {
  if (needsRender) {
    return;
  }

  needsRender = true;
  requestAnimationFrame(() => {
    needsRender = false;
    render();
  });
}

function renderOnce(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      render();
      resolve();
    });
  });
}

function render(): void {
  const width = window.innerWidth;
  const height = window.innerHeight;
  context.clearRect(0, 0, width, height);
  context.fillStyle = "rgba(0, 0, 0, 0.44)";
  context.fillRect(0, 0, width, height);

  const activeSelection = dragState?.kind === "select" ? normalizeRect(dragState.start, dragState.current) : selection;
  if (activeSelection) {
    context.clearRect(activeSelection.x, activeSelection.y, activeSelection.width, activeSelection.height);
    drawSelectionFrame(activeSelection);
  }

  drawAnnotations(context, { offset: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, clip: selection });

  if (dragState?.kind === "arrow") {
    drawArrow(context, {
      kind: "arrow",
      color: selectedColor,
      from: dragState.start,
      to: dragState.current
    });
  }

  recordingHud.refresh();
}

function drawSelectionFrame(rect: Rect): void {
  context.save();
  context.strokeStyle = isRecording || isCountingDown ? "#f87171" : "#38bdf8";
  context.lineWidth = 2;
  context.setLineDash([8, 7]);
  context.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1);
  context.restore();
}

function drawAnnotations(
  targetContext: CanvasRenderingContext2D,
  transform: { offset: Point; scale: Point; clip: Rect | null }
): void {
  targetContext.save();

  if (transform.clip) {
    targetContext.beginPath();
    targetContext.rect(
      (transform.clip.x - transform.offset.x) * transform.scale.x,
      (transform.clip.y - transform.offset.y) * transform.scale.y,
      transform.clip.width * transform.scale.x,
      transform.clip.height * transform.scale.y
    );
    targetContext.clip();
  }

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

function drawPen(targetContext: CanvasRenderingContext2D, annotation: PenAnnotation): void {
  if (annotation.points.length < 2) {
    return;
  }

  targetContext.save();
  targetContext.strokeStyle = annotation.color;
  targetContext.lineWidth = 4;
  targetContext.lineCap = "round";
  targetContext.lineJoin = "round";
  targetContext.beginPath();
  targetContext.moveTo(annotation.points[0].x, annotation.points[0].y);

  for (const point of annotation.points.slice(1)) {
    targetContext.lineTo(point.x, point.y);
  }

  targetContext.stroke();
  targetContext.restore();
}

function drawArrow(targetContext: CanvasRenderingContext2D, annotation: ArrowAnnotation): void {
  const angle = Math.atan2(annotation.to.y - annotation.from.y, annotation.to.x - annotation.from.x);
  const headLength = 16;
  const headWidth = 10;
  const base = {
    x: annotation.to.x - headLength * Math.cos(angle),
    y: annotation.to.y - headLength * Math.sin(angle)
  };
  const left = {
    x: base.x + headWidth * Math.cos(angle - Math.PI / 2),
    y: base.y + headWidth * Math.sin(angle - Math.PI / 2)
  };
  const right = {
    x: base.x + headWidth * Math.cos(angle + Math.PI / 2),
    y: base.y + headWidth * Math.sin(angle + Math.PI / 2)
  };

  targetContext.save();
  targetContext.strokeStyle = annotation.color;
  targetContext.fillStyle = annotation.color;
  targetContext.lineWidth = 4;
  targetContext.lineCap = "round";
  targetContext.lineJoin = "round";
  targetContext.beginPath();
  targetContext.moveTo(annotation.from.x, annotation.from.y);
  targetContext.lineTo(base.x, base.y);
  targetContext.stroke();

  targetContext.beginPath();
  targetContext.moveTo(annotation.to.x, annotation.to.y);
  targetContext.lineTo(left.x, left.y);
  targetContext.lineTo(right.x, right.y);
  targetContext.closePath();
  targetContext.fill();
  targetContext.restore();
}

function syncToolbar(): void {
  const videoState = videoButtonState();
  screenshotButton.classList.toggle("active", captureMode === "screenshot");
  videoButton.classList.toggle("active", captureMode === "video");
  videoButton.classList.toggle("recording", isRecording || isCountingDown);
  videoButton.title = videoButtonTitle(videoState);
  videoButton.setAttribute("aria-label", videoButton.title);
  videoButton.dataset.state = videoState;
  if (videoButton.dataset.renderedState !== videoState) {
    videoButton.innerHTML = videoButtonIcons[videoState];
    videoButton.dataset.renderedState = videoState;
  }
  penButton.classList.toggle("active", activeTool === "pen");
  arrowButton.classList.toggle("active", activeTool === "arrow");

  document.documentElement.style.setProperty("--accent", selectedColor);

  for (const button of colorMenu.querySelectorAll<HTMLButtonElement>("[data-color]")) {
    button.classList.toggle("selected", button.dataset.color === selectedColor);
  }

  for (const button of settingsMenu.querySelectorAll<HTMLButtonElement>("[data-quality]")) {
    button.classList.toggle("selected", button.dataset.quality === quality);
  }

  for (const button of settingsMenu.querySelectorAll<HTMLButtonElement>("[data-fps]")) {
    button.classList.toggle("selected", Number(button.dataset.fps) === fps);
  }
}

function videoButtonState(): VideoButtonState {
  if (isRecording || isCountingDown) {
    return "stop";
  }

  if (captureMode === "video" && selection) {
    return "start";
  }

  return "video";
}

function videoButtonTitle(state: VideoButtonState): string {
  if (state === "stop") {
    return isCountingDown ? "Cancel countdown" : "Stop recording";
  }

  if (state === "start") {
    return "Start recording";
  }

  return "Video";
}

function resizeCanvas(): void {
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * ratio);
  canvas.height = Math.round(window.innerHeight * ratio);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function normalizeRect(start: Point, end: Point): Rect {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  const width = Math.abs(end.x - start.x);
  const height = Math.abs(end.y - start.y);
  return { x, y, width, height };
}

function normalizeArrow(annotation: ArrowAnnotation): ArrowAnnotation {
  return {
    ...annotation,
    from: clampToSelection(annotation.from),
    to: clampToSelection(annotation.to)
  };
}

function clampToSelection(point: Point): Point {
  if (!selection) {
    return point;
  }

  return {
    x: Math.min(Math.max(point.x, selection.x), selection.x + selection.width),
    y: Math.min(Math.max(point.y, selection.y), selection.y + selection.height)
  };
}

function pointInRect(point: Point, rect: Rect): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}

function eventPoint(event: PointerEvent): Point {
  return {
    x: event.clientX,
    y: event.clientY
  };
}

function distance(from: Point, to: Point): number {
  return Math.hypot(to.x - from.x, to.y - from.y);
}

function videoOutputSize(rect: Rect, selectedQuality: VideoQuality): { width: number; height: number } {
  const targetHeight = selectedQuality === "720p" ? 720 : 1080;
  const aspect = rect.width / rect.height;
  return {
    width: Math.max(2, Math.round(targetHeight * aspect)),
    height: targetHeight
  };
}

function videoBitrate(selectedQuality: VideoQuality, selectedFps: VideoFps): number {
  const base = selectedQuality === "720p" ? 5_000_000 : 10_000_000;
  return selectedFps === 60 ? Math.round(base * 1.5) : base;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function supportedVideoMimeType(): string {
  const preferredTypes = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm"
  ];

  const supported = preferredTypes.find((type) => MediaRecorder.isTypeSupported(type));
  if (!supported) {
    throw new Error("This system does not support WebM screen recording through MediaRecorder.");
  }

  return supported;
}

function closeMenus(): void {
  colorMenu.hidden = true;
  settingsMenu.hidden = true;
}

async function closeOverlay(): Promise<void> {
  if (isCountingDown) {
    cancelCountdown();
  }

  if (isRecording) {
    await stopRecording();
    return;
  }

  await window.softshot.closeOverlay();
}

async function reportError(message: string, error: unknown): Promise<void> {
  const detail = error instanceof Error ? `${message}\n\n${error.message}` : message;
  await window.softshot.showError(detail);
}

function pulseToolbar(): void {
  const toolbar = document.querySelector<HTMLElement>(".toolbar");
  if (!toolbar) {
    return;
  }

  toolbar.animate(
    [
      { transform: "translateX(-50%) scale(1)" },
      { transform: "translateX(-50%) scale(1.035)" },
      { transform: "translateX(-50%) scale(1)" }
    ],
    { duration: 160, easing: "ease-out" }
  );
}

function loadImage(image: HTMLImageElement, source: string, timeoutMessage: string): Promise<void> {
  return withTimeout(
    new Promise((resolve, reject) => {
      const cleanup = () => {
        image.removeEventListener("load", onLoad);
        image.removeEventListener("error", onError);
      };
      const onLoad = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("Could not load the frozen screen image."));
      };

      image.addEventListener("load", onLoad);
      image.addEventListener("error", onError);
      image.src = source;

      if (image.complete && image.naturalWidth > 0) {
        cleanup();
        resolve();
      }
    }),
    2000,
    timeoutMessage
  );
}

function waitForVideoMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.videoWidth > 0 && video.videoHeight > 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    video.addEventListener("loadedmetadata", () => resolve(), { once: true });
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: number | undefined;
  const timeout = new Promise<T>((_resolve, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
    }
  });
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) {
    throw new Error(`Missing element: ${id}.`);
  }

  return value as T;
}

function canvasContext(canvasElement: HTMLCanvasElement, errorMessage: string): CanvasRenderingContext2D {
  const value = canvasElement.getContext("2d");
  if (!value) {
    throw new Error(errorMessage);
  }

  return value;
}

class RecordingSession {
  readonly recorder: MediaRecorder;
  readonly sourceStream: MediaStream;
  readonly outputStream: MediaStream;
  readonly sourceVideo: HTMLVideoElement;
  readonly outputCanvas: HTMLCanvasElement;
  readonly outputContext: CanvasRenderingContext2D;
  readonly crop: Rect;
  readonly outputSize: { width: number; height: number };
  animationHandle: number | null;

  constructor(config: {
    recorder: MediaRecorder;
    sourceStream: MediaStream;
    outputStream: MediaStream;
    sourceVideo: HTMLVideoElement;
    outputCanvas: HTMLCanvasElement;
    outputContext: CanvasRenderingContext2D;
    crop: Rect;
    outputSize: { width: number; height: number };
    animationHandle: number | null;
  }) {
    this.recorder = config.recorder;
    this.sourceStream = config.sourceStream;
    this.outputStream = config.outputStream;
    this.sourceVideo = config.sourceVideo;
    this.outputCanvas = config.outputCanvas;
    this.outputContext = config.outputContext;
    this.crop = config.crop;
    this.outputSize = config.outputSize;
    this.animationHandle = config.animationHandle;
  }

  stopTracks(): void {
    stopTracks(this.sourceStream);
    stopTracks(this.outputStream);
  }
}
