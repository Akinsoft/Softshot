import { getRequiredElement } from "./overlay-dom.js";
import type { Rect } from "./shared.js";

const timerIntervalMs = 250;
const hudViewportInsetPx = 8;
const hudSelectionPaddingPx = 14;
const millisecondsPerSecond = 1000;
const secondsPerMinute = 60;
const timePartLength = 2;

export class RecordingHudController {
  private readonly countdown = getRequiredElement("countdown-badge", HTMLDivElement);
  private readonly hud = getRequiredElement("recording-hud", HTMLDivElement);
  private readonly timer = getRequiredElement("recording-timer", HTMLSpanElement);
  private countdownValue: number | null = null;
  private isCountingDown = false;
  private isRecording = false;
  private recordingStartedAt: number | null = null;
  private selection: Rect | null = null;
  private viewport: Rect = { x: 0, y: 0, width: innerWidth, height: innerHeight };
  private timerHandle: ReturnType<typeof setInterval> | null = null;

  private clearTimer(): void {
    if (this.timerHandle !== null) {
      clearInterval(this.timerHandle);
      this.timerHandle = null;
    }

    this.recordingStartedAt = null;
  }

  private updateTimer(): void {
    if (this.recordingStartedAt === null) {
      this.timer.textContent = "00:00";
      return;
    }

    this.timer.textContent = formatElapsed(Date.now() - this.recordingStartedAt);
  }

  private update(): void {
    const shouldShowHud = Boolean(this.selection && (this.isRecording || this.isCountingDown));
    this.hud.hidden = !shouldShowHud;
    this.countdown.hidden = !this.selection || this.countdownValue === null;

    if (!this.selection) {
      return;
    }

    const hudLeft = Math.min(
      Math.max(
        this.selection.x + this.selection.width - hudSelectionPaddingPx,
        this.viewport.x + this.hud.offsetWidth + hudViewportInsetPx
      ),
      this.viewport.x + this.viewport.width - hudViewportInsetPx
    );
    const hudTop = Math.min(
      Math.max(this.selection.y + hudSelectionPaddingPx, this.viewport.y + hudViewportInsetPx),
      this.viewport.y + this.viewport.height - this.hud.offsetHeight - hudViewportInsetPx
    );
    this.hud.style.left = `${String(hudLeft)}px`;
    this.hud.style.top = `${String(hudTop)}px`;

    if (this.countdownValue !== null) {
      this.countdown.textContent = String(this.countdownValue);
      const horizontalInset = this.countdown.offsetWidth / timePartLength + hudViewportInsetPx;
      const verticalInset = this.countdown.offsetHeight / timePartLength + hudViewportInsetPx;
      const left = Math.min(
        Math.max(this.selection.x + this.selection.width / timePartLength, this.viewport.x + horizontalInset),
        this.viewport.x + this.viewport.width - horizontalInset
      );
      const top = Math.min(
        Math.max(this.selection.y + this.selection.height / timePartLength, this.viewport.y + verticalInset),
        this.viewport.y + this.viewport.height - verticalInset
      );
      this.countdown.style.left = `${String(left)}px`;
      this.countdown.style.top = `${String(top)}px`;
    }
  }

  clearCountdown(): void {
    this.isCountingDown = false;
    this.countdownValue = null;
    this.update();
  }

  refresh(): void {
    this.update();
  }

  setCountdown(value: number): void {
    this.isCountingDown = true;
    this.countdownValue = value;
    this.update();
  }

  setViewport(viewport: Rect): void {
    this.viewport = viewport;
    this.update();
  }

  setSelection(selection: Rect | null): void {
    this.selection = selection;
    this.update();
  }

  showRecordingPending(): void {
    this.isRecording = true;
    this.timer.textContent = "00:00";
    this.update();
  }

  startRecordingTimer(): void {
    this.clearTimer();
    this.isRecording = true;
    this.recordingStartedAt = Date.now();
    this.updateTimer();
    this.timerHandle = setInterval((): void => {
      this.updateTimer();
    }, timerIntervalMs);
    this.update();
  }

  stopRecording(): void {
    this.isRecording = false;
    this.clearTimer();
    this.timer.textContent = "00:00";
    this.update();
  }
}

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / millisecondsPerSecond));
  const minutes = Math.floor(totalSeconds / secondsPerMinute).toString().padStart(timePartLength, "0");
  const seconds = (totalSeconds % secondsPerMinute).toString().padStart(timePartLength, "0");
  return `${minutes}:${seconds}`;
}
