import { contextBridge, ipcRenderer } from "electron";

import type {
  AppInfo,
  AppPage,
  AppSettings,
  AppSettingsUpdate,
  AudioSourceKind,
  CapturePipeline,
  ClipAudioSnapshotRequest,
  ClipEntry,
  ClipRecorderConfig,
  ClipSourceOptions,
  ClipsStatus,
  CompletedOutputFile,
  EditorBootstrap,
  OutputFileExtension,
  OverlayBootstrap,
  PreparedVideoFile,
  RecordingAudioTrack,
  RecordingEncoder,
  RecordingFile,
  SaveDialogResult,
  SaveResult,
  ShortcutRecordingEvent,
  ShortcutTarget,
  SoftshotApi,
  ToastMessage,
  VideoFps
} from "./shared";

const stopRecordingRequestChannel = "overlay:stop-recording";
const shortcutRecordingEventChannel = "app:shortcut-recording-event";
const settingsChangedEventChannel = "settings:changed";
const appNavigateEventChannel = "app:navigate";
const appUpdateReadyEventChannel = "app:update-ready";
const clipsStatusChangedEventChannel = "clips:status-changed";
const clipsLibraryChangedEventChannel = "clips:library-changed";
const clipAudioSnapshotRequestChannel = "clips:audio-snapshot-request";
const toastShowChannel = "toast:show";

