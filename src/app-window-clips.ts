import {
  type AppWindowContext,
  type AppWindowPage,
  microphoneOptions,
  runWithErrorToast,
  selectOption
} from "./app-window-controls.js";
import { ShortcutButton, shortcutKeycaps, shortcutText } from "./app-window-shortcut.js";
import { normalizeMicrophoneDeviceId } from "./audio-devices.js";
import { recordingAudioBitrate } from "./audio-quality.js";
import { getRequiredElement } from "./overlay-dom.js";
import type {
  AppSettings,
  ClipSettings,
  ClipSource,
  ClipSourceOptions,
  ClipsStatus,
  ClipWindowOption
} from "./shared.js";
import {
  clipDurationLabel,
  clipDurationOptionsSeconds,
  clipQualities,
  clipQualityDimensions,
  videoFpsOptions
} from "./shared.js";
import { getSoftshotApi } from "./softshot-api.js";
import { videoBitrate } from "./video-bitrate.js";

const primaryDisplayValue = "primary";
const savedWindowValue = "saved";
const windowOptionPrefix = "window:";
const bitsPerByte = 8;
const bytesPerMegabyte = 1_000_000;
const megabytesPerGigabyte = 1000;
const gigabyteDecimals = 1;
const clipFpsOptions = [videoFpsOptions.standard, videoFpsOptions.high] as const;

type ClipSourceKind = ClipSource["kind"];
type WindowClipSource = Extract<ClipSource, { kind: "window" }>;

export class ClipsPage implements AppWindowPage {
  private readonly directoryChangeButton = getRequiredElement("clips-directory-change", HTMLButtonElement);

  private readonly directoryOpenButton = getRequiredElement("clips-directory-open", HTMLButtonElement);

  private readonly directoryPath = getRequiredElement("clips-directory-path", HTMLSpanElement);

  private directorySetting: string | null = null;

  private readonly displayRow = getRequiredElement("clips-display-row", HTMLLabelElement);

  private readonly displaySelect = getRequiredElement("clips-display-select", HTMLSelectElement);

  private readonly durationHelp = getRequiredElement("clips-duration-help", HTMLButtonElement);

  private readonly durationSelect = getRequiredElement("clips-duration-select", HTMLSelectElement);

  private readonly enabledCheckbox = getRequiredElement("clips-enabled-checkbox", HTMLInputElement);

  private readonly enabledLabel = getRequiredElement("clips-enabled-label", HTMLSpanElement);

  private readonly fpsSelect = getRequiredElement("clips-fps-select", HTMLSelectElement);

  private hasLoadedDirectory = false;

  private isLoadingSources = false;

  private readonly microphoneSelect = getRequiredElement("clips-microphone-select", HTMLSelectElement);

  private pendingSourceKind: ClipSourceKind | null = null;

  private readonly qualitySelect = getRequiredElement("clips-quality-select", HTMLSelectElement);

  private readonly retryButton = getRequiredElement("clips-retry-button", HTMLButtonElement);

  private readonly saveButton = getRequiredElement("clips-save-button", HTMLButtonElement);

  private readonly savedToastCheckbox = getRequiredElement("clips-saved-toast-checkbox", HTMLInputElement);

  private readonly shortcutButton: ShortcutButton;

  private readonly sourceDisplayButton = getRequiredElement("clips-source-display", HTMLButtonElement);

  private sourceOptions: ClipSourceOptions | null = null;

  private readonly sourceWindowButton = getRequiredElement("clips-source-window", HTMLButtonElement);

  private status: ClipsStatus = { isShortcutAvailable: true, message: null, sourceName: null, state: "off" };

  private readonly statusCard = getRequiredElement("clips-status-card", HTMLDivElement);

  private readonly statusDetail = getRequiredElement("clips-status-detail", HTMLSpanElement);

  private readonly statusTitle = getRequiredElement("clips-status-title", HTMLSpanElement);

  private readonly systemAudioCheckbox = getRequiredElement("clips-system-audio-checkbox", HTMLInputElement);

  private readonly windowRefreshButton = getRequiredElement("clips-window-refresh", HTMLButtonElement);

  private readonly windowRow = getRequiredElement("clips-window-row", HTMLDivElement);

  private readonly windowSelect = getRequiredElement("clips-window-select", HTMLSelectElement);

