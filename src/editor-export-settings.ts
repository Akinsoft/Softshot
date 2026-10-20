import { recordingAudioBitrate, recordingAudioChannelCount, recordingAudioSampleRate } from "./audio-quality.js";
import type { OutputFileExtension, VideoFileExtension } from "./shared.js";
import { videoFpsOptions } from "./shared.js";
import { videoBitrate } from "./video-bitrate.js";

export type ExportFormat = OutputFileExtension;
type ExportFormatKind = "audio" | "gif" | "video";
export type ExportVideoCodec = "av1" | "avc" | "hevc" | "vp9";
type ExportAudioCodec = "aac" | "opus" | "pcm-s16";
type ExportQuality = "high" | "low" | "medium";
type ExportResolution = "1080p" | "1440p" | "2160p" | "480p" | "720p" | "source";
type ExportBitrateMode = "constant" | "variable";
type ExportScaling = "down" | "none" | "up";
export type ExportPresetGroup = "Discord" | "General" | "Other" | "X" | "YouTube";

const lowAudioBitrate = 96_000;
const standardAudioBitrate = 128_000;
const highAudioBitrate = 160_000;
const cinemaFps = 24;
const smoothGifFps = 30;
const balancedGifFps = 20;
const defaultGifFps = 15;
const smallGifFps = 10;
const discordFreeLimitMegabytes = 10;
const smallSizeLimitMegabytes = 25;
const discordNitroBasicLimitMegabytes = 50;
const largeSizeLimitMegabytes = 100;
const discordNitroLimitMegabytes = 500;
const xLimitMegabytes = 512;
const xFreeDurationLimitSeconds = 140;

export const exportFormats = ["mp4", "webm", "gif", "m4a", "wav"] as const satisfies readonly ExportFormat[];
export const exportVideoCodecs = ["avc", "hevc", "av1", "vp9"] as const satisfies readonly ExportVideoCodec[];
export const exportQualities = ["high", "medium", "low"] as const satisfies readonly ExportQuality[];
export const exportResolutions = ["source", "2160p", "1440p", "1080p", "720p", "480p"] as const satisfies readonly ExportResolution[];
export const exportAudioBitrates = [lowAudioBitrate, standardAudioBitrate, highAudioBitrate, recordingAudioBitrate] as const;
export const exportVideoFpsOptions = [null, videoFpsOptions.high, videoFpsOptions.standard, cinemaFps] as const;
export const exportGifFpsOptions = [smoothGifFps, balancedGifFps, defaultGifFps, smallGifFps] as const;
export const exportFileSizeOptionsMegabytes = [
  null,
  discordFreeLimitMegabytes,
  smallSizeLimitMegabytes,
  discordNitroBasicLimitMegabytes,
  largeSizeLimitMegabytes,
  discordNitroLimitMegabytes
] as const;

export interface ExportSettings {
  audioBitrate: number;
  format: ExportFormat;
  fps: number | null;
  includeAudio: boolean;
  maxFileSizeMegabytes: number | null;
  quality: ExportQuality;
  resolution: ExportResolution;
  upscale: boolean;
  videoCodec: ExportVideoCodec;
}

export interface ExportPreset {
  description: string;
  durationLimitSeconds: number | null;
  fileLabel: string;
  group: ExportPresetGroup;
  id: string;
  label: string;
  settings: ExportSettings;
}

export interface ExportSource {
  durationSeconds: number;
  format: VideoFileExtension;
  fps: number;
  hasAudio: boolean;
  height: number;
  isVideoVisible: boolean;
  width: number;
}

interface ExportVideoSize {
  height: number;
  width: number;
}

export interface EncodedVideoPlan {
  bitrate: number;
  bitrateMode: ExportBitrateMode;
  codec: ExportVideoCodec;
  fps: number;
  normalizeFrameRate: boolean;
  outputSize: ExportVideoSize | null;
  scaling: ExportScaling;
}

export interface ExportAudioPlan {
  bitrate: number;
  codec: ExportAudioCodec;
}

export interface GifPlan {
  colors: number;
  fps: number;
  outputSize: ExportVideoSize;
  scaling: ExportScaling;
}

export type ExportPlan =
  | { audio: ExportAudioPlan | null; format: "mp4" | "webm"; kind: "video"; video: EncodedVideoPlan }
  | { audio: ExportAudioPlan; format: "m4a" | "wav"; kind: "audio" }
  | { format: "gif"; gif: GifPlan; kind: "gif" };

