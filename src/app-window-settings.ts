import type { AppWindowContext, AppWindowPage } from "./app-window-controls.js";
import { getRequiredElement } from "./overlay-dom.js";
import type { AppSettings } from "./shared.js";

export class SettingsPage implements AppWindowPage {
  private readonly startupCheckbox = getRequiredElement("startup-checkbox", HTMLInputElement);

  constructor(private readonly context: AppWindowContext) {}

  bind(): void {
    this.startupCheckbox.addEventListener("change", (): void => {
      void this.context.updateSettings({ launchAtStartup: this.startupCheckbox.checked });
    });
  }

  render(settings: AppSettings): void {
    this.startupCheckbox.checked = settings.launchAtStartup;
  }
}
