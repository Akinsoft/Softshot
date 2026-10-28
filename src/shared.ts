const standardVideoFps = 30;
const highVideoFps = 60;
const lowVideoHeight = 720;
const lowVideoWidth = 1280;
const highVideoHeight = 1080;
const highVideoWidth = 1920;
const ultraVideoHeight = 1440;
const ultraVideoWidth = 2560;
const timestampPartWidth = 2;
const millisecondsPerSecond = 1000;
const shortClipSeconds = 15;
const standardClipSeconds = 30;
const minuteClipSeconds = 60;
const secondsPerMinute = 60;
const twoMinuteClipSeconds = 120;
const fiveMinuteClipSeconds = 300;

export const videoFpsOptions = {
  standard: standardVideoFps,
  high: highVideoFps
} as const;

export const videoQualityDimensions = {
  low: { height: lowVideoHeight, width: lowVideoWidth },
  high: { height: highVideoHeight, width: highVideoWidth }
} as const;

export const clipQualityDimensions = {
  "720p": videoQualityDimensions.low,
  "1080p": videoQualityDimensions.high,
  "1440p": { height: ultraVideoHeight, width: ultraVideoWidth }
} as const;

export const clipQualities = ["720p", "1080p", "1440p"] as const;
export const clipDurationOptionsSeconds = [
  shortClipSeconds,
  standardClipSeconds,
  minuteClipSeconds,
  twoMinuteClipSeconds,
  fiveMinuteClipSeconds
] as const;

export type CaptureMode = "screenshot" | "video";
export type CapturePipeline = "composited" | "direct";
const recordingAudioSourceKinds = ["microphone", "system"] as const;
const audioSourceKinds = [...recordingAudioSourceKinds, "clip"] as const;
const recordingAudioSourceKindSet: ReadonlySet<unknown> = new Set(recordingAudioSourceKinds);
const audioSourceKindSet: ReadonlySet<unknown> = new Set(audioSourceKinds);

export type RecordingAudioSourceKind = (typeof recordingAudioSourceKinds)[number];
export type AudioSourceKind = (typeof audioSourceKinds)[number];
export const clipMixedAudioTrackName = "Desktop and microphone";
export const clipAudioTrackNames: Readonly<Record<RecordingAudioSourceKind, string>> = {
  microphone: "Microphone",
  system: "Desktop"
};
export type VideoQuality = "720p" | "1080p";
export type VideoFps = (typeof videoFpsOptions)[keyof typeof videoFpsOptions];
export type VideoFileExtension = "mp4" | "webm";
const outputFileExtensions = ["mp4", "webm", "gif", "m4a", "wav"] as const;
export type OutputFileExtension = (typeof outputFileExtensions)[number];
const outputFileExtensionSet: ReadonlySet<unknown> = new Set(outputFileExtensions);
export type RecordingEncoder = "hardware" | "compatibility";
export type ClipQuality = (typeof clipQualities)[number];
export type ClipDurationSeconds = (typeof clipDurationOptionsSeconds)[number];
export type ShortcutTarget = "capture" | "clips";
const appPages = ["capture", "clips", "gallery", "settings"] as const;
export type AppPage = (typeof appPages)[number];
export type ClipsState = "error" | "off" | "recording" | "starting" | "waiting";

export type ClipSource =
  | { displayId: number | null; kind: "display" }
  | { kind: "window"; processName: string | null; title: string };

export interface ClipSettings {
  directory: string | null;
  durationSeconds: ClipDurationSeconds;
  enabled: boolean;
  fps: VideoFps;
  microphoneDeviceId: string | null;
  quality: ClipQuality;
  savedToastEnabled: boolean;
  shortcut: string;
  source: ClipSource;
  systemAudioEnabled: boolean;
}

export interface ClipsStatus {
  isShortcutAvailable: boolean;
  message: string | null;
  sourceName: string | null;
  state: ClipsState;
}

export interface ClipDisplayOption {
  height: number;
  id: number;
  isPrimary: boolean;
  label: string;
  width: number;
}

export interface ClipWindowOption {
  iconDataUrl: string | null;
  processName: string | null;
  title: string;
}

export interface ClipSourceOptions {
  displays: ClipDisplayOption[];
  windows: ClipWindowOption[];
}

export interface ClipEntry {
  createdAt: string;
  durationSeconds: number;
  filePath: string;
  height: number;
  id: string;
  sizeBytes: number;
  sourceName: string;
  thumbnailUrl: string;
  width: number;
}

export interface ClipRecorderConfig {
  durationSeconds: ClipDurationSeconds;
  microphoneDeviceId: string | null;
  systemAudioEnabled: boolean;
}

