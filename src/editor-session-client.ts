import type {
  AudioSourceKind,
  CompletedOutputFile,
  OutputFileExtension,
  PreparedVideoFile,
  SaveDialogResult,
  SaveResult
} from "./shared.js";
import { getSoftshotApi } from "./softshot-api.js";

export interface EditorByteSource {
  getSize(): Promise<number>;
  read(start: number, end: number): Promise<Uint8Array>;
}

export class EditorSessionClient {
  constructor(readonly sessionId: string) {}

  audioSource(kind: AudioSourceKind): EditorByteSource {
    const api = getSoftshotApi();
    return {
      getSize: async (): Promise<number> => await api.getEditorAudioFileSize(this.sessionId, kind),
      read: async (start, end): Promise<Uint8Array> => await api.readEditorAudioFile(this.sessionId, kind, start, end)
    };
  }

  async chooseExportPath(fileExtension: OutputFileExtension, fileLabel: string): Promise<SaveDialogResult> {
    return await getSoftshotApi().chooseEditorExportPath(this.sessionId, fileExtension, fileLabel);
  }

  async chooseVideoSavePath(): Promise<SaveDialogResult> {
    return await getSoftshotApi().chooseEditorVideoSavePath(this.sessionId);
  }

  async close(): Promise<void> {
    await getSoftshotApi().closeEditor(this.sessionId);
  }

  async completeOutputFile(recordingId: string, fileExtension: OutputFileExtension): Promise<CompletedOutputFile> {
    return await getSoftshotApi().completeEditorOutputFile(this.sessionId, recordingId, fileExtension);
  }

  async confirmClose(): Promise<boolean> {
    return await getSoftshotApi().confirmCloseEditor(this.sessionId);
  }

  async copyPreparedVideo(filePath: string): Promise<void> {
    await getSoftshotApi().copyPreparedEditorVideo(this.sessionId, filePath);
  }

  async savePreparedVideo(preparedFilePath: string, targetFilePath: string): Promise<SaveResult> {
    return await getSoftshotApi().savePreparedEditorVideo(this.sessionId, preparedFilePath, targetFilePath);
  }

  async setUnsavedEdits(hasUnsavedEdits: boolean): Promise<void> {
    await getSoftshotApi().setEditorUnsavedEdits(this.sessionId, hasUnsavedEdits);
  }

  async trimVideoEnd(endSeconds: number): Promise<PreparedVideoFile> {
    return await getSoftshotApi().trimEditorVideoEnd(this.sessionId, endSeconds);
  }

  videoSource(): EditorByteSource {
    const api = getSoftshotApi();
    return {
      getSize: async (): Promise<number> => await api.getEditorVideoFileSize(this.sessionId),
      read: async (start, end): Promise<Uint8Array> => await api.readEditorVideoFile(this.sessionId, start, end)
    };
  }
}
