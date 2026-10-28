import { type AppWindowContext, type AppWindowPage, runWithErrorToast } from "./app-window-controls.js";
import { getRequiredElement } from "./overlay-dom.js";
import type { AppSettings } from "./shared.js";
import { getSoftshotApi } from "./softshot-api.js";

const collapsedClassName = "sidebar-collapsed";

export class AppSidebar implements AppWindowPage {
  private readonly navItems = [...document.querySelectorAll<HTMLButtonElement>(".nav-item[data-page]")];

  private readonly toggleButton = getRequiredElement("sidebar-toggle", HTMLButtonElement);

  private readonly updateButton = getRequiredElement("app-update-button", HTMLButtonElement);

  private readonly version = getRequiredElement("app-version", HTMLSpanElement);

  constructor(private readonly context: AppWindowContext) {}

  bind(): void {
    const api = getSoftshotApi();
    this.toggleButton.addEventListener("click", (): void => {
      void this.context.updateSettings({ sidebarCollapsed: !this.context.settings().sidebarCollapsed });
    });
    this.updateButton.addEventListener("click", (): void => {
      void runWithErrorToast(this.context, api.installUpdate());
    });
    api.onAppUpdateReady((): void => {
      this.updateButton.hidden = false;
    });
  }

  async loadAppInfo(): Promise<void> {
    const { isUpdateReady, version } = await getSoftshotApi().getAppInfo();
    this.version.textContent = `v${version}`;
    this.updateButton.hidden = !isUpdateReady;
  }

  render(settings: AppSettings): void {
    const isCollapsed = settings.sidebarCollapsed;
    const toggleLabel = isCollapsed ? "Expand sidebar" : "Collapse sidebar";
    document.body.classList.toggle(collapsedClassName, isCollapsed);
    this.toggleButton.ariaExpanded = String(!isCollapsed);
    this.toggleButton.ariaLabel = toggleLabel;
    this.toggleButton.dataset.tooltip = toggleLabel;
    for (const item of this.navItems) {
      if (isCollapsed) {
        item.dataset.tooltip = item.textContent.trim();
      } else {
        delete item.dataset.tooltip;
      }
    }
  }
}
