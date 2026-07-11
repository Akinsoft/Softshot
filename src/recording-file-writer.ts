import type { VideoFileExtension } from "./shared.js";
import { getSoftshotApi } from "./softshot-api.js";

const recordingChunkIntervalMs = 1000;

export class RecordingFileWriter {
  static async create(fileExtension: VideoFileExtension): Promise<RecordingFileWriter> {
    const recordingFile = await getSoftshotApi().createRecordingFile(fileExtension);
    return new RecordingFileWriter(recordingFile.id);
  }

  private isDiscarded = false;

  private writeChain: Promise<void> = Promise.resolve();

  private writeError: unknown = null;

  private constructor(readonly recordingId: string) {}

  private async flushWrites(): Promise<void> {
    await this.writeChain;
    if (this.writeError) {
      throw new Error("Could not write the recording file.", { cause: this.writeError });
    }
  }

  private queueChunkWrite(blob: Blob): void {
    const previousWrite = this.writeChain;
    this.writeChain = this.writeQueuedChunk(previousWrite, blob);
  }

  private async writeBlobChunk(blob: Blob): Promise<void> {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await this.writeBytes(bytes);
  }

  private async writeBytes(bytes: Uint8Array): Promise<void> {
    await getSoftshotApi().appendRecordingFileChunk(this.recordingId, bytes);
  }

  private async writeQueuedChunk(previousWrite: Promise<void>, blob: Blob): Promise<void> {
    await previousWrite;
    if (this.writeError) {
      return;
    }

    try {
      await this.writeBlobChunk(blob);
    } catch (error) {
      this.writeError = error;
    }
  }

  connect(recorder: MediaRecorder): void {
    recorder.addEventListener("dataavailable", (event): void => {
      if (event.data.size > 0) {
        this.queueChunkWrite(event.data);
      }
    });
  }

  async discard(): Promise<void> {
    if (this.isDiscarded) {
      return;
    }

    await getSoftshotApi().discardRecordingFile(this.recordingId);
    this.isDiscarded = true;
  }

  async finalize(): Promise<void> {
    await this.flushWrites();
  }

  start(recorder: MediaRecorder): void {
    recorder.start(recordingChunkIntervalMs);
  }

  writableStream(): WritableStream<Uint8Array> {
    return new WritableStream({
      write: async (bytes): Promise<void> => {
        await this.writeBytes(bytes);
      }
    });
  }
}
