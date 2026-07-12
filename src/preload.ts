import { contextBridge, ipcRenderer } from "electron";

import type {
  AppSettings,
  AppSettingsUpdate,
  CapturePipeline,
  EditorBootstrap,
  OverlayBootstrap,
  PreparedVideoFile,
  RecordingAudioTrack,
  RecordingEncoder,
  RecordingFile,
  SaveDialogResult,
  SaveResult,
  SettingsChangedEventHandler,
  SettingsKeybindEvent,
  SettingsKeybindEventHandler,
  SoftshotApi,
  StopRecordingRequestHandler,
  VideoFileExtension,
  VideoFps
} from "./shared";

const stopRecordingRequestChannel = "overlay:stop-recording";
const settingsKeybindEventChannel = "settings:keybind-event";
const settingsChangedEventChannel = "settings:changed";

const api: SoftshotApi = {
  appendRecordingFileChunk: async (recordingId: string, bytes: Uint8Array) =>
    ipcRenderer.invoke("recording:append-file-chunk", recordingId, bytes) as Promise<void>,
  createRecordingFile: async (fileExtension: VideoFileExtension) =>
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
  chooseEditorVideoSavePath: async () => ipcRenderer.invoke("editor:choose-save-path") as Promise<SaveDialogResult>,
  completeEditorVideoFile: async (recordingId: string, mimeType: string) =>
    ipcRenderer.invoke("editor:complete-video-file", recordingId, mimeType) as Promise<PreparedVideoFile>,
  trimEditorVideoEnd: async (endSeconds: number) =>
    ipcRenderer.invoke("editor:trim-video-end", endSeconds) as Promise<PreparedVideoFile>,
  savePreparedEditorVideo: async (preparedFilePath: string, targetFilePath: string) =>
    ipcRenderer.invoke("editor:save-prepared-video", preparedFilePath, targetFilePath) as Promise<SaveResult>,
  copyPreparedEditorVideo: async (filePath: string) => ipcRenderer.invoke("editor:copy-prepared-video", filePath) as Promise<void>,
  closeEditor: async () => ipcRenderer.invoke("editor:close") as Promise<void>,
  readyToShow: async () => ipcRenderer.invoke("overlay:ready-to-show") as Promise<void>,
  setLiveCapture: async (isLive: boolean) => ipcRenderer.invoke("overlay:set-live-capture", isLive) as Promise<void>,
  setLiveCaptureMousePassthrough: async (isPassthrough: boolean) =>
    ipcRenderer.invoke("overlay:set-live-capture-mouse-passthrough", isPassthrough) as Promise<void>,
  onStopRecordingRequest: (handler: StopRecordingRequestHandler) => {
    const listener = (): void => {
      handler();
    };

    ipcRenderer.on(stopRecordingRequestChannel, listener);
    return (): void => {
      ipcRenderer.removeListener(stopRecordingRequestChannel, listener);
    };
  },
  closeOverlay: async () => ipcRenderer.invoke("overlay:close") as Promise<void>,
  showError: async (message: string) => ipcRenderer.invoke("overlay:show-error", message) as Promise<void>,
  closeSettings: async () => ipcRenderer.invoke("settings:close") as Promise<void>,
  beginSettingsKeybindRecording: async () => ipcRenderer.invoke("settings:begin-keybind-recording") as Promise<void>,
  endSettingsKeybindRecording: async () => ipcRenderer.invoke("settings:end-keybind-recording") as Promise<void>,
  getSettings: async () => ipcRenderer.invoke("settings:get") as Promise<AppSettings>,
  onSettingsKeybindEvent: (handler: SettingsKeybindEventHandler) => {
    const listener = (...listenerArguments: [Electron.IpcRendererEvent, SettingsKeybindEvent]): void => {
      const data = listenerArguments[1];
      handler(data);
    };

    ipcRenderer.on(settingsKeybindEventChannel, listener);
    return (): void => {
      ipcRenderer.removeListener(settingsKeybindEventChannel, listener);
    };
  },
  onSettingsChanged: (handler: SettingsChangedEventHandler) => {
    const listener = (...listenerArguments: [Electron.IpcRendererEvent, AppSettings]): void => {
      handler(listenerArguments[1]);
    };

    ipcRenderer.on(settingsChangedEventChannel, listener);
    return (): void => {
      ipcRenderer.removeListener(settingsChangedEventChannel, listener);
    };
  },
  settingsReadyToShow: async () => ipcRenderer.invoke("settings:ready-to-show") as Promise<void>,
  updateSettings: async (settings: AppSettingsUpdate) =>
    ipcRenderer.invoke("settings:update", settings) as Promise<AppSettings>
};

contextBridge.exposeInMainWorld("softshot", api);
