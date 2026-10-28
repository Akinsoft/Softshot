import { CapturePage } from "./app-window-capture.js";
import { ClipsPage } from "./app-window-clips.js";
import { type AppWindowContext, runWithErrorToast } from "./app-window-controls.js";
import { GalleryPage } from "./app-window-gallery.js";
import { SettingsPage } from "./app-window-settings.js";
import { AppSidebar } from "./app-window-sidebar.js";
import { errorMessage } from "./async-errors.js";
import { audioInputDevices } from "./audio-devices.js";
import { getRequiredElement } from "./overlay-dom.js";
import type { AppPage, AppSettings, AppSettingsUpdate } from "./shared.js";
import { isAppPage } from "./shared.js";
import { getSoftshotApi } from "./softshot-api.js";
import { TooltipController } from "./ui-tooltip.js";

const toastDurationMs = 4200;
const mediaDeviceChangeEventName = "devicechange";
const defaultPage: AppPage = "clips";
const pageQueryName = "page";

class AppWindowController implements AppWindowContext {
  private readonly capturePage = new CapturePage(this);

  private readonly clipsPage = new ClipsPage(this);

  private readonly content = getRequiredElement("app-content", HTMLElement);

  private currentSettings: AppSettings | null = null;

  private devices: MediaDeviceInfo[] = [];

  private readonly galleryPage = new GalleryPage(this);

  private readonly navItems = [...document.querySelectorAll<HTMLButtonElement>(".nav-item[data-page]")];

  private readonly settingsPage = new SettingsPage(this);

  private readonly sidebar = new AppSidebar(this);

  private readonly toast = getRequiredElement("app-toast", HTMLDivElement);

  private toastTimeout: ReturnType<typeof setTimeout> | null = null;

  private readonly tooltips = new TooltipController(document.body);

  private renderPages(): void {
    const settings = this.settings();
    for (const page of [this.sidebar, this.capturePage, this.clipsPage, this.galleryPage, this.settingsPage]) {
      page.render(settings);
    }
  }

  private showPage(page: AppPage): void {
    for (const section of document.querySelectorAll<HTMLElement>(".app-page")) {
      section.hidden = section.dataset.page !== page;
    }

    for (const item of this.navItems) {
      item.ariaCurrent = item.dataset.page === page ? "page" : null;
    }

    this.content.scrollTop = 0;
    if (page === "gallery") {
      void this.galleryPage.refresh();
    }
  }

  private showToast(message: string, isError: boolean): void {
    if (this.toastTimeout !== null) {
      clearTimeout(this.toastTimeout);
    }

    this.toast.textContent = message;
    this.toast.classList.toggle("error", isError);
    this.toast.hidden = false;
    this.toastTimeout = setTimeout((): void => {
      this.toastTimeout = null;
      this.toast.hidden = true;
    }, toastDurationMs);
  }

  private async refreshMicrophoneDevices(): Promise<void> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    this.devices = audioInputDevices(devices);
  }

  private async refreshMicrophoneOptions(): Promise<void> {
    await this.refreshMicrophoneDevices();
    this.renderPages();
  }

  private bindEvents(): void {
    const api = getSoftshotApi();
    for (const item of this.navItems) {
      item.addEventListener("click", (): void => {
        const { page } = item.dataset;
        if (isAppPage(page)) {
          this.showPage(page);
        }
      });
    }

    api.onSettingsChanged((settings): void => {
      this.applySettings(settings);
    });
    api.onClipsStatusChanged((status): void => {
      this.clipsPage.setStatus(status);
    });
    api.onClipsLibraryChanged((): void => {
      void this.galleryPage.refresh();
    });
    api.onAppNavigate((page): void => {
      this.showPage(page);
    });
    navigator.mediaDevices.addEventListener(mediaDeviceChangeEventName, (): void => {
      void runWithErrorToast(this, this.refreshMicrophoneOptions());
    });
  }

  applySettings(settings: AppSettings): void {
    this.currentSettings = settings;
    this.renderPages();
  }

  microphoneDevices(): MediaDeviceInfo[] {
    return this.devices;
  }

  navigate(page: AppPage): void {
    this.showPage(page);
  }

  settings(): AppSettings {
    if (!this.currentSettings) {
      throw new Error("Softshot settings have not loaded.");
    }

    return this.currentSettings;
  }

  showError(error: unknown): void {
    this.showToast(errorMessage(error), true);
  }

  showMessage(message: string): void {
    this.showToast(message, false);
  }

  async updateSettings(update: AppSettingsUpdate): Promise<void> {
    try {
      this.applySettings(await getSoftshotApi().updateSettings(update));
    } catch (error) {
      this.showError(error);
      this.renderPages();
    }
  }

  async start(): Promise<void> {
    const api = getSoftshotApi();
    this.tooltips.bind();
    this.currentSettings = await api.getSettings();
    await this.refreshMicrophoneDevices();
    this.sidebar.bind();
    this.capturePage.bind();
    this.clipsPage.bind();
    this.galleryPage.bind();
    this.settingsPage.bind();
    this.bindEvents();
    this.renderPages();
    this.clipsPage.setStatus(await api.getClipsStatus());
    await this.sidebar.loadAppInfo();
    const requestedPage = new URLSearchParams(location.search).get(pageQueryName);
    this.showPage(isAppPage(requestedPage) ? requestedPage : defaultPage);
    await api.appReadyToShow();
    void runWithErrorToast(this, this.clipsPage.loadSourceOptions());
    void this.galleryPage.refresh();
  }
}

void new AppWindowController().start().catch(async (error: unknown): Promise<void> => {
  await getSoftshotApi().showError(`Softshot could not open.\n\n${errorMessage(error)}`);
});
