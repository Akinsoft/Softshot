import type { ExportOptions } from "./editor-export.js";
import { supportedVideoEncoderAcceleration } from "./editor-export.js";
import {
  areExportSettingsEqual,
  exportAudioBitrates,
  exportFileSizeOptionsMegabytes,
  type ExportFormat,
  exportFormatKind,
  exportFormatLabel,
  exportFormats,
  exportGifFpsOptions,
  type ExportPlan,
  type ExportPlanResult,
  type ExportPreset,
  type ExportPresetGroup,
  exportPresets,
  exportQualities,
  exportQualityLabel,
  exportResolutionLabel,
  exportResolutions,
  type ExportSettings,
  type ExportSource,
  type ExportVideoCodec,
  exportVideoCodecLabel,
  exportVideoCodecs,
  exportVideoCodecsForFormat,
  exportVideoFpsOptions,
  formatFps,
  resolveExportPlan,
  settingsForFormat} from "./editor-export-settings.js";
import { getRequiredElement } from "./overlay-dom.js";
import type { CompletedOutputFile } from "./shared.js";
import { getSoftshotApi, reportAsyncError } from "./softshot-api.js";

const sourceOptionValue = "source";
const noLimitOptionValue = "none";
const audioOffOptionValue = "off";
const destinationInputSelector = "input[name=\"export-destination\"]";
const presetButtonSelector = "button[data-preset-id]";
const bytesPerKilobyte = 1000;
const bytesPerMegabyte = 1_000_000;
const largeFileMegabytes = 10;
const bitsPerKilobit = 1000;
const percentScale = 100;
const millisecondsPerSecond = 1000;
const secondsPerMinute = 60;
const secondsTextLength = 2;
const minimumProgressForEstimate = 0.03;
const exportDoneStatus = "Exported";
const copyDoneStatus = "Copied";
const presetGroupIcons: Record<ExportPresetGroup, string> = {
  Discord: "discord",
  General: "general",
  Other: "other",
  X: "x",
  YouTube: "youtube"
};

export interface ExportPanelHost {
  exportFile(plan: ExportPlan, options: ExportOptions): Promise<CompletedOutputFile>;
  exportSource(): ExportSource;
  setBusy(isBusy: boolean): void;
  showStatus(message: string): void;
}

interface SelectOption {
  isDisabled?: boolean;
  label: string;
  value: string;
}

type ExportDestination = "clipboard" | "file";

interface PanelMessage {
  kind: "issue" | "note";
  text: string;
}

export class ExportPanel {
  private readonly dialog = getRequiredElement("export-dialog", HTMLDialogElement);
  private readonly closeButton = getRequiredElement("export-close-button", HTMLButtonElement);
  private readonly cancelButton = getRequiredElement("export-cancel-button", HTMLButtonElement);
  private readonly startButton = getRequiredElement("export-start-button", HTMLButtonElement);
  private readonly presetList = getRequiredElement("export-preset-list", HTMLElement);
  private readonly presetName = getRequiredElement("export-preset-name", HTMLSpanElement);
  private readonly presetDescription = getRequiredElement("export-preset-description", HTMLSpanElement);
  private readonly formatSelect = getRequiredElement("export-format-select", HTMLSelectElement);
  private readonly codecField = getRequiredElement("export-codec-field", HTMLLabelElement);
  private readonly codecSelect = getRequiredElement("export-codec-select", HTMLSelectElement);
  private readonly resolutionField = getRequiredElement("export-resolution-field", HTMLLabelElement);
  private readonly resolutionSelect = getRequiredElement("export-resolution-select", HTMLSelectElement);
  private readonly fpsField = getRequiredElement("export-fps-field", HTMLLabelElement);
  private readonly fpsSelect = getRequiredElement("export-fps-select", HTMLSelectElement);
  private readonly qualityField = getRequiredElement("export-quality-field", HTMLLabelElement);
  private readonly qualitySelect = getRequiredElement("export-quality-select", HTMLSelectElement);
  private readonly sizeField = getRequiredElement("export-size-field", HTMLLabelElement);
  private readonly sizeSelect = getRequiredElement("export-size-select", HTMLSelectElement);
  private readonly audioField = getRequiredElement("export-audio-field", HTMLLabelElement);
  private readonly audioSelect = getRequiredElement("export-audio-select", HTMLSelectElement);
  private readonly upscaleField = getRequiredElement("export-upscale-field", HTMLLabelElement);
  private readonly upscaleCheckbox = getRequiredElement("export-upscale-checkbox", HTMLInputElement);
  private readonly messagesList = getRequiredElement("export-messages", HTMLUListElement);
  private readonly summary = getRequiredElement("export-summary", HTMLDivElement);
  private readonly progress = getRequiredElement("export-progress", HTMLDivElement);
  private readonly progressBar = getRequiredElement("export-progress-bar", HTMLSpanElement);
  private readonly progressText = getRequiredElement("export-progress-text", HTMLSpanElement);
  private abortController: AbortController | null = null;
  private basePreset: ExportPreset | null = null;
  private codecSupportKey = "";
  private codecSupportToken = 0;
  private completionMessage: string | null = null;
  private exportStartedAt = 0;
  private planResult: ExportPlanResult | null = null;
  private presets: ExportPreset[] = [];
  private settings: ExportSettings | null = null;
  private source: ExportSource | null = null;
  private readonly unsupportedCodecs = new Set<ExportVideoCodec>();

