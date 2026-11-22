import { type AppWindowContext, type AppWindowPage, runWithErrorToast } from "./app-window-controls.js";
import { getRequiredElement } from "./overlay-dom.js";
import type { AppSettings, AppUpdateStatus } from "./shared.js";
import { getSoftshotApi } from "./softshot-api.js";

const collapsedClassName = "sidebar-collapsed";

const updateLabels: Record<AppUpdateStatus["state"], string> = {
  downloading: "Downloading",
  none: "Update",
  ready: "Restart"
};

const updateTooltips: Record<AppUpdateStatus["state"], string> = {
  downloading: "Downloading the Softshot update",
  none: "",
  ready: "Restart Softshot to finish updating"
};

export class AppSidebar implements AppWindowPage {
  private readonly navItems = [...document.querySelectorAll<HTMLButtonElement>(".nav-item[data-page]")];

  private readonly toggleButton = getRequiredElement("sidebar-toggle", HTMLButtonElement);

  private readonly updateButton = getRequiredElement("app-update-button", HTMLButtonElement);

  private readonly updateLabel = getRequiredElement("app-update-label", HTMLSpanElement);

  private readonly version = getRequiredElement("app-version", HTMLSpanElement);

  constructor(private readonly context: AppWindowContext) {}

  private renderUpdate(status: AppUpdateStatus): void {
    this.updateButton.hidden = status.state === "none";
    this.updateButton.disabled = status.state === "downloading";
    this.updateButton.dataset.state = status.state;
    this.updateButton.dataset.tooltip = updateTooltips[status.state];
    this.updateLabel.textContent = status.state === "downloading"
      ? `${updateLabels.downloading} ${String(status.percent)}%`
      : updateLabels[status.state];
  }

  bind(): void {
    const api = getSoftshotApi();
    this.toggleButton.addEventListener("click", (): void => {
      void this.context.updateSettings({ sidebarCollapsed: !this.context.settings().sidebarCollapsed });
    });
    this.updateButton.addEventListener("click", (): void => {
      void runWithErrorToast(this.context, api.installUpdate());
    });
    api.onAppUpdateStatus((status): void => {
      this.renderUpdate(status);
    });
  }

  async loadAppInfo(): Promise<void> {
    const { update, version } = await getSoftshotApi().getAppInfo();
    this.version.textContent = `v${version}`;
    this.renderUpdate(update);
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
