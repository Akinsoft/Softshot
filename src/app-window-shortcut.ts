import type { AppWindowContext } from "./app-window-controls.js";
import { errorMessage } from "./async-errors.js";
import type { ShortcutRecordingEvent, ShortcutTarget } from "./shared.js";
import { getSoftshotApi } from "./softshot-api.js";

const statusClearDelayMs = 1400;
const recordingButtonText = "Press keys";

export class ShortcutButton {
  private isRecording = false;

  private shortcut = "";

  private statusTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly button: HTMLButtonElement,
    private readonly status: HTMLElement,
    private readonly target: ShortcutTarget,
    private readonly context: AppWindowContext
  ) {}

  private async begin(): Promise<void> {
    if (this.isRecording) {
      return;
    }

    await getSoftshotApi().beginShortcutRecording(this.target);
    this.isRecording = true;
    this.button.classList.add("recording");
    this.button.textContent = recordingButtonText;
    this.button.focus();
    this.setStatus("");
  }

  private finish(): void {
    if (!this.isRecording) {
      return;
    }

    this.isRecording = false;
    this.button.classList.remove("recording");
    this.button.replaceChildren(this.context.shortcutLabels().keycaps(this.shortcut));
  }

  private setStatus(message: string): void {
    if (this.statusTimeout !== null) {
      clearTimeout(this.statusTimeout);
      this.statusTimeout = null;
    }

    this.status.textContent = message;
  }

  private setTemporaryStatus(message: string): void {
    this.setStatus(message);
    this.statusTimeout = setTimeout((): void => {
      this.statusTimeout = null;
      this.setStatus("");
    }, statusClearDelayMs);
  }

  private handleEvent(event: ShortcutRecordingEvent): void {
    switch (event.type) {
      case "cancelled": {
        this.finish();
        break;
      }

      case "error": {
        this.setTemporaryStatus(event.message);
        break;
      }

      case "preview": {
        this.button.replaceChildren(this.context.shortcutLabels().keycaps(event.shortcut));
        break;
      }

      case "saved": {
        this.context.applySettings(event.settings);
        this.finish();
        this.setStatus("");
        break;
      }

      default: {
        throw new Error(`Unexpected shortcut recording event: ${JSON.stringify(event)}`);
      }
    }
  }

  bind(): void {
    this.button.addEventListener("click", (): void => {
      void this.begin().catch((error: unknown): void => {
        this.setTemporaryStatus(errorMessage(error));
      });
    });
    getSoftshotApi().onShortcutRecordingEvent((event): void => {
      if (event.target === this.target) {
        this.handleEvent(event);
      }
    });
  }

  render(shortcut: string): void {
    this.shortcut = shortcut;
    if (!this.isRecording) {
      this.button.replaceChildren(this.context.shortcutLabels().keycaps(shortcut));
    }
  }
}
