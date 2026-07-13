import { ALL_FORMATS, AudioSampleSink, CustomSource, Input } from "mediabunny";

import type { AudioSourceKind } from "./shared.js";
import { getSoftshotApi } from "./softshot-api.js";

const half = 0.5;

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

    const peakIndexes = Array.from({ length: peakCount }).keys();
    const timestamps = Array.from(
      peakIndexes,
      (peakIndex) => ((peakIndex + half) / peakCount) * durationSeconds
    );
    const sink = new AudioSampleSink(audioTrack);
    const peaks: number[] = [];
    for await (const sample of sink.samplesAtTimestamps(timestamps)) {
      if (!sample) {
        peaks.push(0);
        continue;
      }

      try {
        let peak = 0;
        for (let channelIndex = 0; channelIndex < sample.numberOfChannels; channelIndex += 1) {
          const channelSamples = new Float32Array(sample.numberOfFrames);
          sample.copyTo(channelSamples, { format: "f32-planar", planeIndex: channelIndex });
          for (const value of channelSamples) {
            peak = Math.max(peak, Math.abs(value));
          }
        }

        peaks.push(peak);
      } finally {
        sample.close();
      }
    }

    if (peaks.length !== peakCount) {
      throw new Error("The audio waveform decoder returned an incomplete result.");
    }

    const maximumPeak = Math.max(...peaks);
    return maximumPeak > 0
      ? peaks.map((peak) => Math.min(peak / maximumPeak, 1))
      : peaks;
  } finally {
    input.dispose();
  }
}
