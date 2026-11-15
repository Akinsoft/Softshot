import { CapturePage } from "./app-window-capture.js";
import { ClipLibrary } from "./app-window-clip-library.js";
import { ClipSettingsSection } from "./app-window-clip-settings.js";
import { ClipStore } from "./app-window-clip-store.js";
import { ClipsPage } from "./app-window-clips.js";
import { type AppWindowContext, runWithErrorToast } from "./app-window-controls.js";
import { EditorView } from "./app-window-editor.js";
import { EditorShortcutsSection } from "./app-window-editor-shortcuts.js";
import { RecentClips } from "./app-window-recent-clips.js";
import { SettingsPage } from "./app-window-settings.js";
import { ShortcutLabels } from "./app-window-shortcut-labels.js";
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
  private readonly clipStore = new ClipStore((): void => {
    this.clipLibrary.renderClips();
    this.recentClips.renderClips();
  });

  private readonly capturePage = new CapturePage(this);

  private readonly clipLibrary = new ClipLibrary(this, this.clipStore);

  private readonly clipSettings = new ClipSettingsSection(this);

  private readonly clipsPage = new ClipsPage(this);

  private readonly content = getRequiredElement("app-content", HTMLElement);

  private currentPage: AppPage = defaultPage;

  private currentSettings: AppSettings | null = null;

  private currentShortcutLabels: ShortcutLabels | null = null;

  private devices: MediaDeviceInfo[] = [];

  private readonly editorShortcuts = new EditorShortcutsSection(this);

  private readonly editorView = new EditorView({
    backRequested: (): void => {
      this.navigate(this.currentPage);
    },
    editorClosed: (): void => {
      this.showPage(this.currentPage);
    },
    editorShown: (): void => {
      this.showEditorPage();
    },
    shortcutLabels: (): ShortcutLabels => this.shortcutLabels()
  });

  private readonly navItems = [...document.querySelectorAll<HTMLButtonElement>(".nav-item[data-page]")];

  private readonly recentClips = new RecentClips(this, this.clipStore);

  private readonly settingsPage = new SettingsPage(this);

  private readonly sidebar = new AppSidebar(this);

  private readonly toast = getRequiredElement("app-toast", HTMLDivElement);

  private toastTimeout: ReturnType<typeof setTimeout> | null = null;

  private readonly tooltips = new TooltipController(document.body);

  private renderPages(): void {
    const settings = this.settings();
    const pages = [
      this.sidebar,
      this.capturePage,
      this.clipsPage,
      this.clipLibrary,
      this.recentClips,
      this.settingsPage,
      this.clipSettings,
      this.editorShortcuts
    ];
    for (const page of pages) {
      page.render(settings);
    }
  }

  private showSection(visibleSection: HTMLElement, currentNavPage: AppPage | null): void {
    for (const section of document.querySelectorAll<HTMLElement>(".app-page")) {
      section.hidden = section !== visibleSection;
    }

    for (const item of this.navItems) {
      item.ariaCurrent = currentNavPage !== null && item.dataset.page === currentNavPage ? "page" : null;
    }

    this.clipLibrary.stopPreview();
    this.content.scrollTop = 0;
  }

  private showPage(page: AppPage): void {
    this.currentPage = page;
    this.showSection(getRequiredElement(`${page}-page`, HTMLElement), page);
    if (page === "clips") {
      void runWithErrorToast(this, this.clipsPage.loadSourceOptions());
      void this.refreshClips();
    }
  }

  private showEditorPage(): void {
    this.showSection(getRequiredElement("editor-page", HTMLElement), null);
  }

  private async openPage(page: AppPage): Promise<void> {
    if (await this.editorView.close()) {
      this.showPage(page);
    }
  }

  private async refreshClips(): Promise<void> {
    await runWithErrorToast(this, this.clipStore.refresh());
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
          this.navigate(page);
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
      void this.refreshClips();
    });
    api.onAppNavigate((page): void => {
      this.navigate(page);
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
    void runWithErrorToast(this, this.openPage(page));
  }

  settings(): AppSettings {
    if (!this.currentSettings) {
      throw new Error("Softshot settings have not loaded.");
    }

    return this.currentSettings;
  }

  shortcutLabels(): ShortcutLabels {
    if (!this.currentShortcutLabels) {
      throw new Error("Shortcut key names have not loaded.");
    }

    return this.currentShortcutLabels;
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
    this.currentShortcutLabels = new ShortcutLabels(await api.getKeyLabels());
    await this.refreshMicrophoneDevices();
    this.sidebar.bind();
    this.capturePage.bind();
    this.clipsPage.bind();
    this.clipLibrary.bind();
    this.recentClips.bind();
    this.clipSettings.bind();
    this.settingsPage.bind();
    this.editorShortcuts.bind();
    this.editorView.bind();
    this.bindEvents();
    this.renderPages();
    this.clipsPage.setStatus(await api.getClipsStatus());
    await this.sidebar.loadAppInfo();
    const requestedPage = new URLSearchParams(location.search).get(pageQueryName);
    const startPage = isAppPage(requestedPage) ? requestedPage : defaultPage;
    this.showPage(startPage);
    if (startPage !== "clips") {
      void this.refreshClips();
    }

    await this.editorView.showCurrentSession();
    await api.appReadyToShow();
  }
}

void new AppWindowController().start().catch(async (error: unknown): Promise<void> => {
  await getSoftshotApi().showError(`Softshot could not open.\n\n${errorMessage(error)}`);
});
