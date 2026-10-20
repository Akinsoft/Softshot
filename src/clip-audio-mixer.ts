import { AudioSample, type AudioSampleSource } from "mediabunny";

import { audioMixGain, recordingAudioSampleRate } from "./audio-quality.js";
import { epochSeconds } from "./shared.js";
import { TaskQueue } from "./task-queue.js";

const mixSampleRate = recordingAudioSampleRate;
const mixChannelCount = 2;
const mixDelaySeconds = 0.2;
const mixIntervalMs = 50;
const mixBufferSeconds = 2;
const driftToleranceSeconds = 0.001;
const resyncThresholdSeconds = 0.005;
const mixBufferFrames = mixSampleRate * mixBufferSeconds;
const driftToleranceFrames = Math.round(mixSampleRate * driftToleranceSeconds);
const resyncThresholdFrames = Math.round(mixSampleRate * resyncThresholdSeconds);
const processorBufferSize = 100;
const millisecondsPerSecond = 1000;
const microsecondsPerMillisecond = 1000;
const quadChannelCount = 4;
const surroundChannelCount = 6;
const halfGain = 0.5;
const surroundGain = Math.SQRT1_2;

type ClipAudioMixerErrorHandler = (error: unknown) => void;

interface StereoChunk {
  left: Float32Array;
  right: Float32Array;
}

interface StereoWeights {
  left: readonly number[];
  right: readonly number[];
}

interface MixerInput {
  gain: number;
  lastLeft: number;
  lastRight: number;
  nextFrame: number | null;
  resamplePosition: number;
}

const speakerDownmixWeights: ReadonlyMap<number, StereoWeights> = new Map([
  [quadChannelCount, { left: [halfGain, 0, halfGain, 0], right: [0, halfGain, 0, halfGain] }],
  [surroundChannelCount, {
    left: [1, 0, surroundGain, 0, surroundGain, 0],
    right: [0, 1, surroundGain, 0, 0, surroundGain]
  }]
]);

export class ClipAudioMixer {
  static start(tracks: readonly MediaStreamTrack[], source: AudioSampleSource, onError: ClipAudioMixerErrorHandler): ClipAudioMixer {
    const mixer = new ClipAudioMixer(source, onError);
    const gain = audioMixGain(tracks.length);
    for (const track of tracks) {
      void mixer.readTrack(track, gain);
    }

    return mixer;
  }

  private readonly abortController = new AbortController();

  private emittedFrame = 0;

  private hasStopped = false;

  private readonly interval: ReturnType<typeof setInterval>;

  private readonly left = new Float32Array(mixBufferFrames);

  private readonly originEpochSeconds = epochSeconds();

  private readonly right = new Float32Array(mixBufferFrames);

  private readonly samples = new TaskQueue();

  private constructor(private readonly source: AudioSampleSource, private readonly onError: ClipAudioMixerErrorHandler) {
    this.interval = setInterval((): void => {
      this.emitReadyFrames();
    }, mixIntervalMs);
  }

  private async readTrack(track: MediaStreamTrack, gain: number): Promise<void> {
    const input: MixerInput = { gain, lastLeft: 0, lastRight: 0, nextFrame: null, resamplePosition: 0 };
    const processor = new MediaStreamTrackProcessor({ maxBufferSize: processorBufferSize, track: track as MediaStreamAudioTrack });
    const consumer = new WritableStream<AudioData>({
      write: (audioData): void => {
        try {
          this.addAudioData(input, audioData);
        } finally {
          audioData.close();
        }
      }
    });
    try {
      await processor.readable.pipeTo(consumer, { signal: this.abortController.signal });
    } catch (error) {
      this.fail(error);
    }
  }

  private addAudioData(input: MixerInput, audioData: AudioData): void {
    const captureEpochSeconds = (performance.timeOrigin + audioData.timestamp / microsecondsPerMillisecond) / millisecondsPerSecond;
    const firstFrameEpochSeconds = captureEpochSeconds + input.resamplePosition / audioData.sampleRate;
    const captureFrame = Math.round((firstFrameEpochSeconds - this.originEpochSeconds) * mixSampleRate);
    const expectedFrame = input.nextFrame ?? captureFrame;
    const offsetFrames = captureFrame - expectedFrame;
    const stereo = stereoChunk(audioData);
    const step = audioData.sampleRate / mixSampleRate;
    if (offsetFrames > resyncThresholdFrames) {
      this.place(input, resampledChunk(input, stereo, step), captureFrame, 0);
    } else if (offsetFrames < -resyncThresholdFrames) {
      this.place(input, resampledChunk(input, stereo, step), expectedFrame, -offsetFrames);
    } else {
      this.place(input, resampledChunk(input, stereo, step * driftCorrection(stereo, step, offsetFrames)), expectedFrame, 0);
    }
  }

