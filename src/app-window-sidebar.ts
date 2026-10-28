import type { AppWindowContext, AppWindowPage } from "./app-window-controls.js";
import { getRequiredElement } from "./overlay-dom.js";
import type { AppSettings } from "./shared.js";

const collapsedClassName = "sidebar-collapsed";

export class AppSidebar implements AppWindowPage {
  private readonly navItems = [...document.querySelectorAll<HTMLButtonElement>(".nav-item[data-page]")];

  private readonly toggleButton = getRequiredElement("sidebar-toggle", HTMLButtonElement);

  constructor(private readonly context: AppWindowContext) {}

  bind(): void {
    this.toggleButton.addEventListener("click", (): void => {
      void this.context.updateSettings({ sidebarCollapsed: !this.context.settings().sidebarCollapsed });
    });
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