interface ExportOutputSummary {
  fps: number | null;
  height: number | null;
  width: number | null;
}

export interface ExportPlanResult {
  estimatedBytes: number | null;
  isSizeLimited: boolean;
  issues: string[];
  notes: string[];
  output: ExportOutputSummary;
  plan: ExportPlan | null;
}

interface FormatDetails {
  audioCodec: ExportAudioCodec | null;
  kind: ExportFormatKind;
  label: string;
  videoCodecs: readonly ExportVideoCodec[];
}

interface UploadBitrateStep {
  highFpsBitrate: number;
  pixelCount: number;
  standardBitrate: number;
}

interface FittedVideoSize extends ExportVideoSize {
  scaling: ExportScaling;
}

const width360p = 640;
const height360p = 360;
const width480p = 854;
const height480p = 480;
const width720p = 1280;
const height720p = 720;
const width1080p = 1920;
const height1080p = 1080;
const width1440p = 2560;
const height1440p = 1440;
const width2160p = 3840;
const height2160p = 2160;
const bitrate360pStandard = 1_000_000;
const bitrate360pHighFps = 1_500_000;
const bitrate480pStandard = 2_500_000;
const bitrate480pHighFps = 4_000_000;
const bitrate720pStandard = 5_000_000;
const bitrate720pHighFps = 7_500_000;
const bitrate1080pStandard = 8_000_000;
const bitrate1080pHighFps = 12_000_000;
const bitrate1440pStandard = 16_000_000;
const bitrate1440pHighFps = 24_000_000;
const bitrate2160pStandard = 35_000_000;
const bitrate2160pHighFps = 53_000_000;
const mediumQualityRatio = 0.6;
const lowQualityRatio = 0.35;
const highGifColors = 256;
const mediumGifColors = 128;
const lowGifColors = 64;
const bitsPerByte = 8;
const bytesPerMegabyte = 1_000_000;
const fileSizeSafetyRatio = 0.92;
const minimumSizeLimitedVideoBitrate = 150_000;
const lowBitsPerPixelThreshold = 0.02;
const fpsTolerance = 0.5;
const fpsDisplayPrecisionDigits = 2;
const evenDivisor = 2;
const pcmBytesPerSample = 2;
const longGifSeconds = 20;
const gifColorsByQuality: Record<ExportQuality, number> = {
  high: highGifColors,
  low: lowGifColors,
  medium: mediumGifColors
};
const qualityBitrateRatios: Record<ExportQuality, number> = {
  high: 1,
  low: lowQualityRatio,
  medium: mediumQualityRatio
};
const uploadBitrateSteps: readonly UploadBitrateStep[] = [
  { highFpsBitrate: bitrate360pHighFps, pixelCount: width360p * height360p, standardBitrate: bitrate360pStandard },
  { highFpsBitrate: bitrate480pHighFps, pixelCount: width480p * height480p, standardBitrate: bitrate480pStandard },
  { highFpsBitrate: bitrate720pHighFps, pixelCount: width720p * height720p, standardBitrate: bitrate720pStandard },
  { highFpsBitrate: bitrate1080pHighFps, pixelCount: width1080p * height1080p, standardBitrate: bitrate1080pStandard },
  { highFpsBitrate: bitrate1440pHighFps, pixelCount: width1440p * height1440p, standardBitrate: bitrate1440pStandard },
  { highFpsBitrate: bitrate2160pHighFps, pixelCount: width2160p * height2160p, standardBitrate: bitrate2160pStandard }
];
const resolutionBoxes: Record<Exclude<ExportResolution, "source">, ExportVideoSize> = {
  "1080p": { height: height1080p, width: width1080p },
  "1440p": { height: height1440p, width: width1440p },
  "2160p": { height: height2160p, width: width2160p },
  "480p": { height: height480p, width: width480p },
  "720p": { height: height720p, width: width720p }
};
const formatDetailsByFormat: Record<ExportFormat, FormatDetails> = {
  gif: { audioCodec: null, kind: "gif", label: "GIF", videoCodecs: [] },
  m4a: { audioCodec: "aac", kind: "audio", label: "M4A audio", videoCodecs: [] },
  mp4: { audioCodec: "aac", kind: "video", label: "MP4", videoCodecs: ["avc", "hevc", "av1"] },
  wav: { audioCodec: "pcm-s16", kind: "audio", label: "WAV audio", videoCodecs: [] },
  webm: { audioCodec: "opus", kind: "video", label: "WebM", videoCodecs: ["vp9", "av1"] }
};
const videoCodecLabels: Record<ExportVideoCodec, string> = {
  av1: "AV1",
  avc: "H.264",
  hevc: "HEVC (H.265)",
  vp9: "VP9"
};
const qualityLabels: Record<ExportQuality, string> = {
  high: "High",
  low: "Low",
  medium: "Medium"
};
const resolutionLabels: Record<ExportResolution, string> = {
  "1080p": "1080p",
  "1440p": "1440p",
  "2160p": "4K (2160p)",
  "480p": "480p",
  "720p": "720p",
  source: "Source"
};
const planResolvers: Record<ExportFormatKind, (settings: ExportSettings, source: ExportSource) => ExportPlanResult> = {
  audio: resolveAudioPlan,
  gif: resolveGifPlan,
  video: resolveVideoPlan
};