export interface ClipAudioSnapshotRequest {
  fromEpochSeconds: number;
  id: string;
  untilEpochSeconds: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CaptureDisplay {
  id: number;
  bounds: Rect;
}

export interface CapturedDisplay extends CaptureDisplay {
  imageBytes: Uint8Array;
}

export interface OverlayBootstrap {
  displays: CapturedDisplay[];
  toolbarDisplayId: number;
}

export type EditorSource =
  | { capturePipeline: CapturePipeline; encoder: RecordingEncoder; kind: "recording" }
  | { fileName: string; filePath: string; kind: "file" };

export interface EditorBootstrap {
  audioTracks: EditorAudioTrack[];
  canReuseSourceFile: boolean;
  durationSeconds: number;
  fps: number;
  mimeType: string;
  source: EditorSource;
  sourceFilePath: string;
  sourceUrl: string;
}

export interface EditorAudioTrack {
  kind: AudioSourceKind;
  mimeType: string;
  sourceFilePath: string;
  sourceUrl: string;
}

export interface RecordingAudioTrack {
  kind: RecordingAudioSourceKind;
  mimeType: string;
  recordingId: string;
}

export interface RecordingFile {
  id: string;
}

export interface SaveResult {
  filePath: string;
}

export interface SaveDialogResult {
  filePath: string | null;
}

export interface PreparedVideoFile {
  filePath: string;
}

export interface CompletedOutputFile {
  byteLength: number;
  filePath: string;
}

export interface AppSettings {
  captureShortcut: string;
  clips: ClipSettings;
  exportDirectory: string | null;
  exportPresetId: string | null;
  launchAtStartup: boolean;
  microphoneDeviceId: string | null;
  sidebarCollapsed: boolean;
  systemAudioEnabled: boolean;
}

export interface AppSettingsUpdate {
  captureShortcut?: string;
  clips?: Partial<ClipSettings>;
  exportPresetId?: string | null;
  launchAtStartup?: boolean;
  microphoneDeviceId?: string | null;
  sidebarCollapsed?: boolean;
  systemAudioEnabled?: boolean;
}

export interface AppInfo {
  isUpdateReady: boolean;
  version: string;
}

export type ShortcutRecordingEvent =
  | { target: ShortcutTarget; type: "cancelled" }
  | { message: string; target: ShortcutTarget; type: "error" }
  | { shortcut: string; target: ShortcutTarget; type: "preview" }
  | { settings: AppSettings; target: ShortcutTarget; type: "saved" };

type ShortcutRecordingEventHandler = (event: ShortcutRecordingEvent) => void;
type SettingsChangedEventHandler = (settings: AppSettings) => void;
type AppNavigateHandler = (page: AppPage) => void;
type AppUpdateReadyHandler = () => void;
type ClipsStatusChangedHandler = (status: ClipsStatus) => void;
type ClipsLibraryChangedHandler = () => void;

type StopRecordingRequestHandler = () => void;
type ClipAudioSnapshotRequestHandler = (request: ClipAudioSnapshotRequest) => void;
export type ToastTone = "error" | "info";

export interface ToastMessage {
  detail: string | null;
  id: number;
  isClickable: boolean;
  title: string;
  tone: ToastTone;
}

type ToastShowHandler = (toast: ToastMessage) => void;

export interface SoftshotApi {
  appendRecordingFileChunk(recordingId: string, bytes: Uint8Array): Promise<void>;
  createRecordingFile(fileExtension: OutputFileExtension): Promise<RecordingFile>;
  discardRecordingFile(recordingId: string): Promise<void>;
  getBootstrap(): Promise<OverlayBootstrap>;
  saveScreenshot(bytes: Uint8Array): Promise<SaveDialogResult>;
  copyScreenshot(bytes: Uint8Array): Promise<void>;
  openVideoEditor(
    recordingId: string,
    fps: VideoFps,
    durationSeconds: number,
    mimeType: string,
    encoder: RecordingEncoder,
    capturePipeline: CapturePipeline,
    audioTracks: RecordingAudioTrack[]
  ): Promise<void>;
  getEditorBootstrap(): Promise<EditorBootstrap>;
  getEditorVideoFileSize(): Promise<number>;
  readEditorVideoFile(start: number, end: number): Promise<Uint8Array>;
  getEditorAudioFileSize(kind: AudioSourceKind): Promise<number>;
  readEditorAudioFile(kind: AudioSourceKind, start: number, end: number): Promise<Uint8Array>;
  chooseEditorVideoSavePath(): Promise<SaveDialogResult>;
  chooseEditorExportPath(fileExtension: OutputFileExtension, fileLabel: string): Promise<SaveDialogResult>;
  completeEditorOutputFile(recordingId: string, fileExtension: OutputFileExtension): Promise<CompletedOutputFile>;
  trimEditorVideoEnd(endSeconds: number): Promise<PreparedVideoFile>;
  savePreparedEditorVideo(preparedFilePath: string, targetFilePath: string): Promise<SaveResult>;
  copyPreparedEditorVideo(filePath: string): Promise<void>;
  closeEditor(): Promise<void>;
  readyToShow(): Promise<void>;
  selectCaptureDisplay(displayId: number): Promise<void>;
  setLiveCapture(isLive: boolean): Promise<void>;
  setLiveCaptureMousePassthrough(isPassthrough: boolean): Promise<void>;
  onStopRecordingRequest(handler: StopRecordingRequestHandler): () => void;
  closeOverlay(): Promise<void>;
  showError(message: string): Promise<void>;
  appReadyToShow(): Promise<void>;
  beginShortcutRecording(target: ShortcutTarget): Promise<void>;
  getAppInfo(): Promise<AppInfo>;
  getSettings(): Promise<AppSettings>;
  installUpdate(): Promise<void>;
  onAppNavigate(handler: AppNavigateHandler): () => void;
  onAppUpdateReady(handler: AppUpdateReadyHandler): () => void;
  onShortcutRecordingEvent(handler: ShortcutRecordingEventHandler): () => void;
  onSettingsChanged(handler: SettingsChangedEventHandler): () => void;
  updateSettings(settings: AppSettingsUpdate): Promise<AppSettings>;
  chooseClipsDirectory(): Promise<AppSettings | null>;
  copyClip(clipId: string): Promise<void>;
  deleteClip(clipId: string): Promise<void>;
  getClipsDirectory(): Promise<string>;
  getClipsStatus(): Promise<ClipsStatus>;
  listClips(): Promise<ClipEntry[]>;
  listClipSources(): Promise<ClipSourceOptions>;
  onClipsLibraryChanged(handler: ClipsLibraryChangedHandler): () => void;
  onClipsStatusChanged(handler: ClipsStatusChangedHandler): () => void;
  openClip(clipId: string): Promise<void>;
  openClipsDirectory(): Promise<void>;
  restartClips(): Promise<void>;
  saveClip(): Promise<void>;
  showClipInFolder(clipId: string): Promise<void>;
  completeClipAudioSnapshot(requestId: string, recordingId: string): Promise<void>;
  failClipAudioSnapshot(requestId: string, message: string): Promise<void>;
  getClipRecorderConfig(): Promise<ClipRecorderConfig>;
  onClipAudioSnapshotRequest(handler: ClipAudioSnapshotRequestHandler): () => void;
  reportClipRecorderEnded(): Promise<void>;
  reportClipRecorderFailed(message: string): Promise<void>;
  reportClipRecorderStarted(): Promise<void>;
  clickToast(toastId: number): Promise<void>;
  finishToast(toastId: number): Promise<void>;
  onToastShow(handler: ToastShowHandler): () => void;
  setToastPointerInside(toastId: number, isInside: boolean): Promise<void>;
}

export function epochSeconds(): number {
  return (performance.timeOrigin + performance.now()) / millisecondsPerSecond;
}

export function fileTimestamp(value: Date): string {
  const year = String(value.getFullYear());
  const month = padDatePart(value.getMonth() + 1);
  const day = padDatePart(value.getDate());
  const hours = padDatePart(value.getHours());
  const minutes = padDatePart(value.getMinutes());
  const seconds = padDatePart(value.getSeconds());
  return `${year}-${month}-${day} ${hours}.${minutes}.${seconds}`;
}

function padDatePart(part: number): string {
  return part.toString().padStart(timestampPartWidth, "0");
}

export function clipDurationLabel(durationSeconds: number): string {
  if (durationSeconds < secondsPerMinute || durationSeconds % secondsPerMinute !== 0) {
    return durationSeconds === 1 ? "1 second" : `${String(durationSeconds)} seconds`;
  }

  const minutes = durationSeconds / secondsPerMinute;
  return minutes === 1 ? "1 minute" : `${String(minutes)} minutes`;
}

const appPageSet: ReadonlySet<unknown> = new Set(appPages);

export function isAppPage(value: unknown): value is AppPage {
  return appPageSet.has(value);
}

export function isAudioSourceKind(value: unknown): value is AudioSourceKind {
  return audioSourceKindSet.has(value);
}

export function isOutputFileExtension(value: unknown): value is OutputFileExtension {
  return outputFileExtensionSet.has(value);
}

export function videoFileExtension(mimeType: string): VideoFileExtension {
  return mimeType.startsWith("video/mp4") ? "mp4" : "webm";
}

export function isRecordingAudioSourceKind(value: unknown): value is RecordingAudioSourceKind {
  return recordingAudioSourceKindSet.has(value);
}