function subscribe(channel: string, handler: (value: never) => void): () => void {
  const listener = (...listenerArguments: [Electron.IpcRendererEvent, unknown]): void => {
    handler(listenerArguments[1] as never);
  };

  ipcRenderer.on(channel, listener);
  return (): void => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api: SoftshotApi = {
  appendRecordingFileChunk: async (recordingId: string, bytes: Uint8Array) =>
    ipcRenderer.invoke("recording:append-file-chunk", recordingId, bytes) as Promise<void>,
  createRecordingFile: async (fileExtension: OutputFileExtension) =>
    ipcRenderer.invoke("recording:create-file", fileExtension) as Promise<RecordingFile>,
  discardRecordingFile: async (recordingId: string) =>
    ipcRenderer.invoke("recording:discard-file", recordingId) as Promise<void>,
  getBootstrap: async () => ipcRenderer.invoke("overlay:get-bootstrap") as Promise<OverlayBootstrap>,
  saveScreenshot: async (bytes: Uint8Array) =>
    ipcRenderer.invoke("capture:save-screenshot", bytes) as Promise<SaveDialogResult>,
  copyScreenshot: async (bytes: Uint8Array) => ipcRenderer.invoke("capture:copy-screenshot", bytes) as Promise<void>,
  openVideoEditor: async (
    recordingId: string,
    fps: VideoFps,
    durationSeconds: number,
    mimeType: string,
    encoder: RecordingEncoder,
    capturePipeline: CapturePipeline,
    audioTracks: RecordingAudioTrack[]
  ) =>
    ipcRenderer.invoke(
      "recording:open-editor",
      recordingId,
      fps,
      durationSeconds,
      mimeType,
      encoder,
      capturePipeline,
      audioTracks
    ) as Promise<void>,
  getEditorBootstrap: async () => ipcRenderer.invoke("editor:get-bootstrap") as Promise<EditorBootstrap>,
  getEditorVideoFileSize: async () => ipcRenderer.invoke("editor:get-video-file-size") as Promise<number>,
  readEditorVideoFile: async (start: number, end: number) =>
    ipcRenderer.invoke("editor:read-video-file", start, end) as Promise<Uint8Array>,
  getEditorAudioFileSize: async (kind: AudioSourceKind) =>
    ipcRenderer.invoke("editor:get-audio-file-size", kind) as Promise<number>,
  readEditorAudioFile: async (kind: AudioSourceKind, start: number, end: number) =>
    ipcRenderer.invoke("editor:read-audio-file", kind, start, end) as Promise<Uint8Array>,
  chooseEditorVideoSavePath: async () => ipcRenderer.invoke("editor:choose-save-path") as Promise<SaveDialogResult>,
  chooseEditorExportPath: async (fileExtension: OutputFileExtension, fileLabel: string) =>
    ipcRenderer.invoke("editor:choose-export-path", fileExtension, fileLabel) as Promise<SaveDialogResult>,
  completeEditorOutputFile: async (recordingId: string, fileExtension: OutputFileExtension) =>
    ipcRenderer.invoke("editor:complete-output-file", recordingId, fileExtension) as Promise<CompletedOutputFile>,
  trimEditorVideoEnd: async (endSeconds: number) =>
    ipcRenderer.invoke("editor:trim-video-end", endSeconds) as Promise<PreparedVideoFile>,
  savePreparedEditorVideo: async (preparedFilePath: string, targetFilePath: string) =>
    ipcRenderer.invoke("editor:save-prepared-video", preparedFilePath, targetFilePath) as Promise<SaveResult>,
  copyPreparedEditorVideo: async (filePath: string) => ipcRenderer.invoke("editor:copy-prepared-video", filePath) as Promise<void>,
  closeEditor: async () => ipcRenderer.invoke("editor:close") as Promise<void>,
  readyToShow: async () => ipcRenderer.invoke("overlay:ready-to-show") as Promise<void>,
  selectCaptureDisplay: async (displayId: number) =>
    ipcRenderer.invoke("overlay:select-capture-display", displayId) as Promise<void>,
  setLiveCapture: async (isLive: boolean) => ipcRenderer.invoke("overlay:set-live-capture", isLive) as Promise<void>,
  setLiveCaptureMousePassthrough: async (isPassthrough: boolean) =>
    ipcRenderer.invoke("overlay:set-live-capture-mouse-passthrough", isPassthrough) as Promise<void>,
  onStopRecordingRequest: (handler: () => void) => subscribe(stopRecordingRequestChannel, handler),
  closeOverlay: async () => ipcRenderer.invoke("overlay:close") as Promise<void>,
  showError: async (message: string) => ipcRenderer.invoke("overlay:show-error", message) as Promise<void>,
  appReadyToShow: async () => ipcRenderer.invoke("app:ready-to-show") as Promise<void>,
  beginShortcutRecording: async (target: ShortcutTarget) =>
    ipcRenderer.invoke("app:begin-shortcut-recording", target) as Promise<void>,
  getAppInfo: async () => ipcRenderer.invoke("app:get-info") as Promise<AppInfo>,
  getSettings: async () => ipcRenderer.invoke("settings:get") as Promise<AppSettings>,
  installUpdate: async () => ipcRenderer.invoke("app:install-update") as Promise<void>,
  onAppNavigate: (handler: (page: AppPage) => void) => subscribe(appNavigateEventChannel, handler),
  onAppUpdateReady: (handler: () => void) => subscribe(appUpdateReadyEventChannel, handler),
  onShortcutRecordingEvent: (handler: (event: ShortcutRecordingEvent) => void) =>
    subscribe(shortcutRecordingEventChannel, handler),
  onSettingsChanged: (handler: (settings: AppSettings) => void) => subscribe(settingsChangedEventChannel, handler),
  updateSettings: async (settings: AppSettingsUpdate) =>
    ipcRenderer.invoke("settings:update", settings) as Promise<AppSettings>,
  chooseClipsDirectory: async () => ipcRenderer.invoke("clips:choose-directory") as Promise<AppSettings | null>,
  copyClip: async (clipId: string) => ipcRenderer.invoke("clips:copy", clipId) as Promise<void>,
  deleteClip: async (clipId: string) => ipcRenderer.invoke("clips:delete", clipId) as Promise<void>,
  getClipsDirectory: async () => ipcRenderer.invoke("clips:get-directory") as Promise<string>,
  getClipsStatus: async () => ipcRenderer.invoke("clips:get-status") as Promise<ClipsStatus>,
  listClips: async () => ipcRenderer.invoke("clips:list") as Promise<ClipEntry[]>,
  listClipSources: async () => ipcRenderer.invoke("clips:list-sources") as Promise<ClipSourceOptions>,
  onClipsLibraryChanged: (handler: () => void) => subscribe(clipsLibraryChangedEventChannel, handler),
  onClipsStatusChanged: (handler: (status: ClipsStatus) => void) => subscribe(clipsStatusChangedEventChannel, handler),
  openClip: async (clipId: string) => ipcRenderer.invoke("clips:open", clipId) as Promise<void>,
  openClipsDirectory: async () => ipcRenderer.invoke("clips:open-directory") as Promise<void>,
  restartClips: async () => ipcRenderer.invoke("clips:restart") as Promise<void>,
  showClipInFolder: async (clipId: string) => ipcRenderer.invoke("clips:show-in-folder", clipId) as Promise<void>,
  completeClipAudioSnapshot: async (requestId: string, recordingId: string) =>
    ipcRenderer.invoke("clips:audio-snapshot-ready", requestId, recordingId) as Promise<void>,
  failClipAudioSnapshot: async (requestId: string, message: string) =>
    ipcRenderer.invoke("clips:audio-snapshot-failed", requestId, message) as Promise<void>,
  getClipRecorderConfig: async () => ipcRenderer.invoke("clips:get-recorder-config") as Promise<ClipRecorderConfig>,
  onClipAudioSnapshotRequest: (handler: (request: ClipAudioSnapshotRequest) => void) =>
    subscribe(clipAudioSnapshotRequestChannel, handler),
  reportClipRecorderEnded: async () => ipcRenderer.invoke("clips:recorder-ended") as Promise<void>,
  reportClipRecorderFailed: async (message: string) => ipcRenderer.invoke("clips:recorder-failed", message) as Promise<void>,
  reportClipRecorderStarted: async () => ipcRenderer.invoke("clips:recorder-started") as Promise<void>,
  clickToast: async (toastId: number) => ipcRenderer.invoke("toast:clicked", toastId) as Promise<void>,
  finishToast: async (toastId: number) => ipcRenderer.invoke("toast:finished", toastId) as Promise<void>,
  onToastShow: (handler: (toast: ToastMessage) => void) => subscribe(toastShowChannel, handler),
  setToastPointerInside: async (toastId: number, isInside: boolean) =>
    ipcRenderer.invoke("toast:set-pointer-inside", toastId, isInside) as Promise<void>
};

contextBridge.exposeInMainWorld("softshot", api);
