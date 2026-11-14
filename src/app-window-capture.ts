import type { AppWindowContext, AppWindowPage } from "./app-window-controls.js";
import { ShortcutButton } from "./app-window-shortcut.js";
import { getRequiredElement } from "./overlay-dom.js";
import type { AppSettings } from "./shared.js";

export class CapturePage implements AppWindowPage {
  private readonly shortcutButton: ShortcutButton;

  constructor(context: AppWindowContext) {
    this.shortcutButton = new ShortcutButton(
      getRequiredElement("capture-shortcut-button", HTMLButtonElement),
      getRequiredElement("capture-shortcut-status", HTMLSpanElement),
      "capture",
      context
    );
  }

  bind(): void {
    this.shortcutButton.bind();
  }

  render(settings: AppSettings): void {
    this.shortcutButton.render(settings.captureShortcut);
  }
}
