import { combinedError, rejectedReasons, throwCollectedErrors } from "./async-errors.js";
import { microphoneConstraints } from "./audio-devices.js";
import {
  audioMixGain,
  recordingAudioMasterBitrate,
  recordingAudioMasterMimeType,
  recordingAudioSampleRate
} from "./audio-quality.js";
import { stopTracks } from "./desktop-capture.js";
import { RecordingFileWriter, stopMediaRecorder } from "./recording-file-writer.js";
import type { AudioSourceKind, RecordingAudioTrack } from "./shared.js";

type RecordingAudioErrorHandler = (error: unknown) => void;

interface AudioInput {
  kind: AudioSourceKind;
  track: MediaStreamTrack;
}

interface AudioRecorder {
  kind: AudioSourceKind;
  mimeType: string;
  recorder: MediaRecorder;
  writer: RecordingFileWriter;
}

interface AudioGraph {
  context: AudioContext;
  mixedTrack: MediaStreamTrack;
  sourceTracks: Array<{ kind: AudioSourceKind; track: MediaStreamTrack }>;
}

export class RecordingAudio {
  static async create(
    desktopStream: MediaStream,
    microphoneDeviceId: string | null,
    shouldCaptureSystemAudio: boolean
  ): Promise<RecordingAudio> {
    let context: AudioContext | null = null;
    let microphoneStream: MediaStream | null = null;
    const recorders: AudioRecorder[] = [];
    try {
      const inputs: AudioInput[] = [];
      if (shouldCaptureSystemAudio) {
        inputs.push({
          kind: "system",
          track: requiredAudioTrack(
            desktopStream,
            "Desktop audio capture is enabled, but Windows did not provide a desktop audio track."
          )
        });
      }

      microphoneStream = await getMicrophoneStream(microphoneDeviceId);
      if (microphoneStream) {
        inputs.push({
          kind: "microphone",
          track: requiredAudioTrack(microphoneStream, "The selected microphone did not provide an audio track.")
        });
      }

      const graph = await createAudioGraph(inputs);
      context = graph?.context ?? null;
      const sourceTracks = graph?.sourceTracks ?? [];
      for (const source of sourceTracks) {
        recorders.push(await createAudioRecorder(source.kind, source.track));
      }

      return new RecordingAudio(context, graph?.mixedTrack ?? null, microphoneStream, recorders);
    } catch (error) {
      stopTracks(microphoneStream);
      const cleanupResults = await Promise.allSettled([
        context?.close(),
        ...recorders.map(async (recorder) => await recorder.writer.discard())
      ]);
      throw combinedError("Could not prepare recording audio.", [error, ...rejectedReasons(cleanupResults)]);
    }
  }

  private readonly errorHandlers = new Set<RecordingAudioErrorHandler>();
  private firstError: unknown = null;
  private hasError = false;
  private isClosed = false;

  private constructor(
    private readonly context: AudioContext | null,
    readonly mixedTrack: MediaStreamTrack | null,
    private readonly microphoneStream: MediaStream | null,
    private readonly recorders: AudioRecorder[]
  ) {
    for (const recorder of this.recorders) {
      recorder.writer.onError((error): void => {
        this.notifyError(error);
      });
    }

    if (this.microphoneStream) {
      this.watchStream(this.microphoneStream);
    }
  }

  private notifyError(error: unknown): void {
    if (this.isClosed || this.hasError) {
      return;
    }

    this.firstError = error;
    this.hasError = true;
    for (const handler of this.errorHandlers) {
      handler(error);
    }
  }

  private watchStream(stream: MediaStream): void {
    for (const track of stream.getTracks()) {
      const reportEndedTrack = (): void => {
        this.notifyError(new Error("Microphone capture ended unexpectedly."));
      };
      track.addEventListener("ended", reportEndedTrack, { once: true });
      if (track.readyState === "ended") {
        reportEndedTrack();
      }
    }
  }

