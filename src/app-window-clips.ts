import {
  type AppWindowContext,
  type AppWindowPage,
  replaceSelectOptions,
  runWithErrorToast,
  selectOption
} from "./app-window-controls.js";
import type { ShortcutLabels } from "./app-window-shortcut-labels.js";
import { getRequiredElement } from "./overlay-dom.js";
import type {
  AppSettings,
  ClipSettings,
  ClipSource,
  ClipSourceOptions,
  ClipsStatus,
  ClipWindowOption
} from "./shared.js";
import { clipDurationLabel } from "./shared.js";
import { getSoftshotApi } from "./softshot-api.js";

const savedWindowValue = "saved";
const windowOptionPrefix = "window:";

type ClipSourceKind = ClipSource["kind"];
type WindowClipSource = Extract<ClipSource, { kind: "window" }>;

export class ClipsPage implements AppWindowPage {
  private readonly control = getRequiredElement("clips-control", HTMLElement);

  private readonly displaySelect = getRequiredElement("clips-display-select", HTMLSelectElement);

  private readonly enabledCheckbox = getRequiredElement("clips-enabled-checkbox", HTMLInputElement);

  private isLoadingSources = false;

  private isSourceListStale = false;

  private pendingSourceKind: ClipSourceKind | null = null;

  private readonly page = getRequiredElement("clips-page", HTMLElement);

  private readonly retryButton = getRequiredElement("clips-retry-button", HTMLButtonElement);

  private readonly settingsButton = getRequiredElement("clips-settings-button", HTMLButtonElement);

  private readonly sourceDisplayButton = getRequiredElement("clips-source-display", HTMLButtonElement);

  private sourceOptions: ClipSourceOptions | null = null;

  private readonly sourceWindowButton = getRequiredElement("clips-source-window", HTMLButtonElement);

  private status: ClipsStatus = { isShortcutAvailable: true, message: null, sourceName: null, state: "off" };

  private readonly statusDetail = getRequiredElement("clips-status-detail", HTMLSpanElement);

  private readonly statusHint = getRequiredElement("clips-status-hint", HTMLSpanElement);

  private readonly statusIcon = getRequiredElement("clips-status-icon", HTMLImageElement);

  private readonly statusTitle = getRequiredElement("clips-status-title", HTMLSpanElement);

  private readonly windowSelect = getRequiredElement("clips-window-select", HTMLSelectElement);

  constructor(private readonly context: AppWindowContext) {}

  private async updateClips(update: Partial<ClipSettings>): Promise<void> {
    await this.context.updateSettings({ clips: update });
  }

  private runTask(task: Promise<void>): void {
    void runWithErrorToast(this.context, task);
  }

  private bindSourceEvents(): void {
    this.sourceDisplayButton.addEventListener("click", (): void => {
      this.selectSourceKind("display");
    });
    this.sourceWindowButton.addEventListener("click", (): void => {
      this.selectSourceKind("window");
    });
    this.displaySelect.addEventListener("change", (): void => {
      this.runTask(this.updateClips({ source: { displayId: Number(this.displaySelect.value), kind: "display" } }));
    });
    this.windowSelect.addEventListener("change", (): void => {
      this.selectWindow(this.windowSelect.value);
    });
    window.addEventListener("blur", (): void => {
      this.isSourceListStale = true;
    });
    window.addEventListener("focus", (): void => {
      if (this.isSourceListStale && !this.page.hidden) {
        this.runTask(this.loadSourceOptions());
      }
    });
  }

  private bindActionEvents(): void {
    this.enabledCheckbox.addEventListener("change", (): void => {
      this.runTask(this.updateClips({ enabled: this.enabledCheckbox.checked }));
    });
    this.retryButton.addEventListener("click", (): void => {
      this.runTask(getSoftshotApi().restartClips());
    });
    this.settingsButton.addEventListener("click", (): void => {
      this.context.navigate("settings");
    });
  }

