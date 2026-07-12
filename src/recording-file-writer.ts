import type { VideoFileExtension } from "./shared.js";
import { getSoftshotApi } from "./softshot-api.js";

const recordingChunkIntervalMs = 1000;
const recorderStopTimeoutMs = 10_000;

type RecordingFileErrorHandler = (error: unknown) => void;

export class RecordingFileWriter {
  static async create(fileExtension: VideoFileExtension): Promise<RecordingFileWriter> {
    const recordingFile = await getSoftshotApi().createRecordingFile(fileExtension);
    return new RecordingFileWriter(recordingFile.id);
  }

  private isDiscarded = false;

  private isDiscarding = false;

  private discardPromise: Promise<void> | null = null;

  private readonly errorHandlers = new Set<RecordingFileErrorHandler>();

  private firstError: unknown = null;

  private hasError = false;

  private recorderError: unknown = null;

  private writeChain: Promise<void> = Promise.resolve();

  private writeError: unknown = null;

  private constructor(readonly recordingId: string) {}

  private async flushWrites(): Promise<void> {
    await this.writeChain;
    const errors: Error[] = [];
    if (this.writeError !== null) {
      errors.push(new Error("Could not write the recording file.", { cause: this.writeError }));
    }

    if (this.recorderError !== null) {
      errors.push(new Error("The media encoder failed while recording.", { cause: this.recorderError }));
    }

    if (errors.length === 1) {
      throw errors[0];
    }

    if (errors.length > 1) {
      throw new AggregateError(errors, "The recording encoder and file writer both failed.");
    }
  }

  private queueChunkWrite(blob: Blob): void {
    if (this.isDiscarded || this.isDiscarding) {
      return;
    }

    const previousWrite = this.writeChain;
    this.writeChain = this.writeQueuedChunk(previousWrite, blob);
  }

  private async writeBlobChunk(blob: Blob): Promise<void> {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await this.writeBytes(bytes);
  }

  private async writeBytes(bytes: Uint8Array): Promise<void> {
    if (this.isDiscarded || this.isDiscarding) {
      throw new Error("Cannot write to a discarded recording file.");
    }

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
      this.setWriteError(error);
    }
  }

  private notifyError(error: unknown): void {
    if (this.hasError) {
      return;
    }

    this.firstError = error;
    this.hasError = true;
    for (const handler of this.errorHandlers) {
      handler(error);
    }
  }

  private setRecorderError(error: unknown): void {
    if (this.recorderError !== null) {
      return;
    }

    this.recorderError = error;
    this.notifyError(error);
  }

  private setWriteError(error: unknown): void {
    if (this.writeError !== null) {
      return;
    }

    this.writeError = error;
    this.notifyError(error);
  }

  private async discardFile(): Promise<void> {
    await this.writeChain;
    await getSoftshotApi().discardRecordingFile(this.recordingId);
  }

  connect(recorder: MediaRecorder): void {
    recorder.addEventListener("error", (event): void => {
      this.setRecorderError(event.error);
    });
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

    if (this.discardPromise) {
      await this.discardPromise;
      return;
    }

    this.isDiscarding = true;
    this.discardPromise = this.discardFile();
    try {
      await this.discardPromise;
      this.isDiscarded = true;
    } finally {
      this.isDiscarding = false;
      this.discardPromise = null;
    }
  }

  async finalize(): Promise<void> {
    await this.flushWrites();
  }

  onError(handler: RecordingFileErrorHandler): () => void {
    this.errorHandlers.add(handler);
    if (this.hasError) {
      queueMicrotask((): void => {
        if (this.errorHandlers.has(handler)) {
          handler(this.firstError);
        }
      });
    }

    return (): void => {
      this.errorHandlers.delete(handler);
    };
  }

  reportEncoderError(error: unknown): void {
    this.setRecorderError(error);
  }

  start(recorder: MediaRecorder): void {
    recorder.start(recordingChunkIntervalMs);
  }

  writableStream(): WritableStream<Uint8Array> {
    return new WritableStream({
      write: async (bytes): Promise<void> => {
        try {
          await this.writeBytes(bytes);
        } catch (error) {
          this.setWriteError(error);
          throw error;
        }
      }
    });
  }

}

export async function stopMediaRecorder(recorder: MediaRecorder, writer: RecordingFileWriter): Promise<void> {
  if (recorder.state === "inactive") {
    await writer.finalize();
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    function cleanup(): void {
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
      }

      recorder.removeEventListener("stop", onStop);
    }
    function onStop(): void {
      cleanup();
      resolve();
    }

    recorder.addEventListener("stop", onStop, { once: true });
    timeoutHandle = setTimeout((): void => {
      cleanup();
      reject(new Error("Timed out stopping the media encoder."));
    }, recorderStopTimeoutMs);
    try {
      recorder.stop();
    } catch (error) {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
  await writer.finalize();
}