  constructor(private readonly context: AppWindowContext) {
    this.shortcutButton = new ShortcutButton(
      getRequiredElement("clips-shortcut-button", HTMLButtonElement),
      getRequiredElement("clips-shortcut-status", HTMLSpanElement),
      "clips",
      (settings): void => {
        context.applySettings(settings);
      }
    );
  }

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
      const { value } = this.displaySelect;
      this.runTask(this.updateClips({
        source: { displayId: value === primaryDisplayValue ? null : Number(value), kind: "display" }
      }));
    });
    this.windowSelect.addEventListener("change", (): void => {
      this.selectWindow(this.windowSelect.value);
    });
    this.windowRefreshButton.addEventListener("click", (): void => {
      this.runTask(this.loadSourceOptions());
    });
  }

  private bindQualityEvents(): void {
    this.durationSelect.addEventListener("change", (): void => {
      this.runTask(this.updateClips({
        durationSeconds: optionFromValue(clipDurationOptionsSeconds, this.durationSelect.value)
      }));
    });
    this.qualitySelect.addEventListener("change", (): void => {
      this.runTask(this.updateClips({ quality: optionFromValue(clipQualities, this.qualitySelect.value) }));
    });
    this.fpsSelect.addEventListener("change", (): void => {
      this.runTask(this.updateClips({ fps: optionFromValue(clipFpsOptions, this.fpsSelect.value) }));
    });
  }

  private bindActionEvents(): void {
    const api = getSoftshotApi();
    this.enabledCheckbox.addEventListener("change", (): void => {
      this.runTask(this.updateClips({ enabled: this.enabledCheckbox.checked }));
    });
    this.savedToastCheckbox.addEventListener("change", (): void => {
      this.runTask(this.updateClips({ savedToastEnabled: this.savedToastCheckbox.checked }));
    });
    this.systemAudioCheckbox.addEventListener("change", (): void => {
      this.runTask(this.updateClips({ systemAudioEnabled: this.systemAudioCheckbox.checked }));
    });
    this.microphoneSelect.addEventListener("change", (): void => {
      this.runTask(this.updateClips({
        microphoneDeviceId: normalizeMicrophoneDeviceId(this.microphoneSelect.value)
      }));
    });
    this.directoryOpenButton.addEventListener("click", (): void => {
      this.runTask(api.openClipsDirectory());
    });
    this.directoryChangeButton.addEventListener("click", (): void => {
      this.runTask(this.chooseDirectory());
    });
    this.saveButton.addEventListener("click", (): void => {
      this.runTask(api.saveClip());
    });
    this.retryButton.addEventListener("click", (): void => {
      this.runTask(api.restartClips());
    });
  }

  private async chooseDirectory(): Promise<void> {
    const settings = await getSoftshotApi().chooseClipsDirectory();
    if (settings) {
      this.context.applySettings(settings);
    }
  }

  private async refreshDirectory(): Promise<void> {
    const directory = await getSoftshotApi().getClipsDirectory();
    this.directoryPath.textContent = directory;
    this.directoryPath.dataset.tooltip = directory;
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
    this.displayRow.hidden = kind !== "display";
    this.windowRow.hidden = kind !== "window";
    this.displaySelect.replaceChildren(...this.displayOptions(clips.source));
    this.windowSelect.replaceChildren(...this.windowOptions(clips.source));
    this.windowSelect.disabled = this.sourceOptions === null;
  }

  private displayOptions(source: ClipSource): HTMLOptionElement[] {
    const selectedDisplayId = source.kind === "display" ? source.displayId : null;
    const displays = this.sourceOptions?.displays ?? [];
    const options = [selectOption("Primary monitor", primaryDisplayValue, selectedDisplayId === null)];
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
      options.unshift(selectOption(`${savedWindow.title} (not open)`, savedWindowValue, true));
    }

    return options;
  }

  private renderQuality(clips: ClipSettings): void {
    this.durationSelect.replaceChildren(...clipDurationOptionsSeconds.map((durationSeconds) =>
      selectOption(clipDurationLabel(durationSeconds), String(durationSeconds), durationSeconds === clips.durationSeconds)
    ));
    this.qualitySelect.replaceChildren(...clipQualities.map((quality) =>
      selectOption(quality, quality, quality === clips.quality)
    ));
    this.fpsSelect.replaceChildren(...clipFpsOptions.map((fps) =>
      selectOption(`${String(fps)} FPS`, String(fps), fps === clips.fps)
    ));
    this.durationHelp.dataset.tooltip = memoryTooltip(clips);
  }

  private renderDirectory(clips: ClipSettings): void {
    if (this.hasLoadedDirectory && clips.directory === this.directorySetting) {
      return;
    }

    this.hasLoadedDirectory = true;
    this.directorySetting = clips.directory;
    this.runTask(this.refreshDirectory());
  }

  private renderStatus(): void {
    const { clips } = this.context.settings();
    const { status } = this;
    this.statusCard.dataset.state = status.state;
    this.saveButton.hidden = status.state !== "recording";
    this.retryButton.hidden = status.state !== "error";
    this.statusTitle.textContent = statusTitle(status);
    this.statusDetail.replaceChildren(...statusDetail(status, clips));
  }

  bind(): void {
    this.shortcutButton.bind();
    this.bindSourceEvents();
    this.bindQualityEvents();
    this.bindActionEvents();
  }

  async loadSourceOptions(): Promise<void> {
    if (this.isLoadingSources) {
      return;
    }

    this.isLoadingSources = true;
    this.windowRefreshButton.disabled = true;
    try {
      this.sourceOptions = await getSoftshotApi().listClipSources();
    } finally {
      this.isLoadingSources = false;
      this.windowRefreshButton.disabled = false;
    }

    this.render(this.context.settings());
  }

  render(settings: AppSettings): void {
    const { clips } = settings;
    this.enabledCheckbox.checked = clips.enabled;
    this.enabledLabel.textContent = clips.enabled ? "On" : "Off";
    this.renderSource(clips);
    this.renderQuality(clips);
    this.shortcutButton.render(clips.shortcut);
    this.savedToastCheckbox.checked = clips.savedToastEnabled;
    this.systemAudioCheckbox.checked = clips.systemAudioEnabled;
    this.microphoneSelect.replaceChildren(
      ...microphoneOptions(this.context.microphoneDevices(), clips.microphoneDeviceId)
    );
    this.renderDirectory(clips);
    this.renderStatus();
  }

  setStatus(status: ClipsStatus): void {
    this.status = status;
    this.renderStatus();
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
      return `Recording ${sourceName}`;
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

function statusDetail(status: ClipsStatus, clips: ClipSettings): Array<Node | string> {
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
        ? ["Press", shortcutKeycaps(clips.shortcut), `to save the last ${durationLabel}.`]
        : [`${shortcutText(clips.shortcut)} is used by another app. Pick a different shortcut below.`];
    }

    case "waiting": {
      return [clips.source.kind === "window"
        ? "Recording starts as soon as the app opens."
        : "Recording starts when the monitor is connected."];
    }

    case "error": {
      return [status.message ?? "Something went wrong.", "Try again, or change the source or quality."];
    }

    default: {
      throw new Error(`Unexpected clips state: ${String(status.state)}`);
    }
  }
}