export function exportPresets(sourceFormat: VideoFileExtension): ExportPreset[] {
  const mp4 = defaultVideoSettings("mp4");
  return [
    preset({
      description: "Same size and frame rate as the source",
      fileLabel: "Original",
      group: "General",
      id: "original",
      label: "Original quality",
      settings: defaultVideoSettings(sourceFormat)
    }),
    ...youtubePresets(mp4),
    ...discordPresets(mp4),
    ...socialPresets(mp4),
    ...otherPresets(mp4)
  ];
}

export function exportFormatKind(format: ExportFormat): ExportFormatKind {
  return formatDetailsByFormat[format].kind;
}

export function exportFormatLabel(format: ExportFormat): string {
  return formatDetailsByFormat[format].label;
}

export function exportVideoCodecsForFormat(format: ExportFormat): readonly ExportVideoCodec[] {
  return formatDetailsByFormat[format].videoCodecs;
}

export function exportVideoCodecLabel(codec: ExportVideoCodec): string {
  return videoCodecLabels[codec];
}

export function exportQualityLabel(quality: ExportQuality): string {
  return qualityLabels[quality];
}

export function exportResolutionLabel(resolution: ExportResolution): string {
  return resolutionLabels[resolution];
}

export function settingsForFormat(settings: ExportSettings, format: ExportFormat): ExportSettings {
  const nextSettings = { ...settings, format };
  const codecs = exportVideoCodecsForFormat(format);
  const firstCodec = codecs.at(0);
  if (firstCodec && !codecs.includes(nextSettings.videoCodec)) {
    nextSettings.videoCodec = firstCodec;
  }

  const kind = exportFormatKind(format);
  const gifFpsOptions: ReadonlyArray<number | null> = exportGifFpsOptions;
  const videoFpsChoices: ReadonlyArray<number | null> = exportVideoFpsOptions;
  if (kind === "gif" && !gifFpsOptions.includes(nextSettings.fps)) {
    nextSettings.fps = defaultGifFps;
  }

  if (kind === "video" && !videoFpsChoices.includes(nextSettings.fps)) {
    nextSettings.fps = null;
  }

  return nextSettings;
}

export function areExportSettingsEqual(left: ExportSettings, right: ExportSettings): boolean {
  const keys = Object.keys(left) as Array<keyof ExportSettings>;
  return keys.every((key) => left[key] === right[key]);
}

export function sourceExportPlan(source: ExportSource): ExportPlan {
  return {
    audio: source.hasAudio ? { bitrate: recordingAudioBitrate, codec: audioCodecForFormat(source.format) } : null,
    format: source.format,
    kind: "video",
    video: {
      bitrate: videoBitrate(source.width, source.height, source.fps),
      bitrateMode: "variable",
      codec: source.format === "mp4" ? "avc" : "vp9",
      fps: source.fps,
      normalizeFrameRate: false,
      outputSize: null,
      scaling: "none"
    }
  };
}

export function resolveExportPlan(settings: ExportSettings, source: ExportSource): ExportPlanResult {
  return planResolvers[exportFormatKind(settings.format)](settings, source);
}

