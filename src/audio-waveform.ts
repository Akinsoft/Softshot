import { ALL_FORMATS, AudioSampleSink, CustomSource, Input } from "mediabunny";

import type { AudioSourceKind } from "./shared.js";
import { getSoftshotApi } from "./softshot-api.js";

export async function audioWaveformPeaks(
  kind: AudioSourceKind,
  durationSeconds: number,
  peakCount: number
): Promise<number[]> {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new RangeError("The waveform duration must be positive and finite.");
  }

  if (!Number.isSafeInteger(peakCount) || peakCount <= 0) {
    throw new RangeError("The waveform peak count must be a positive integer.");
  }

  const api = getSoftshotApi();
  const input = new Input({
    formats: ALL_FORMATS,
    source: new CustomSource({
      getSize: async (): Promise<number> => await api.getEditorAudioFileSize(kind),
      read: async (start, end): Promise<Uint8Array> => await api.readEditorAudioFile(kind, start, end)
    })
  });
  try {
    if (!await input.canRead()) {
      throw new Error("The audio waveform source could not be read.");
    }

    const audioTrack = await input.getPrimaryAudioTrack();
    if (!audioTrack) {
      throw new Error("The audio waveform source does not contain an audio track.");
    }

    const peaks = Array.from({ length: peakCount }, () => 0);
    const secondsPerPeak = durationSeconds / peakCount;
    const samples = new AudioSampleSink(audioTrack).samples(0, durationSeconds);
    let channelSamples = new Float32Array(0);
    for await (const sample of samples) {
      try {
        if (channelSamples.length < sample.numberOfFrames) {
          channelSamples = new Float32Array(sample.numberOfFrames);
        }

        for (let channelIndex = 0; channelIndex < sample.numberOfChannels; channelIndex += 1) {
          sample.copyTo(channelSamples, { format: "f32-planar", planeIndex: channelIndex });
          accumulateChannelPeaks(peaks, channelSamples, sample.numberOfFrames, {
            firstFrame: sample.timestamp * sample.sampleRate,
            framesPerPeak: secondsPerPeak * sample.sampleRate
          });
        }
      } finally {
        sample.close();
      }
    }

    const maximumPeak = Math.max(...peaks);
    return maximumPeak > 0
      ? peaks.map((peak) => Math.min(peak / maximumPeak, 1))
      : peaks;
  } finally {
    input.dispose();
  }
}

interface PeakWindowLayout {
  firstFrame: number;
  framesPerPeak: number;
}

function accumulateChannelPeaks(
  peaks: number[],
  channelSamples: Float32Array,
  frameCount: number,
  layout: PeakWindowLayout
): void {
  let frameIndex = 0;
  while (frameIndex < frameCount) {
    const peakIndex = Math.floor((layout.firstFrame + frameIndex) / layout.framesPerPeak);
    if (peakIndex >= peaks.length) {
      return;
    }

    const windowEnd = Math.min(
      frameCount,
      Math.max(frameIndex + 1, Math.ceil((peakIndex + 1) * layout.framesPerPeak - layout.firstFrame))
    );
    let peak = peaks[peakIndex] ?? 0;
    for (; frameIndex < windowEnd; frameIndex += 1) {
      peak = Math.max(peak, Math.abs(channelSamples[frameIndex] ?? 0));
    }

    if (peakIndex >= 0) {
      peaks[peakIndex] = peak;
    }
  }
}