  private selectSourceKind(kind: ClipSourceKind): void {
    const settings = this.context.settings();
    this.pendingSourceKind = null;
    if (kind === settings.clips.source.kind) {
      this.render(settings);
      return;
    }

    if (kind === "display") {
      this.runTask(this.updateClips({ source: { displayId: null, kind: "display" } }));
      return;
    }

    this.pendingSourceKind = "window";
    this.render(settings);
    if (!this.sourceOptions) {
      this.runTask(this.loadSourceOptions());
    }
  }

  private selectWindow(value: string): void {
    if (!value.startsWith(windowOptionPrefix)) {
      return;
    }

    const window = this.sourceOptions?.windows.at(Number(value.slice(windowOptionPrefix.length)));
    if (!window) {
      return;
    }

    this.pendingSourceKind = null;
    this.runTask(this.updateClips({
      source: { kind: "window", processName: window.processName, title: window.title }
    }));
  }

  private renderSource(clips: ClipSettings): void {
    const kind = this.pendingSourceKind ?? clips.source.kind;
    this.sourceDisplayButton.setAttribute("aria-checked", String(kind === "display"));
    this.sourceWindowButton.setAttribute("aria-checked", String(kind === "window"));
    this.displaySelect.hidden = kind !== "display";
    this.windowSelect.hidden = kind !== "window";
    replaceSelectOptions(this.displaySelect, this.displayOptions(clips.source));
    replaceSelectOptions(this.windowSelect, this.windowOptions(clips.source));
    this.windowSelect.disabled = this.sourceOptions === null;
  }

  private displayOptions(source: ClipSource): HTMLOptionElement[] {
    const displays = this.sourceOptions?.displays ?? [];
    const selectedDisplayId = source.kind === "display"
      ? source.displayId ?? displays.find((display) => display.isPrimary)?.id ?? null
      : null;
    const options: HTMLOptionElement[] = [];
    if (selectedDisplayId !== null && displays.every((display) => display.id !== selectedDisplayId)) {
      options.push(selectOption("Disconnected monitor", String(selectedDisplayId), true));
    }

    for (const display of displays) {
      const details = `${String(display.width)} × ${String(display.height)}${display.isPrimary ? ", primary" : ""}`;
      options.push(selectOption(`${display.label} (${details})`, String(display.id), display.id === selectedDisplayId));
    }

    return options;
  }

  private windowOptions(source: ClipSource): HTMLOptionElement[] {
    if (!this.sourceOptions) {
      return [placeholderOption("Loading apps…")];
    }

    const { windows } = this.sourceOptions;
    const savedWindow = source.kind === "window" ? source : null;
    if (!savedWindow) {
      return [placeholderOption("Choose an app"), ...windows.map((window, index) => windowOption(window, index, false))];
    }

    const selectedIndex = savedWindowIndex(windows, savedWindow);
    const options = windows.map((window, index) => windowOption(window, index, index === selectedIndex));
    if (selectedIndex === -1) {
      options.unshift(appOption(`${savedWindow.title} (not open)`, null, savedWindowValue, true));
    }

    return options;
  }

  private recordingIcon(): string | null {
    const { source } = this.context.settings().clips;
    if (this.status.state !== "recording" || source.kind !== "window" || !this.sourceOptions) {
      return null;
    }

    const { windows } = this.sourceOptions;
    const index = savedWindowIndex(windows, source);
    return index === -1 ? null : windows[index].iconDataUrl;
  }

  private renderStatus(): void {
    const { clips } = this.context.settings();
    const { status } = this;
    const isRecording = status.state === "recording";
    const detail = statusDetail(status, clips, this.context.shortcutLabels());
    const icon = this.recordingIcon();
    this.control.dataset.state = status.state;
    this.retryButton.hidden = status.state !== "error";
    this.statusIcon.hidden = icon === null;
    if (icon !== null) {
      this.statusIcon.src = icon;
    }

    this.statusTitle.textContent = statusTitle(status);
    this.statusDetail.replaceChildren(...(isRecording ? [] : detail));
    this.statusHint.replaceChildren(...(isRecording ? detail : []));
  }

  bind(): void {
    this.bindSourceEvents();
    this.bindActionEvents();
  }

