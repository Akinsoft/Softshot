import {
  type AppWindowContext,
  type AppWindowPage,
  runWithErrorToast,
  selectOption
} from "./app-window-controls.js";
import { ShortcutButton } from "./app-window-shortcut.js";
import { recordingAudioBitrate } from "./audio-quality.js";
import { getRequiredElement } from "./overlay-dom.js";
import type { AppSettings, ClipSettings } from "./shared.js";
import {
  clipDurationLabel,
  clipDurationOptionsSeconds,
  clipQualities,
  clipQualityDimensions,
  videoFpsOptions
} from "./shared.js";
import { getSoftshotApi } from "./softshot-api.js";
import { videoBitrate } from "./video-bitrate.js";

const bitsPerByte = 8;
const bytesPerMegabyte = 1_000_000;
const megabytesPerGigabyte = 1000;
const gigabyteDecimals = 1;
const clipFpsOptions = [videoFpsOptions.standard, videoFpsOptions.high] as const;

export class ClipSettingsSection implements AppWindowPage {
  private readonly directoryChangeButton = getRequiredElement("clips-directory-change", HTMLButtonElement);

  private readonly directoryOpenButton = getRequiredElement("clips-directory-open", HTMLButtonElement);

  private readonly directoryPath = getRequiredElement("clips-directory-path", HTMLSpanElement);

  private directorySetting: string | null = null;

  private readonly durationHelp = getRequiredElement("clips-duration-help", HTMLButtonElement);

  private readonly durationSelect = getRequiredElement("clips-duration-select", HTMLSelectElement);

  private readonly fpsSelect = getRequiredElement("clips-fps-select", HTMLSelectElement);

  private hasLoadedDirectory = false;

  private readonly qualitySelect = getRequiredElement("clips-quality-select", HTMLSelectElement);

  private readonly savedToastCheckbox = getRequiredElement("clips-saved-toast-checkbox", HTMLInputElement);

  private readonly shortcutButton: ShortcutButton;

  constructor(private readonly context: AppWindowContext) {
    this.shortcutButton = new ShortcutButton(
      getRequiredElement("clips-shortcut-button", HTMLButtonElement),
      getRequiredElement("clips-shortcut-status", HTMLSpanElement),
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

  private bindSavingEvents(): void {
    const api = getSoftshotApi();
    this.savedToastCheckbox.addEventListener("change", (): void => {
      this.runTask(this.updateClips({ savedToastEnabled: this.savedToastCheckbox.checked }));
    });
    this.directoryOpenButton.addEventListener("click", (): void => {
      this.runTask(api.openClipsDirectory());
    });
    this.directoryChangeButton.addEventListener("click", (): void => {
      this.runTask(this.chooseDirectory());
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

  bind(): void {
    this.shortcutButton.bind();
    this.bindQualityEvents();
    this.bindSavingEvents();
  }

  render(settings: AppSettings): void {
    const { clips } = settings;
    this.renderQuality(clips);
    this.shortcutButton.render(clips.shortcut);
    this.savedToastCheckbox.checked = clips.savedToastEnabled;
    this.renderDirectory(clips);
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

function optionFromValue<TOption extends number | string>(options: readonly TOption[], value: string): TOption {
  const index = options.findIndex((option) => String(option) === value);
  if (index === -1) {
    throw new Error(`Unknown option: ${value}`);
  }

  return options[index];
}