  async close(): Promise<void> {
    if (this.isClosed) {
      return;
    }

    this.isClosed = true;
    stopTracks(this.microphoneStream);
    for (const recorder of this.recorders) {
      stopTracks(recorder.recorder.stream);
    }
    this.mixedTrack?.stop();
    if (this.context?.state !== "closed") {
      await this.context?.close();
    }
  }

  async discardWriters(): Promise<void> {
    const results = await Promise.allSettled(
      this.recorders.map(async (recorder) => await recorder.writer.discard())
    );
    throwCollectedErrors(rejectedReasons(results), "Could not discard temporary recording audio files.");
  }

  hasAudio(): boolean {
    return this.recorders.length > 0;
  }

  onError(handler: RecordingAudioErrorHandler): () => void {
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

  recordingTracks(): RecordingAudioTrack[] {
    return this.recorders.map((recorder) => ({
      kind: recorder.kind,
      mimeType: recorder.mimeType,
      recordingId: recorder.writer.recordingId
    }));
  }

  start(): void {
    for (const recorder of this.recorders) {
      recorder.writer.start(recorder.recorder);
    }
  }

  async stopRecorders(): Promise<void> {
    const results = await Promise.allSettled(this.recorders.map(async (recorder) => {
      await stopMediaRecorder(recorder.recorder, recorder.writer);
    }));
    throwCollectedErrors(rejectedReasons(results), "Could not finalize the recording audio.");
  }
}

async function createAudioGraph(inputs: readonly AudioInput[]): Promise<AudioGraph | null> {
  if (inputs.length === 0) {
    return null;
  }

  const context = new AudioContext({ sampleRate: recordingAudioSampleRate });
  try {
    const mixedDestination = context.createMediaStreamDestination();
    const mixGain = context.createGain();
    mixGain.gain.value = audioMixGain(inputs.length);
    mixGain.connect(mixedDestination);
    const sourceTracks = inputs.map((input) => {
      const source = context.createMediaStreamSource(new MediaStream([input.track]));
      const destination = context.createMediaStreamDestination();
      source.connect(destination);
      source.connect(mixGain);
      return {
        kind: input.kind,
        track: requiredAudioTrack(destination.stream, "Could not create a normalized recording audio track.")
      };
    });
    await context.resume();
    return {
      context,
      mixedTrack: requiredAudioTrack(mixedDestination.stream, "Could not create the recording audio mix."),
      sourceTracks
    };
  } catch (error) {
    const cleanupResults = await Promise.allSettled([context.close()]);
    throw combinedError("Could not create the recording audio mix.", [error, ...rejectedReasons(cleanupResults)]);
  }
}

async function createAudioRecorder(kind: AudioSourceKind, track: MediaStreamTrack): Promise<AudioRecorder> {
  if (!MediaRecorder.isTypeSupported(recordingAudioMasterMimeType)) {
    throw new Error("This system does not support high-quality Opus audio recording.");
  }

  const stream = new MediaStream([track]);
  const writer = await RecordingFileWriter.create("webm");
  try {
    const recorder = new MediaRecorder(stream, {
      audioBitsPerSecond: recordingAudioMasterBitrate,
      mimeType: recordingAudioMasterMimeType
    });
    writer.connect(recorder);
    return {
      kind,
      mimeType: recordingAudioMasterMimeType,
      recorder,
      writer
    };
  } catch (error) {
    const cleanupResults = await Promise.allSettled([writer.discard()]);
    throw combinedError("Could not create the recording audio track.", [error, ...rejectedReasons(cleanupResults)]);
  }
}

async function getMicrophoneStream(deviceId: string | null): Promise<MediaStream | null> {
  if (deviceId === null) {
    return null;
  }

  return await navigator.mediaDevices.getUserMedia({
    audio: microphoneConstraints(deviceId),
    video: false
  });
}

function requiredAudioTrack(stream: MediaStream, errorMessage: string): MediaStreamTrack {
  const track = stream.getAudioTracks().at(0);
  if (!track) {
    throw new Error(errorMessage);
  }

  return track;
}