  async loadSourceOptions(): Promise<void> {
    if (this.isLoadingSources) {
      return;
    }

    this.isLoadingSources = true;
    this.isSourceListStale = false;
    try {
      this.sourceOptions = await getSoftshotApi().listClipSources();
    } finally {
      this.isLoadingSources = false;
    }

    this.render(this.context.settings());
  }

  render(settings: AppSettings): void {
    const { clips } = settings;
    this.enabledCheckbox.checked = clips.enabled;
    this.renderSource(clips);
    this.renderStatus();
  }

  setStatus(status: ClipsStatus): void {
    const wasRecording = this.status.state === "recording";
    this.status = status;
    this.renderStatus();
    if (!wasRecording && status.state === "recording" && this.sourceOptions !== null
      && this.context.settings().clips.source.kind === "window" && this.recordingIcon() === null) {
      this.runTask(this.loadSourceOptions());
    }
  }
}

function statusTitle(status: ClipsStatus): string {
  const sourceName = status.sourceName ?? "the selected source";
  switch (status.state) {
    case "off": {
      return "Clips is off";
    }

    case "starting": {
      return `Starting ${sourceName}`;
    }

    case "recording": {
      return `${sourceName} is being recorded`;
    }

    case "waiting": {
      return `Waiting for ${sourceName}`;
    }

    case "error": {
      return "Clips stopped";
    }

    default: {
      throw new Error(`Unexpected clips state: ${String(status.state)}`);
    }
  }
}

function statusDetail(status: ClipsStatus, clips: ClipSettings, shortcutLabels: ShortcutLabels): Array<Node | string> {
  const durationLabel = clipDurationLabel(clips.durationSeconds);
  switch (status.state) {
    case "off": {
      return [`Turn it on to keep the last ${durationLabel} ready to save.`];
    }

    case "starting": {
      return [clips.source.kind === "window"
        ? "Recording begins once the app draws something. If it is minimized, open it."
        : "Recording begins once something on the monitor changes."];
    }

    case "recording": {
      return status.isShortcutAvailable
        ? ["Press", shortcutLabels.keycaps(clips.shortcut), `to save the last ${durationLabel}.`]
        : [`${shortcutLabels.text(clips.shortcut)} is used by another app. Pick a different shortcut in Settings.`];
    }

    case "waiting": {
      return [clips.source.kind === "window"
        ? "Recording starts as soon as the app opens."
        : "Recording starts when the monitor is connected."];
    }

    case "error": {
      const message = document.createElement("span");
      message.textContent = status.message ?? "Something went wrong.";
      return [message, "Try again, or change the source or clip quality."];
    }

    default: {
      throw new Error(`Unexpected clips state: ${String(status.state)}`);
    }
  }
}

function placeholderOption(label: string): HTMLOptionElement {
  const option = selectOption(label, "", true);
  option.disabled = true;
  return option;
}

function windowOption(window: ClipWindowOption, index: number, isSelected: boolean): HTMLOptionElement {
  return appOption(window.title, window.iconDataUrl, `${windowOptionPrefix}${String(index)}`, isSelected);
}

function appOption(title: string, iconDataUrl: string | null, value: string, isSelected: boolean): HTMLOptionElement {
  const option = selectOption("", value, isSelected);
  const label = document.createElement("span");
  label.className = "option-label";
  label.textContent = title;
  option.append(appIcon(iconDataUrl), label);
  return option;
}

function appIcon(iconDataUrl: string | null): HTMLElement {
  if (iconDataUrl === null) {
    const placeholder = document.createElement("span");
    placeholder.className = "option-icon option-icon-placeholder";
    placeholder.ariaHidden = "true";
    return placeholder;
  }

  const icon = document.createElement("img");
  icon.className = "option-icon";
  icon.src = iconDataUrl;
  icon.alt = "";
  return icon;
}

function savedWindowIndex(windows: readonly ClipWindowOption[], savedWindow: WindowClipSource): number {
  if (savedWindow.processName === null) {
    return windows.findIndex((window) => window.title === savedWindow.title);
  }

  const exactIndex = windows.findIndex((window) =>
    window.processName === savedWindow.processName && window.title === savedWindow.title
  );
  return exactIndex === -1
    ? windows.findIndex((window) => window.processName === savedWindow.processName)
    : exactIndex;
}
