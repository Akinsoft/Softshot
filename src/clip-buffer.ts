import { MediaStreamAudioTrackSource, Mp4OutputFormat, NullTarget, Output } from "mediabunny";

import { combinedError, rejectedReasons } from "./async-errors.js";
import { recordingAudioBitrate } from "./audio-quality.js";
import { getLoopbackAudioStream, stopTracks } from "./desktop-capture.js";
import { type AudioMix, createAudioMix, getMicrophoneStream, recordingAudioInputs } from "./recording-audio.js";
import type { ClipRecorderConfig } from "./shared.js";

const fragmentWaitTimeoutMs = 5000;
const minimumFragmentDurationSeconds = 1;
const retainedExtraSeconds = 4;

type ClipAudioBufferErrorHandler = (error: unknown) => void;
type ClipAudioBufferEndedHandler = () => void;

interface ClipAudioFragment {
  bytes: Uint8Array;
  timestamp: number;
}

export class ClipAudioBuffer {
  static async create(config: ClipRecorderConfig): Promise<ClipAudioBuffer> {
    let loopbackStream: MediaStream | null = null;
    let microphoneStream: MediaStream | null = null;
    let audioMix: AudioMix | null = null;
    try {
      loopbackStream = config.systemAudioEnabled ? await getLoopbackAudioStream() : null;
      microphoneStream = await getMicrophoneStream(config.microphoneDeviceId);
      audioMix = await createAudioMix(recordingAudioInputs(
        loopbackStream ?? new MediaStream(),
        config.systemAudioEnabled,
        microphoneStream
      ));
      if (!audioMix) {
        throw new Error("Clips has no audio source to record.");
      }

      const buffer = new ClipAudioBuffer(config, audioMix, [loopbackStream, microphoneStream]);
      await buffer.output.start();
      return buffer;
    } catch (error) {
      stopTracks(loopbackStream);
      stopTracks(microphoneStream);
      const cleanupResults = await Promise.allSettled([audioMix?.context.close()]);
      throw combinedError("Could not start the clip audio.", [error, ...rejectedReasons(cleanupResults)]);
    }
  }

  private readonly endedHandlers = new Set<ClipAudioBufferEndedHandler>();

  private readonly errorHandlers = new Set<ClipAudioBufferErrorHandler>();

  private readonly fragmentListeners = new Set<() => void>();

  private readonly fragments: ClipAudioFragment[] = [];

  private hasStopped = false;

  private readonly header: Uint8Array[] = [];

  private readonly output: Output<Mp4OutputFormat, NullTarget>;

  private pendingMoof: ClipAudioFragment | null = null;

  private constructor(
    private readonly config: ClipRecorderConfig,
    audioMix: AudioMix,
    streams: ReadonlyArray<MediaStream | null>
  ) {
    this.output = this.createOutput(audioMix);
    this.watchStreams(streams);
  }

  private createOutput(audioMix: AudioMix): Output<Mp4OutputFormat, NullTarget> {
    const output = new Output({
      format: new Mp4OutputFormat({
        fastStart: "fragmented",
        minimumFragmentDuration: minimumFragmentDurationSeconds,
        onFtyp: (data): void => {
          this.header.push(new Uint8Array(data));
        },
        onMdat: (data): void => {
          this.addFragment(data);
        },
        onMoof: (...moofArguments): void => {
          const [data, , timestamp] = moofArguments;
          this.pendingMoof = { bytes: new Uint8Array(data), timestamp };
        },
        onMoov: (data): void => {
          this.header.push(new Uint8Array(data));
        }
      }),
      target: new NullTarget()
    });
    const audioSource = new MediaStreamAudioTrackSource(
      audioMix.mixedTrack as MediaStreamAudioTrack,
      { bitrate: recordingAudioBitrate, codec: "aac" },
      { timestampBase: "unix" }
    );
    void audioSource.errorPromise.catch((error: unknown): void => {
      this.notifyError(error);
    });
    output.addAudioTrack(audioSource);
    return output;
  }

  private watchStreams(streams: ReadonlyArray<MediaStream | null>): void {
    for (const stream of streams) {
      const tracks = stream?.getAudioTracks() ?? [];
      for (const track of tracks) {
        track.addEventListener("ended", (): void => {
          this.notifyEnded();
        }, { once: true });
      }
    }
  }

  private notifyEnded(): void {
    if (this.hasStopped) {
      return;
    }

    this.hasStopped = true;
    for (const handler of this.endedHandlers) {
      handler();
    }
  }

  private notifyError(error: unknown): void {
    if (this.hasStopped) {
      return;
    }

    this.hasStopped = true;
    for (const handler of this.errorHandlers) {
      handler(error);
    }
  }

  private addFragment(mediaData: Uint8Array): void {
    const moof = this.pendingMoof;
    this.pendingMoof = null;
    if (!moof) {
      this.notifyError(new Error("The clip audio encoder wrote data without a fragment header."));
      return;
    }

    const bytes = new Uint8Array(moof.bytes.byteLength + mediaData.byteLength);
    bytes.set(moof.bytes);
    bytes.set(mediaData, moof.bytes.byteLength);
    this.fragments.push({ bytes, timestamp: moof.timestamp });
    const oldestKeptTimestamp = moof.timestamp - this.config.durationSeconds - retainedExtraSeconds;
    while (this.fragments.length > 0 && this.fragments[0].timestamp < oldestKeptTimestamp) {
      this.fragments.shift();
    }

    for (const listener of this.fragmentListeners) {
      listener();
    }
  }

  private newestFragmentTimestamp(): number {
    return this.fragments.at(-1)?.timestamp ?? -Infinity;
  }

  private async waitForFragment(minimumTimestamp: number, timeoutMs: number | null): Promise<void> {
    if (this.newestFragmentTimestamp() >= minimumTimestamp) {
      return;
    }

    const { promise, reject, resolve } = Promise.withResolvers<boolean>();
    const listener = (): void => {
      if (this.newestFragmentTimestamp() >= minimumTimestamp) {
        resolve(true);
      }
    };
    const timeoutHandle = timeoutMs === null
      ? null
      : setTimeout((): void => {
        reject(new Error("Clips stopped receiving audio."));
      }, timeoutMs);
    this.fragmentListeners.add(listener);
    try {
      await promise;
    } finally {
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
      }

      this.fragmentListeners.delete(listener);
    }
  }

  onEnded(handler: ClipAudioBufferEndedHandler): void {
    this.endedHandlers.add(handler);
  }

  onError(handler: ClipAudioBufferErrorHandler): void {
    this.errorHandlers.add(handler);
  }

  async snapshot(fromEpochSeconds: number, untilEpochSeconds: number): Promise<Uint8Array[]> {
    await this.waitForFragment(untilEpochSeconds - minimumFragmentDurationSeconds, fragmentWaitTimeoutMs);
    const firstKeptTimestamp = fromEpochSeconds - minimumFragmentDurationSeconds;
    const fragments = this.fragments.filter((fragment) => fragment.timestamp >= firstKeptTimestamp);
    if (this.header.length === 0 || fragments.length === 0) {
      throw new Error("Clips has not recorded any audio yet.");
    }

    return [...this.header, ...fragments.map((fragment) => fragment.bytes)];
  }

  async waitUntilRecording(): Promise<void> {
    await this.waitForFragment(-Infinity, null);
  }
}