export function formatFps(fps: number): string {
  return Number.isSafeInteger(fps) ? String(fps) : fps.toFixed(fpsDisplayPrecisionDigits);
}

function youtubePresets(mp4: ExportSettings): ExportPreset[] {
  const youtube = (
    id: string,
    label: string,
    description: string,
    resolution: ExportResolution,
    fps: number | null
  ): ExportPreset => preset({ description, fileLabel: label, group: "YouTube", id, label, settings: { ...mp4, fps, resolution, upscale: true } });
  return [
    youtube("youtube-2160p", "YouTube 4K", "2160p, H.264", "2160p", null),
    youtube("youtube-1440p", "YouTube 1440p", "1440p, H.264", "1440p", null),
    youtube("youtube-1080p60", "YouTube 1080p60", "1080p at 60 fps", "1080p", videoFpsOptions.high),
    youtube("youtube-1080p30", "YouTube 1080p30", "1080p at 30 fps", "1080p", videoFpsOptions.standard),
    youtube("youtube-720p60", "YouTube 720p60", "720p at 60 fps", "720p", videoFpsOptions.high)
  ];
}

function discordPresets(mp4: ExportSettings): ExportPreset[] {
  return [
    preset({
      description: `Under ${String(discordFreeLimitMegabytes)} MB for free accounts`,
      fileLabel: "Discord",
      group: "Discord",
      id: "discord-free",
      label: "Discord Free",
      settings: {
        ...mp4,
        audioBitrate: lowAudioBitrate,
        fps: videoFpsOptions.standard,
        maxFileSizeMegabytes: discordFreeLimitMegabytes,
        resolution: "720p"
      }
    }),
    preset({
      description: `Under ${String(discordNitroBasicLimitMegabytes)} MB, up to 1080p60`,
      fileLabel: "Discord Nitro Basic",
      group: "Discord",
      id: "discord-nitro-basic",
      label: "Discord Nitro Basic",
      settings: {
        ...mp4,
        audioBitrate: standardAudioBitrate,
        fps: videoFpsOptions.high,
        maxFileSizeMegabytes: discordNitroBasicLimitMegabytes,
        resolution: "1080p"
      }
    }),
    preset({
      description: `Under ${String(discordNitroLimitMegabytes)} MB, up to 1080p60`,
      fileLabel: "Discord Nitro",
      group: "Discord",
      id: "discord-nitro",
      label: "Discord Nitro",
      settings: { ...mp4, fps: videoFpsOptions.high, maxFileSizeMegabytes: discordNitroLimitMegabytes, resolution: "1080p" }
    })
  ];
}

function socialPresets(mp4: ExportSettings): ExportPreset[] {
  return [
    preset({
      description: `Up to 1080p60, under ${String(xLimitMegabytes)} MB`,
      durationLimitSeconds: xFreeDurationLimitSeconds,
      fileLabel: "X",
      group: "X",
      id: "x",
      label: "X (Twitter)",
      settings: { ...mp4, fps: videoFpsOptions.high, maxFileSizeMegabytes: xLimitMegabytes, resolution: "1080p" }
    }),
    preset({
      description: "720p VP9, small files for the web",
      fileLabel: "Web",
      group: "General",
      id: "web",
      label: "Small WebM",
      settings: {
        ...defaultVideoSettings("webm"),
        audioBitrate: standardAudioBitrate,
        fps: videoFpsOptions.standard,
        quality: "medium",
        resolution: "720p"
      }
    })
  ];
}

function otherPresets(mp4: ExportSettings): ExportPreset[] {
  return [
    preset({
      description: `480p at ${String(defaultGifFps)} fps, no sound`,
      fileLabel: "GIF",
      group: "Other",
      id: "gif",
      label: "GIF",
      settings: { ...mp4, format: "gif", fps: defaultGifFps, includeAudio: false, resolution: "480p" }
    }),
    preset({
      description: "Sound only, AAC",
      fileLabel: "Audio",
      group: "Other",
      id: "audio-m4a",
      label: "Audio (M4A)",
      settings: { ...mp4, format: "m4a" }
    }),
    preset({
      description: "Sound only, uncompressed",
      fileLabel: "Audio",
      group: "Other",
      id: "audio-wav",
      label: "Audio (WAV)",
      settings: { ...mp4, format: "wav" }
    })
  ];
}