function memoryTooltip(clips: ClipSettings): string {
  const dimensions = clipQualityDimensions[clips.quality];
  const bitsPerSecond = videoBitrate(dimensions.width, dimensions.height, clips.fps) + recordingAudioBitrate;
  const lines = clipDurationOptionsSeconds.map((durationSeconds) => {
    const megabytes = bitsPerSecond * durationSeconds / bitsPerByte / bytesPerMegabyte;
    return `${clipDurationLabel(durationSeconds)}: about ${memoryLabel(megabytes)}`;
  });
  return [`Memory used at ${clips.quality}, ${String(clips.fps)} FPS`, ...lines].join("\n");
}

function memoryLabel(megabytes: number): string {
  return megabytes < megabytesPerGigabyte
    ? `${String(Math.round(megabytes))} MB`
    : `${(megabytes / megabytesPerGigabyte).toFixed(gigabyteDecimals)} GB`;
}

function placeholderOption(label: string): HTMLOptionElement {
  const option = selectOption(label, "", true);
  option.disabled = true;
  return option;
}

function windowOption(window: ClipWindowOption, index: number, isSelected: boolean): HTMLOptionElement {
  const option = selectOption("", `${windowOptionPrefix}${String(index)}`, isSelected);
  option.label = window.title;
  if (window.iconDataUrl) {
    const icon = document.createElement("img");
    icon.className = "option-icon";
    icon.src = window.iconDataUrl;
    icon.alt = "";
    option.append(icon);
  }

  const label = document.createElement("span");
  label.className = "option-label";
  label.textContent = window.title;
  option.append(label);
  return option;
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

function optionFromValue<TOption extends number | string>(options: readonly TOption[], value: string): TOption {
  const index = options.findIndex((option) => String(option) === value);
  if (index === -1) {
    throw new Error(`Unknown option: ${value}`);
  }

  return options[index];
}
