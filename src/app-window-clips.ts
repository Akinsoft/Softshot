import {
  type AppWindowContext,
  type AppWindowPage,
  replaceSelectOptions,
  runWithErrorToast,
  selectOption
} from "./app-window-controls.js";
import { ShortcutButton } from "./app-window-shortcut.js";
import { getRequiredElement } from "./overlay-dom.js";
import type {
  AppSettings,
  ClipSettings,
  ClipSourceKind,
  ClipSourceOptions,
  ClipsStatus,
  ClipWindowOption,
  ClipWindowSelection
} from "./shared.js";
import { isClipSourceKind, lastClipDurationLabel } from "./shared.js";
import { getSoftshotApi } from "./softshot-api.js";

const savedWindowValue = "saved";
const windowOptionPrefix = "window:";

interface ShortcutHint {
  after: string;
  before: string;
}

export class ClipsPage implements AppWindowPage {
  private readonly control = getRequiredElement("clips-control", HTMLElement);

  private readonly displaySelect = getRequiredElement("clips-display-select", HTMLSelectElement);

  private readonly enabledCheckbox = getRequiredElement("clips-enabled-checkbox", HTMLInputElement);

  private readonly gameDetail = getRequiredElement("clips-game-detail", HTMLSpanElement);

  private isLoadingSources = false;

  private isSourceListStale = false;

  private pendingSourceKind: ClipSourceKind | null = null;

  private readonly page = getRequiredElement("clips-page", HTMLElement);

  private readonly retryButton = getRequiredElement("clips-retry-button", HTMLButtonElement);

  private readonly settingsButton = getRequiredElement("clips-settings-button", HTMLButtonElement);

  private readonly shortcutButton: ShortcutButton;

  private readonly shortcutHintAfter = getRequiredElement("clips-status-hint-after", HTMLSpanElement);

  private readonly shortcutHintBefore = getRequiredElement("clips-status-hint-before", HTMLSpanElement);

  private sourceOptions: ClipSourceOptions | null = null;

  private readonly sourcePanel = getRequiredElement("clips-control-source", HTMLDivElement);

  private readonly sourceKindSelect = getRequiredElement("clips-source-kind-select", HTMLSelectElement);

  private readonly sourceToggle = getRequiredElement("clips-source-toggle", HTMLButtonElement);

  private status: ClipsStatus = { isShortcutAvailable: true, message: null, sourceName: null, state: "off" };

  private readonly statusDetail = getRequiredElement("clips-status-detail", HTMLSpanElement);

  private readonly statusHint = getRequiredElement("clips-status-hint", HTMLSpanElement);

  private readonly statusIcon = getRequiredElement("clips-status-icon", HTMLImageElement);

  private readonly statusTitle = getRequiredElement("clips-status-title", HTMLSpanElement);

  private readonly windowSelect = getRequiredElement("clips-window-select", HTMLSelectElement);

  constructor(private readonly context: AppWindowContext) {
    this.shortcutButton = new ShortcutButton(
      getRequiredElement("clips-page-shortcut-button", HTMLButtonElement),
      getRequiredElement("clips-page-shortcut-status", HTMLSpanElement),
      "clips",
      context
    );
  }

  private async updateClips(update: Partial<ClipSettings>): Promise<void> {
    await this.context.updateSettings({ clips: update });
  }

  private runTask(task: Promise<void>): void {
    void runWithErrorToast(this.context, task);
  }