  constructor(private readonly host: ExportPanelHost) {}

  private get isExporting(): boolean {
    return this.abortController !== null;
  }

  private closeOrCancel(): void {
    if (this.abortController) {
      this.abortController.abort();
      return;
    }

    this.dialog.close();
  }

  private selectPreset(preset: ExportPreset): void {
    this.basePreset = preset;
    this.settings = { ...preset.settings };
    this.completionMessage = null;
    this.render();
  }

  private updateSettings(update: (settings: ExportSettings) => ExportSettings): void {
    if (!this.settings) {
      throw new Error("Export settings are not ready.");
    }

    this.settings = update(this.settings);
    this.completionMessage = null;
    this.render();
  }

  private render(): void {
    const { basePreset, settings, source } = this;
    if (!basePreset || !settings || !source) {
      throw new Error("The export panel is not ready.");
    }

    this.planResult = resolveExportPlan(settings, source);
    const isCustom = !areExportSettingsEqual(settings, basePreset.settings);
    this.presetName.textContent = isCustom ? "Custom" : basePreset.label;
    this.presetDescription.textContent = isCustom ? `Based on ${basePreset.label}` : basePreset.description;
    for (const button of this.presetList.querySelectorAll<HTMLButtonElement>(presetButtonSelector)) {
      const isSelected = button.dataset.presetId === basePreset.id;
      button.setAttribute("aria-pressed", String(isSelected));
      button.classList.toggle("custom", isSelected && isCustom);
    }

    this.renderFields(settings, source);
    this.renderMessages(basePreset, source);
    this.renderSummary(settings, this.planResult);
    this.syncActionStates();
    void reportAsyncError(this.refreshCodecSupport(settings, this.planResult), "Could not check video encoder support.");
  }

  private renderPresetList(): void {
    const groups = new Map<ExportPresetGroup, ExportPreset[]>();
    for (const preset of this.presets) {
      const groupPresets = groups.get(preset.group) ?? [];
      groupPresets.push(preset);
      groups.set(preset.group, groupPresets);
    }

    this.presetList.replaceChildren(...[...groups].map(([group, presets]) => {
      const section = document.createElement("div");
      section.className = "export-preset-group";
      const heading = document.createElement("span");
      heading.className = "export-preset-group-label";
      const icon = document.createElement("img");
      icon.className = "export-preset-group-icon";
      icon.src = `./assets/icons/${presetGroupIcons[group]}.svg`;
      icon.alt = "";
      icon.draggable = false;
      heading.append(icon, group);
      section.append(heading, ...presets.map((preset) => presetButtonElement(preset)));
      return section;
    }));
  }