function preset(definition: Omit<ExportPreset, "durationLimitSeconds"> & { durationLimitSeconds?: number }): ExportPreset {
  return { ...definition, durationLimitSeconds: definition.durationLimitSeconds ?? null };
}

function defaultVideoSettings(format: VideoFileExtension): ExportSettings {
  return {
    audioBitrate: recordingAudioBitrate,
    format,
    fps: null,
    includeAudio: true,
    maxFileSizeMegabytes: null,
    quality: "high",
    resolution: "source",
    upscale: false,
    videoCodec: format === "mp4" ? "avc" : "vp9"
  };
}

function audioCodecForFormat(format: ExportFormat): ExportAudioCodec {
  const { audioCodec } = formatDetailsByFormat[format];
  if (!audioCodec) {
    throw new Error(`${exportFormatLabel(format)} files cannot contain audio.`);
  }

  return audioCodec;
}

function resolveVideoPlan(settings: ExportSettings, source: ExportSource): ExportPlanResult {
  const issues: string[] = [];
  const notes: string[] = [];
  const fitted = fittedVideoSize(source, settings, notes);
  const fps = outputFps(settings.fps, source.fps, notes);
  const audio = settings.includeAudio && source.hasAudio
    ? { bitrate: settings.audioBitrate, codec: audioCodecForFormat(settings.format) }
    : null;
  if (!source.isVideoVisible) {
    notes.push("The video track is hidden, so the picture will be black.");
  }

  const qualityBitrate = Math.round(uploadVideoBitrate(fitted, fps) * qualityBitrateRatios[settings.quality]);
  const sizeLimit = sizeLimitedBitrate(settings, source, audio, qualityBitrate);
  if (sizeLimit.issue) {
    issues.push(sizeLimit.issue);
  }

  const bitrate = sizeLimit.bitrate ?? qualityBitrate;
  if (sizeLimit.bitrate !== null && bitrate / (fitted.width * fitted.height * fps) < lowBitsPerPixelThreshold) {
    notes.push("This clip is long for the size limit, so quality will be low. A lower resolution or frame rate will look sharper.");
  }

  const { format } = settings;
  const isEncodable = issues.length === 0 && (format === "mp4" || format === "webm");
  return {
    estimatedBytes: (bitrate + (audio?.bitrate ?? 0)) * source.durationSeconds / bitsPerByte,
    isSizeLimited: sizeLimit.bitrate !== null,
    issues,
    notes,
    output: { fps, height: fitted.height, width: fitted.width },
    plan: isEncodable
      ? {
        audio,
        format,
        kind: "video",
        video: {
          bitrate,
          bitrateMode: sizeLimit.bitrate === null ? "variable" : "constant",
          codec: settings.videoCodec,
          fps,
          normalizeFrameRate: fps < source.fps - fpsTolerance,
          outputSize: fitted.scaling === "none" ? null : { height: fitted.height, width: fitted.width },
          scaling: fitted.scaling
        }
      }
      : null
  };
}

function sizeLimitedBitrate(
  settings: ExportSettings,
  source: ExportSource,
  audio: ExportAudioPlan | null,
  qualityBitrate: number
): { bitrate: number | null; issue: string | null } {
  const limit = settings.maxFileSizeMegabytes;
  if (limit === null) {
    return { bitrate: null, issue: null };
  }

  const totalBits = limit * bytesPerMegabyte * bitsPerByte * fileSizeSafetyRatio;
  const budgetBitrate = Math.floor(totalBits / source.durationSeconds - (audio?.bitrate ?? 0));
  if (budgetBitrate < minimumSizeLimitedVideoBitrate) {
    return { bitrate: null, issue: `This clip is too long to fit in ${String(limit)} MB. Trim it or pick a bigger size limit.` };
  }

  return { bitrate: budgetBitrate < qualityBitrate ? budgetBitrate : null, issue: null };
}