  private bindSourceEvents(): void {
    this.sourceToggle.addEventListener("click", (): void => {
      this.setSourcePanelExpanded(this.sourcePanel.hidden);
    });
    this.sourceKindSelect.addEventListener("change", (): void => {
      this.selectSourceKind(clipSourceKind(this.sourceKindSelect.value));
    });
    this.displaySelect.addEventListener("change", (): void => {
      this.runTask(this.updateClips({ displayId: Number(this.displaySelect.value), sourceKind: "display" }));
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

  private setSourcePanelExpanded(isExpanded: boolean): void {
    this.sourcePanel.hidden = !isExpanded;
    this.sourceToggle.ariaExpanded = String(isExpanded);
  }

  private selectSourceKind(kind: ClipSourceKind): void {
    const settings = this.context.settings();
    this.pendingSourceKind = null;
    if (kind === settings.clips.sourceKind) {
      this.render(settings);
      return;
    }

    if (kind !== "window" || settings.clips.window !== null) {
      this.runTask(this.updateClips({ sourceKind: kind }));
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
      sourceKind: "window",
      window: { processName: window.processName, title: window.title }
    }));
  }

  private renderSource(clips: ClipSettings): void {
    const kind = this.pendingSourceKind ?? clips.sourceKind;
    this.sourceKindSelect.value = kind;
    this.displaySelect.hidden = kind !== "display";
    this.windowSelect.hidden = kind !== "window";
    this.gameDetail.hidden = kind !== "game";
    replaceSelectOptions(this.displaySelect, this.displayOptions(clips.displayId));
    replaceSelectOptions(this.windowSelect, this.windowOptions(clips.window));
    this.windowSelect.disabled = this.sourceOptions === null;
  }

  private displayOptions(displayId: number | null): HTMLOptionElement[] {
    const displays = this.sourceOptions?.displays ?? [];
    const selectedDisplayId = displayId ?? displays.find((display) => display.isPrimary)?.id ?? null;
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

  private windowOptions(savedWindow: ClipWindowSelection | null): HTMLOptionElement[] {
    if (!this.sourceOptions) {
      return [placeholderOption("Loading apps…")];
    }

    const { windows } = this.sourceOptions;
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
    const { sourceKind, window } = this.context.settings().clips;
    if (this.status.state !== "recording" || !this.sourceOptions) {
      return null;
    }

    const { windows } = this.sourceOptions;
    if (sourceKind === "game") {
      return windows.find((candidate) => candidate.title === this.status.sourceName)?.iconDataUrl ?? null;
    }

    const index = sourceKind === "window" && window !== null ? savedWindowIndex(windows, window) : -1;
    return index === -1 ? null : windows[index].iconDataUrl;
  }

  private renderStatus(): void {
    const { clips } = this.context.settings();
    const { status } = this;
    const isRecording = status.state === "recording";
    const icon = this.recordingIcon();
    this.control.dataset.state = status.state;
    this.retryButton.hidden = status.state !== "error";
    this.statusIcon.hidden = icon === null;
    if (icon !== null) {
      this.statusIcon.src = icon;
    }

    this.statusTitle.textContent = statusTitle(status);
    this.statusDetail.replaceChildren(...(isRecording ? [] : statusDetail(status, clips)));
    this.statusHint.hidden = !isRecording;
    const hint = shortcutHint(status, clips);
    this.shortcutHintBefore.textContent = hint.before;
    this.shortcutHintAfter.textContent = hint.after;
  }

  bind(): void {
    this.shortcutButton.bind();
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
    this.shortcutButton.render(clips.shortcut);
    this.renderSource(clips);
    this.renderStatus();
  }

  setStatus(status: ClipsStatus): void {
    const wasRecording = this.status.state === "recording";
    this.status = status;
    this.renderStatus();
    if (!wasRecording && status.state === "recording" && this.sourceOptions !== null
      && this.context.settings().clips.sourceKind !== "display" && this.recordingIcon() === null) {
      this.runTask(this.loadSourceOptions());
    }
  }
}

function statusTitle(status: ClipsStatus): string {
  const sourceName = status.sourceName ?? "the selected source";
  switch (status.state) {
    case "off": {
      return "Clips are off";
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

function shortcutHint(status: ClipsStatus, clips: ClipSettings): ShortcutHint {
  return status.isShortcutAvailable
    ? { after: `to save the last ${lastClipDurationLabel(clips.durationSeconds)}.`, before: "Press" }
    : { after: "is used by another app. Click it to pick another.", before: "" };
}

function statusDetail(status: ClipsStatus, clips: ClipSettings): Array<Node | string> {
  switch (status.state) {
    case "off": {
      return [`Turn them on to keep the last ${lastClipDurationLabel(clips.durationSeconds)} ready to save.`];
    }

    case "starting":
    case "recording": {
      return [];
    }

    case "waiting": {
      return [waitingDetail(clips.sourceKind)];
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

function waitingDetail(sourceKind: ClipSourceKind): string {
  switch (sourceKind) {
    case "display": {
      return "Recording starts when the monitor is connected.";
    }

    case "game": {
      return "Recording starts as soon as you open a game.";
    }

    case "window": {
      return "Recording starts as soon as the app opens.";
    }

    default: {
      throw new Error(`Unexpected clip source: ${String(sourceKind)}`);
    }
  }
}

function clipSourceKind(value: string): ClipSourceKind {
  if (isClipSourceKind(value)) {
    return value;
  }

  throw new Error(`Unexpected clip source: ${value}`);
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

function savedWindowIndex(windows: readonly ClipWindowOption[], savedWindow: ClipWindowSelection): number {
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
