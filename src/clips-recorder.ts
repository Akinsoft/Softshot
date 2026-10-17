import { combinedError, errorMessage, rejectedReasons } from "./async-errors.js";
import { ClipAudioBuffer } from "./clip-buffer.js";
import { RecordingFileWriter } from "./recording-file-writer.js";
import type { ClipAudioSnapshotRequest } from "./shared.js";
import { getSoftshotApi } from "./softshot-api.js";
import { TaskQueue } from "./task-queue.js";

class ClipAudioRecorder {
  private readonly snapshots = new TaskQueue();

  constructor(private readonly buffer: ClipAudioBuffer) {}

  private async writeSnapshot(request: ClipAudioSnapshotRequest): Promise<string> {
    const parts = await this.buffer.snapshot(request.fromEpochSeconds, request.untilEpochSeconds);
    const writer = await RecordingFileWriter.create("mp4");
    try {
      const streamWriter = writer.writableStream().getWriter();
      for (const part of parts) {
        await streamWriter.write(part);
      }

      await streamWriter.close();
      await writer.finalize();
    } catch (error) {
      const cleanupResults = await Promise.allSettled([writer.discard()]);
      throw combinedError("Could not write the clip audio.", [error, ...rejectedReasons(cleanupResults)]);
    }

    return writer.recordingId;
  }

  private async answerSnapshot(request: ClipAudioSnapshotRequest): Promise<void> {
    const api = getSoftshotApi();
    try {
      await api.completeClipAudioSnapshot(request.id, await this.writeSnapshot(request));
    } catch (error) {
      await api.failClipAudioSnapshot(request.id, errorMessage(error));
    }
  }

  queueSnapshot(request: ClipAudioSnapshotRequest): void {
    void this.snapshots.run(async (): Promise<void> => {
      await this.answerSnapshot(request);
    });
  }
}

async function startClipAudioRecorder(): Promise<void> {
  const api = getSoftshotApi();
  try {
    const config = await api.getClipRecorderConfig();
    const buffer = await ClipAudioBuffer.create(config);
    const recorder = new ClipAudioRecorder(buffer);
    buffer.onEnded((): void => {
      void api.reportClipRecorderEnded();
    });
    buffer.onError((error): void => {
      void api.reportClipRecorderFailed(errorMessage(error));
    });
    api.onClipAudioSnapshotRequest((request): void => {
      recorder.queueSnapshot(request);
    });
    await buffer.waitUntilRecording();
    await api.reportClipRecorderStarted();
  } catch (error) {
    await api.reportClipRecorderFailed(errorMessage(error));
  }
}

await startClipAudioRecorder();