function resolveGifPlan(settings: ExportSettings, source: ExportSource): ExportPlanResult {
  const issues: string[] = [];
  const notes: string[] = [];
  if (!source.isVideoVisible) {
    issues.push("Show the video track to export a GIF.");
  }

  const fitted = fittedVideoSize(source, settings, notes);
  const fps = outputFps(settings.fps ?? defaultGifFps, source.fps, notes);
  if (source.durationSeconds > longGifSeconds) {
    notes.push("Long GIFs get very large. A video format will be much smaller.");
  }

  const gif: GifPlan = {
    colors: gifColorsByQuality[settings.quality],
    fps,
    outputSize: { height: fitted.height, width: fitted.width },
    scaling: fitted.scaling
  };
  return {
    estimatedBytes: null,
    isSizeLimited: false,
    issues,
    notes,
    output: { fps, height: fitted.height, width: fitted.width },
    plan: issues.length === 0 ? { format: "gif", gif, kind: "gif" } : null
  };
}

function resolveAudioPlan(settings: ExportSettings, source: ExportSource): ExportPlanResult {
  const issues: string[] = [];
  if (!source.hasAudio) {
    issues.push("There is no sound to export. Unmute an audio track first.");
  }

  const codec = audioCodecForFormat(settings.format);
  const bitrate = codec === "pcm-s16"
    ? recordingAudioSampleRate * recordingAudioChannelCount * pcmBytesPerSample * bitsPerByte
    : settings.audioBitrate;
  const { format } = settings;
  const isEncodable = issues.length === 0 && (format === "m4a" || format === "wav");
  return {
    estimatedBytes: bitrate * source.durationSeconds / bitsPerByte,
    isSizeLimited: false,
    issues,
    notes: [],
    output: { fps: null, height: null, width: null },
    plan: isEncodable ? { audio: { bitrate, codec }, format, kind: "audio" } : null
  };
}

function fittedVideoSize(source: ExportSource, settings: ExportSettings, notes: string[]): FittedVideoSize {
  const { resolution } = settings;
  if (resolution === "source") {
    return { height: source.height, scaling: "none", width: source.width };
  }

  const box = resolutionBoxes[resolution];
  const isLandscape = source.width >= source.height;
  const maximumWidth = isLandscape ? box.width : box.height;
  const maximumHeight = isLandscape ? box.height : box.width;
  const scale = Math.min(maximumWidth / source.width, maximumHeight / source.height);
  const width = evenDimension(source.width * scale);
  const height = evenDimension(source.height * scale);
  if (width === source.width && height === source.height) {
    return { height, scaling: "none", width };
  }

  if (scale < 1) {
    return { height, scaling: "down", width };
  }

  if (!settings.upscale) {
    notes.push(`The source is ${String(source.width)}×${String(source.height)}, so it stays at that size. Turn on upscaling to enlarge it.`);
    return { height: source.height, scaling: "none", width: source.width };
  }

  notes.push(`Upscaled from ${String(source.width)}×${String(source.height)} with the Softshot upscaler, which keeps text and edges sharp.`);
  return { height, scaling: "up", width };
}

function outputFps(requestedFps: number | null, sourceFps: number, notes: string[]): number {
  if (requestedFps === null) {
    return sourceFps;
  }

  if (requestedFps > sourceFps + fpsTolerance) {
    notes.push(`The source is ${formatFps(sourceFps)} fps, so it stays at that frame rate.`);
    return sourceFps;
  }

  return requestedFps;
}

function uploadVideoBitrate(size: ExportVideoSize, fps: number): number {
  const pixelCount = size.width * size.height;
  const isHighFps = fps > videoFpsOptions.standard;
  const bitrateForStep = (step: UploadBitrateStep): number => isHighFps ? step.highFpsBitrate : step.standardBitrate;
  const upperIndex = uploadBitrateSteps.findIndex((step) => pixelCount <= step.pixelCount);
  const upper = upperIndex === -1 ? null : uploadBitrateSteps.at(upperIndex) ?? null;
  const lower = upperIndex > 0 ? uploadBitrateSteps.at(upperIndex - 1) ?? null : null;
  if (lower && upper) {
    const progress = (pixelCount - lower.pixelCount) / (upper.pixelCount - lower.pixelCount);
    return bitrateForStep(lower) + (bitrateForStep(upper) - bitrateForStep(lower)) * progress;
  }

  const edgeStep = upper ?? uploadBitrateSteps.at(-1) ?? null;
  if (!edgeStep) {
    throw new Error("Upload bitrate steps are missing.");
  }

  return bitrateForStep(edgeStep) * pixelCount / edgeStep.pixelCount;
}

function evenDimension(value: number): number {
  return Math.max(evenDivisor, Math.round(value / evenDivisor) * evenDivisor);
}
