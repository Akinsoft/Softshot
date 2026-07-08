import { contextBridge, ipcRenderer } from "electron";

import type { EditorBootstrap, OverlayBootstrap, PreparedVideoFile, SaveDialogResult, SaveResult, SoftshotApi, VideoFps } from "./shared";

const api: SoftshotApi = {
  getBootstrap: async () => ipcRenderer.invoke("overlay:get-bootstrap") as Promise<OverlayBootstrap>,
  saveScreenshot: async (dataUrl: string) =>
    ipcRenderer.invoke("capture:save-screenshot", dataUrl) as Promise<SaveResult>,
  copyScreenshot: async (dataUrl: string) => ipcRenderer.invoke("capture:copy-screenshot", dataUrl) as Promise<void>,
  openVideoEditor: async (bytes: Uint8Array, fps: VideoFps, durationSeconds: number, mimeType: string) =>
    ipcRenderer.invoke("recording:open-editor", bytes, fps, durationSeconds, mimeType) as Promise<void>,
  getEditorBootstrap: async () => ipcRenderer.invoke("editor:get-bootstrap") as Promise<EditorBootstrap>,
  chooseEditorVideoSavePath: async () => ipcRenderer.invoke("editor:choose-save-path") as Promise<SaveDialogResult>,
  prepareEditorVideoFile: async (bytes: Uint8Array) =>
    ipcRenderer.invoke("editor:prepare-video-file", bytes) as Promise<PreparedVideoFile>,
  savePreparedEditorVideo: async (preparedFilePath: string, targetFilePath: string) =>
    ipcRenderer.invoke("editor:save-prepared-video", preparedFilePath, targetFilePath) as Promise<SaveResult>,
  copyPreparedEditorVideo: async (filePath: string) => ipcRenderer.invoke("editor:copy-prepared-video", filePath) as Promise<void>,
  closeEditor: async () => ipcRenderer.invoke("editor:close") as Promise<void>,
  readyToShow: async () => ipcRenderer.invoke("overlay:ready-to-show") as Promise<void>,
  closeOverlay: async () => ipcRenderer.invoke("overlay:close") as Promise<void>,
  showError: async (message: string) => ipcRenderer.invoke("overlay:show-error", message) as Promise<void>
};

contextBridge.exposeInMainWorld("softshot", api);
