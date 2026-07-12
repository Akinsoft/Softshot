export const recordingAudioBitrate = 192_000;
export const recordingAudioChannelCount = 2;
export const recordingAudioSampleRate = 48_000;

export function audioMixGain(sourceCount: number): number {
  if (!Number.isSafeInteger(sourceCount) || sourceCount < 1) {
    throw new RangeError("Audio mixes require at least one source.");
  }

  return 1 / sourceCount;
}
