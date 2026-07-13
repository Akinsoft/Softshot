const standardVideoFps = 30;
const highVideoFps = 60;
const lowVideoHeight = 720;
const lowVideoWidth = 1280;
const highVideoHeight = 1080;
const highVideoWidth = 1920;

export const videoFpsOptions = {
  standard: standardVideoFps,
  high: highVideoFps
} as const;

export const videoQualityDimensions = {
  low: { height: lowVideoHeight, width: lowVideoWidth },
  high: { height: highVideoHeight, width: highVideoWidth }
} as const;

export type CaptureMode = "screenshot" | "video";
export type CapturePipeline = "composited" | "direct";
export type DrawingTool = "select" | "pen" | "arrow";
export type AudioSourceKind = "microphone" | "system";
export type VideoQuality = "720p" | "1080p";
export type VideoFps = (typeof videoFpsOptions)[keyof typeof videoFpsOptions];
export type VideoFileExtension = "mp4" | "webm";
export type RecordingEncoder = "hardware" | "compatibility";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OverlayBootstrap {
  imageBytes: Uint8Array;
}

export interface EditorBootstrap {
  audioTracks: EditorAudioTrack[];
  capturePipeline: CapturePipeline;
  durationSeconds: number;
  encoder: RecordingEncoder;
  fps: VideoFps;
  mimeType: string;
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
  kind: AudioSourceKind;
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

export interface AppSettings {
  captureShortcut: string;
  launchAtStartup: boolean;
  microphoneDeviceId: string | null;
  systemAudioEnabled: boolean;
}

export interface AppSettingsUpdate {
  captureShortcut?: string;
  launchAtStartup?: boolean;
  microphoneDeviceId?: string | null;
  systemAudioEnabled?: boolean;
}

export type SettingsKeybindEvent =
  | { type: "cancelled" }
  | { message: string; type: "error" }
  | { shortcut: string; type: "preview" }
  | { settings: AppSettings; type: "saved" };

export type SettingsKeybindEventHandler = (event: SettingsKeybindEvent) => void;
export type SettingsChangedEventHandler = (settings: AppSettings) => void;

export type StopRecordingRequestHandler = () => void;

export interface SoftshotApi {
  appendRecordingFileChunk(recordingId: string, bytes: Uint8Array): Promise<void>;
  createRecordingFile(fileExtension: VideoFileExtension): Promise<RecordingFile>;
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
  completeEditorVideoFile(recordingId: string, mimeType: string): Promise<PreparedVideoFile>;
  trimEditorVideoEnd(endSeconds: number): Promise<PreparedVideoFile>;
  savePreparedEditorVideo(preparedFilePath: string, targetFilePath: string): Promise<SaveResult>;
  copyPreparedEditorVideo(filePath: string): Promise<void>;
  closeEditor(): Promise<void>;
  readyToShow(): Promise<void>;
  setLiveCapture(isLive: boolean): Promise<void>;
  setLiveCaptureMousePassthrough(isPassthrough: boolean): Promise<void>;
  onStopRecordingRequest(handler: StopRecordingRequestHandler): () => void;
  closeOverlay(): Promise<void>;
  showError(message: string): Promise<void>;
  closeSettings(): Promise<void>;
  beginSettingsKeybindRecording(): Promise<void>;
  endSettingsKeybindRecording(): Promise<void>;
  getSettings(): Promise<AppSettings>;
  onSettingsKeybindEvent(handler: SettingsKeybindEventHandler): () => void;
  onSettingsChanged(handler: SettingsChangedEventHandler): () => void;
  settingsReadyToShow(): Promise<void>;
  updateSettings(settings: AppSettingsUpdate): Promise<AppSettings>;
}