  private renderFields(settings: ExportSettings, source: ExportSource): void {
    const kind = exportFormatKind(settings.format);
    const isVideo = kind === "video";
    const hasPicture = kind !== "audio";
    renderSelect(this.formatSelect, exportFormats.map((format) => ({ label: exportFormatLabel(format), value: format })), settings.format);
    this.codecField.hidden = !isVideo;
    this.resolutionField.hidden = !hasPicture;
    this.fpsField.hidden = !hasPicture;
    this.qualityField.hidden = !hasPicture;
    this.upscaleField.hidden = !hasPicture;
    this.upscaleCheckbox.checked = settings.upscale;
    this.sizeField.hidden = !isVideo;
    this.audioField.hidden = settings.format === "gif" || settings.format === "wav";
    if (isVideo) {
      renderSelect(this.codecSelect, exportVideoCodecsForFormat(settings.format).map((codec) => {
        const isUnsupported = this.unsupportedCodecs.has(codec);
        return {
          isDisabled: isUnsupported && codec !== settings.videoCodec,
          label: isUnsupported ? `${exportVideoCodecLabel(codec)} (not supported on this PC)` : exportVideoCodecLabel(codec),
          value: codec
        };
      }), settings.videoCodec);
      const sizeValue = optionValue(settings.maxFileSizeMegabytes, noLimitOptionValue);
      renderSelect(this.sizeSelect, fileSizeOptions(settings.maxFileSizeMegabytes), sizeValue);
    }

    if (hasPicture) {
      renderSelect(this.resolutionSelect, exportResolutions.map((resolution) => ({
        label: resolution === "source"
          ? `Source (${String(source.width)}×${String(source.height)})`
          : exportResolutionLabel(resolution),
        value: resolution
      })), settings.resolution);
      renderSelect(this.fpsSelect, fpsOptions(kind === "gif", source.fps), optionValue(settings.fps, sourceOptionValue));
      renderSelect(this.qualitySelect, exportQualities.map((quality) => ({
        label: exportQualityLabel(quality),
        value: quality
      })), settings.quality);
    }

    if (!this.audioField.hidden) {
      this.renderAudioSelect(settings, source, isVideo);
    }
  }

  private renderAudioSelect(settings: ExportSettings, source: ExportSource, canTurnOff: boolean): void {
    this.audioSelect.disabled = !source.hasAudio || this.isExporting;
    if (!source.hasAudio) {
      renderSelect(this.audioSelect, [{ label: "No audio", value: audioOffOptionValue }], audioOffOptionValue);
      return;
    }

    const bitrateOptions = exportAudioBitrates.map((bitrate) => ({
      label: `${String(bitrate / bitsPerKilobit)} kbps`,
      value: String(bitrate)
    }));
    const options = canTurnOff ? [{ label: "Off", value: audioOffOptionValue }, ...bitrateOptions] : bitrateOptions;
    const isAudioOff = canTurnOff && !settings.includeAudio;
    renderSelect(this.audioSelect, options, isAudioOff ? audioOffOptionValue : String(settings.audioBitrate));
  }

  private renderMessages(basePreset: ExportPreset, source: ExportSource): void {
    const result = this.planResult;
    if (!result) {
      throw new Error("The export plan is missing.");
    }

    const messages: PanelMessage[] = [
      ...result.issues.map((text): PanelMessage => ({ kind: "issue", text })),
      ...result.notes.map((text): PanelMessage => ({ kind: "note", text }))
    ];
    if (this.settings && this.unsupportedCodecs.has(this.settings.videoCodec) && exportFormatKind(this.settings.format) === "video") {
      messages.unshift({
        kind: "issue",
        text: `This PC cannot encode ${exportVideoCodecLabel(this.settings.videoCodec)} at this size. Pick another codec or a lower resolution.`
      });
    }

    if (basePreset.durationLimitSeconds !== null && source.durationSeconds > basePreset.durationLimitSeconds) {
      messages.push({
        kind: "note",
        text: `${basePreset.label} allows clips up to ${formatDuration(basePreset.durationLimitSeconds)} on free accounts. This clip is ${formatDuration(source.durationSeconds)}.`
      });
    }

    if (this.completionMessage) {
      messages.push({ kind: "issue", text: this.completionMessage });
    }

    this.messagesList.replaceChildren(...messages.map((message) => {
      const item = document.createElement("li");
      item.className = `export-message ${message.kind}`;
      item.textContent = message.text;
      return item;
    }));
  }