  private place(input: MixerInput, chunk: StereoChunk, position: number, overlappingFrames: number): void {
    const skippedFrames = Math.min(chunk.left.length, overlappingFrames);
    for (let index = skippedFrames; index < chunk.left.length; index += 1) {
      this.addFrame(position + index - skippedFrames, chunk.left[index] * input.gain, chunk.right[index] * input.gain);
    }

    input.nextFrame = position + chunk.left.length - skippedFrames;
  }

  private addFrame(frame: number, left: number, right: number): void {
    if (frame < this.emittedFrame || frame >= this.emittedFrame + mixBufferFrames) {
      return;
    }

    const index = frame % mixBufferFrames;
    this.left[index] += left;
    this.right[index] += right;
  }

  private emitReadyFrames(): void {
    const readyFrame = Math.floor((epochSeconds() - mixDelaySeconds - this.originEpochSeconds) * mixSampleRate);
    while (!this.hasStopped && this.emittedFrame < readyFrame) {
      this.emit(this.takeFrames(Math.min(readyFrame - this.emittedFrame, mixBufferFrames)));
    }
  }

  private takeFrames(frameCount: number): AudioSample {
    const data = new Float32Array(frameCount * mixChannelCount);
    for (let offset = 0; offset < frameCount; offset += 1) {
      const index = (this.emittedFrame + offset) % mixBufferFrames;
      data[offset] = this.left[index];
      data[frameCount + offset] = this.right[index];
      this.left[index] = 0;
      this.right[index] = 0;
    }

    const sample = new AudioSample({
      data,
      format: "f32-planar",
      numberOfChannels: mixChannelCount,
      sampleRate: mixSampleRate,
      timestamp: this.originEpochSeconds + this.emittedFrame / mixSampleRate
    });
    this.emittedFrame += frameCount;
    return sample;
  }

  private emit(sample: AudioSample): void {
    void this.samples.run(async (): Promise<void> => {
      try {
        if (!this.hasStopped) {
          await this.source.add(sample);
        }
      } catch (error) {
        this.fail(error);
      } finally {
        sample.close();
      }
    });
  }

  private fail(error: unknown): void {
    if (this.hasStopped) {
      return;
    }

    this.stop();
    this.onError(error);
  }

  stop(): void {
    this.hasStopped = true;
    clearInterval(this.interval);
    this.abortController.abort();
  }
}

function stereoChunk(audioData: AudioData): StereoChunk {
  const planes: Float32Array[] = [];
  for (let planeIndex = 0; planeIndex < audioData.numberOfChannels; planeIndex += 1) {
    const plane = new Float32Array(audioData.numberOfFrames);
    audioData.copyTo(plane, { format: "f32-planar", planeIndex });
    planes.push(plane);
  }

  const weights = speakerDownmixWeights.get(planes.length);
  if (weights) {
    return { left: weightedPlane(planes, weights.left), right: weightedPlane(planes, weights.right) };
  }

  return { left: planes[0], right: planes.at(1) ?? planes[0] };
}

function weightedPlane(planes: readonly Float32Array[], weights: readonly number[]): Float32Array {
  const output = new Float32Array(planes[0].length);
  for (const [channel, plane] of planes.entries()) {
    const weight = weights[channel];
    if (weight !== 0) {
      for (let index = 0; index < output.length; index += 1) {
        output[index] += plane[index] * weight;
      }
    }
  }

  return output;
}

function driftCorrection(chunk: StereoChunk, step: number, offsetFrames: number): number {
  const frameCount = chunk.left.length / step;
  if (frameCount <= 1) {
    return 1;
  }

  if (offsetFrames > driftToleranceFrames) {
    return frameCount / (frameCount + 1);
  }

  return offsetFrames < -driftToleranceFrames ? frameCount / (frameCount - 1) : 1;
}

function resampledChunk(input: MixerInput, chunk: StereoChunk, step: number): StereoChunk {
  const lastIndex = chunk.left.length - 1;
  const frameCount = Math.max(0, Math.floor((lastIndex - input.resamplePosition) / step) + 1);
  const left = new Float32Array(frameCount);
  const right = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const position = input.resamplePosition + frame * step;
    left[frame] = interpolated(chunk.left, position, input.lastLeft);
    right[frame] = interpolated(chunk.right, position, input.lastRight);
  }

  input.resamplePosition += frameCount * step - chunk.left.length;
  input.lastLeft = chunk.left[lastIndex];
  input.lastRight = chunk.right[lastIndex];
  return { left, right };
}

function interpolated(plane: Float32Array, position: number, previous: number): number {
  const index = Math.floor(position);
  const from = index < 0 ? previous : plane[index];
  const to = plane[Math.min(index + 1, plane.length - 1)];
  return from + (to - from) * (position - index);
}