  private renderSummary(settings: ExportSettings, result: ExportPlanResult): void {
    if (!this.source) {
      throw new Error("The export source is missing.");
    }

    const chips: string[] = [];
    const { output } = result;
    if (output.width !== null && output.height !== null) {
      chips.push(`${String(output.width)}×${String(output.height)}`);
    }

    if (output.fps !== null) {
      chips.push(`${formatFps(output.fps)} fps`);
    }

    chips.push(exportFormatKind(settings.format) === "video"
      ? `${exportFormatLabel(settings.format)}, ${exportVideoCodecLabel(settings.videoCodec)}`
      : exportFormatLabel(settings.format));
    if (result.estimatedBytes !== null) {
      chips.push(`${result.isSizeLimited ? "Up to" : "About"} ${formatBytes(result.estimatedBytes)}`);
    }

    chips.push(formatDuration(this.source.durationSeconds));
    this.summary.replaceChildren(...chips.map((text) => {
      const item = document.createElement("span");
      item.className = "export-summary-item";
      item.textContent = text;
      return item;
    }));
  }

  private async refreshCodecSupport(settings: ExportSettings, result: ExportPlanResult): Promise<void> {
    const { fps: framerate, height, width } = result.output;
    if (exportFormatKind(settings.format) !== "video" || width === null || height === null || framerate === null) {
      return;
    }

    const bitrate = result.plan?.kind === "video" ? result.plan.video.bitrate : bitsPerKilobit * bitsPerKilobit;
    const key = `${settings.format}:${String(width)}x${String(height)}:${String(bitrate)}:${String(framerate)}`;
    if (key === this.codecSupportKey) {
      return;
    }

    this.codecSupportKey = key;
    const token = this.codecSupportToken + 1;
    this.codecSupportToken = token;
    const codecs = exportVideoCodecsForFormat(settings.format);
    const support = await Promise.all(codecs.map(async (codec) => ({
      codec,
      isSupported: await supportedVideoEncoderAcceleration(codec, { bitrate, framerate, height, width }) !== null
    })));
    if (token !== this.codecSupportToken || !this.isOpen) {
      return;
    }

    this.unsupportedCodecs.clear();
    for (const { codec, isSupported } of support) {
      if (!isSupported) {
        this.unsupportedCodecs.add(codec);
      }
    }

    this.render();
  }

  private syncActionStates(): void {
    const { isExporting } = this;
    const { settings } = this;
    const isCodecUnsupported = settings !== null
      && exportFormatKind(settings.format) === "video"
      && this.unsupportedCodecs.has(settings.videoCodec);
    this.startButton.disabled = isExporting || !this.planResult?.plan || isCodecUnsupported;
    this.startButton.hidden = isExporting;
    this.cancelButton.textContent = isExporting ? "Cancel export" : "Cancel";
    this.progress.hidden = !isExporting;
    this.summary.hidden = isExporting;
    for (const select of [
      this.formatSelect,
      this.codecSelect,
      this.resolutionSelect,
      this.fpsSelect,
      this.qualitySelect,
      this.sizeSelect
    ]) {
      select.disabled = isExporting;
    }

    this.audioSelect.disabled = isExporting || this.source?.hasAudio !== true;
    this.upscaleCheckbox.disabled = isExporting;
    for (const input of this.dialog.querySelectorAll<HTMLInputElement>(destinationInputSelector)) {
      input.disabled = isExporting;
    }

    for (const button of this.presetList.querySelectorAll<HTMLButtonElement>(presetButtonSelector)) {
      button.disabled = isExporting;
    }
  }

  private destination(): ExportDestination {
    const input = this.dialog.querySelector<HTMLInputElement>(`${destinationInputSelector}:checked`);
    if (input?.value === "clipboard" || input?.value === "file") {
      return input.value;
    }

    throw new Error("Choose where to export.");
  }

  private async runExport(): Promise<void> {
    const plan = this.planResult?.plan;
    const { basePreset, settings } = this;
    if (!plan || !basePreset || !settings || this.isExporting) {
      return;
    }

    const api = getSoftshotApi();
    const destination = this.destination();
    let targetFilePath: string | null = null;
    if (destination === "file") {
      const result = await api.chooseEditorExportPath(plan.format, basePreset.fileLabel);
      if (!result.filePath) {
        return;
      }

      targetFilePath = result.filePath;
    }

    await api.updateSettings({ exportPresetId: basePreset.id });
    const abortController = new AbortController();
    this.abortController = abortController;
    this.exportStartedAt = performance.now();
    this.completionMessage = null;
    this.showProgress(0);
    this.syncActionStates();
    this.host.setBusy(true);
    try {
      const file = await this.host.exportFile(plan, {
        onProgress: (progress): void => {
          this.showProgress(progress);
        },
        signal: abortController.signal
      });
      await (targetFilePath === null
        ? api.copyPreparedEditorVideo(file.filePath)
        : api.savePreparedEditorVideo(file.filePath, targetFilePath));
      this.finishExport(file, settings, destination);
    } catch (error) {
      if (abortController.signal.aborted) {
        this.host.showStatus("Export canceled");
        return;
      }

      throw error;
    } finally {
      this.abortController = null;
      this.host.setBusy(false);
      if (this.isOpen) {
        this.render();
      }
    }
  }

  private finishExport(file: CompletedOutputFile, settings: ExportSettings, destination: ExportDestination): void {
    const limit = settings.maxFileSizeMegabytes;
    if (limit !== null && file.byteLength > limit * bytesPerMegabyte) {
      this.completionMessage = `The file came out at ${formatBytes(file.byteLength)}, over the ${String(limit)} MB limit. Try a lower resolution or frame rate.`;
      return;
    }

    this.dialog.close();
    this.host.showStatus(destination === "file" ? exportDoneStatus : copyDoneStatus);
  }

  private showProgress(progress: number): void {
    const percent = Math.round(progress * percentScale);
    this.progressBar.style.width = `${String(percent)}%`;
    const elapsedSeconds = (performance.now() - this.exportStartedAt) / millisecondsPerSecond;
    const remainingSeconds = progress >= minimumProgressForEstimate ? elapsedSeconds * (1 - progress) / progress : null;
    this.progressText.textContent = remainingSeconds === null
      ? `${String(percent)}%`
      : `${String(percent)}%, about ${formatDuration(remainingSeconds)} left`;
  }

  private presetButton(presetId: string): HTMLButtonElement | null {
    return [...this.presetList.querySelectorAll<HTMLButtonElement>(presetButtonSelector)]
      .find((button) => button.dataset.presetId === presetId) ?? null;
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  bind(): void {
    this.presetList.addEventListener("click", (event): void => {
      const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(presetButtonSelector) : null;
      const preset = this.presets.find((candidate) => candidate.id === button?.dataset.presetId);
      if (preset && !this.isExporting) {
        this.selectPreset(preset);
      }
    });
    this.closeButton.addEventListener("click", (): void => {
      this.closeOrCancel();
    });
    this.cancelButton.addEventListener("click", (): void => {
      this.closeOrCancel();
    });
    this.dialog.addEventListener("cancel", (event): void => {
      if (this.isExporting) {
        event.preventDefault();
      }
    });
    this.startButton.addEventListener("click", (): void => {
      void reportAsyncError(this.runExport(), "Could not export.");
    });
    this.formatSelect.addEventListener("change", (): void => {
      this.updateSettings((settings) => settingsForFormat(settings, exportFormatFromValue(this.formatSelect.value)));
    });
    this.codecSelect.addEventListener("change", (): void => {
      this.updateSettings((settings) => ({ ...settings, videoCodec: videoCodecFromValue(this.codecSelect.value) }));
    });
    this.resolutionSelect.addEventListener("change", (): void => {
      const resolution = exportResolutions.find((candidate) => candidate === this.resolutionSelect.value);
      if (!resolution) {
        throw new Error("Unexpected export resolution.");
      }

      this.updateSettings((settings) => ({ ...settings, resolution }));
    });
    this.fpsSelect.addEventListener("change", (): void => {
      this.updateSettings((settings) => ({ ...settings, fps: nullableNumberFromValue(this.fpsSelect.value, sourceOptionValue) }));
    });
    this.qualitySelect.addEventListener("change", (): void => {
      const quality = exportQualities.find((candidate) => candidate === this.qualitySelect.value);
      if (!quality) {
        throw new Error("Unexpected export quality.");
      }

      this.updateSettings((settings) => ({ ...settings, quality }));
    });
    this.sizeSelect.addEventListener("change", (): void => {
      this.updateSettings((settings) => ({
        ...settings,
        maxFileSizeMegabytes: nullableNumberFromValue(this.sizeSelect.value, noLimitOptionValue)
      }));
    });
    this.upscaleCheckbox.addEventListener("change", (): void => {
      this.updateSettings((settings) => ({ ...settings, upscale: this.upscaleCheckbox.checked }));
    });
    this.audioSelect.addEventListener("change", (): void => {
      const bitrate = nullableNumberFromValue(this.audioSelect.value, audioOffOptionValue);
      this.updateSettings((settings) => ({
        ...settings,
        audioBitrate: bitrate ?? settings.audioBitrate,
        includeAudio: bitrate !== null
      }));
    });
  }

  async open(): Promise<void> {
    if (this.isOpen) {
      return;
    }

    const source = this.host.exportSource();
    const { exportPresetId } = await getSoftshotApi().getSettings();
    this.source = source;
    this.presets = exportPresets(source.format);
    this.codecSupportKey = "";
    this.unsupportedCodecs.clear();
    const preset = this.presets.find((candidate) => candidate.id === exportPresetId) ?? this.presets.at(0);
    if (!preset) {
      throw new Error("Export presets are missing.");
    }

    this.renderPresetList();
    this.selectPreset(preset);
    this.dialog.showModal();
    this.presetButton(preset.id)?.focus();
  }
}

function presetButtonElement(preset: ExportPreset): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "export-preset";
  button.type = "button";
  button.dataset.presetId = preset.id;
  button.setAttribute("aria-pressed", "false");
  const label = document.createElement("span");
  label.className = "export-preset-label";
  label.textContent = preset.label;
  const description = document.createElement("span");
  description.className = "export-preset-detail";
  description.textContent = preset.description;
  button.append(label, description);
  return button;
}

function renderSelect(select: HTMLSelectElement, options: readonly SelectOption[], value: string): void {
  select.replaceChildren(...options.map((option) => {
    const element = document.createElement("option");
    element.value = option.value;
    element.textContent = option.label;
    element.disabled = option.isDisabled === true;
    return element;
  }));
  select.value = value;
}

function fpsOptions(isGif: boolean, sourceFps: number): SelectOption[] {
  if (isGif) {
    return exportGifFpsOptions.map((fps) => ({ label: `${String(fps)} fps`, value: String(fps) }));
  }

  return exportVideoFpsOptions.map((fps) => fps === null
    ? { label: `Source (${formatFps(sourceFps)} fps)`, value: sourceOptionValue }
    : { label: `${String(fps)} fps`, value: String(fps) });
}

function fileSizeOptions(currentMegabytes: number | null): SelectOption[] {
  const sizes = new Set<number | null>(exportFileSizeOptionsMegabytes);
  sizes.add(currentMegabytes);
  return [...sizes]
    .toSorted((left, right) => (left ?? 0) - (right ?? 0))
    .map((size) => size === null
      ? { label: "No limit", value: noLimitOptionValue }
      : { label: `${String(size)} MB`, value: String(size) });
}

function optionValue(value: number | null, nullValue: string): string {
  return value === null ? nullValue : String(value);
}

function nullableNumberFromValue(value: string, nullValue: string): number | null {
  if (value === nullValue) {
    return null;
  }

  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error("Unexpected export option value.");
  }

  return number;
}

function exportFormatFromValue(value: string): ExportFormat {
  const format = exportFormats.find((candidate) => candidate === value);
  if (!format) {
    throw new Error("Unexpected export format.");
  }

  return format;
}

function videoCodecFromValue(value: string): ExportVideoCodec {
  const codec = exportVideoCodecs.find((candidate) => candidate === value);
  if (!codec) {
    throw new Error("Unexpected video codec.");
  }

  return codec;
}

function formatBytes(byteCount: number): string {
  if (byteCount < bytesPerMegabyte) {
    return `${String(Math.max(1, Math.round(byteCount / bytesPerKilobyte)))} KB`;
  }

  const megabytes = byteCount / bytesPerMegabyte;
  return `${megabytes < largeFileMegabytes ? megabytes.toFixed(1) : String(Math.round(megabytes))} MB`;
}

function formatDuration(totalSeconds: number): string {
  const roundedSeconds = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(roundedSeconds / secondsPerMinute);
  const seconds = roundedSeconds % secondsPerMinute;
  return `${String(minutes)}:${String(seconds).padStart(secondsTextLength, "0")}`;
}
