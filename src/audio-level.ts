export const audioAnalyzerFftSize = 512;

const audioLevelMaximumByteDistance = 128;
const audioSilenceByteValue = 128;

export function audioLevelFromTimeDomainSamples(samples: Uint8Array): number {
  let peak = 0;
  for (const sample of samples) {
    peak = Math.max(peak, Math.abs(sample - audioSilenceByteValue));
  }

  return Math.min(1, peak / audioLevelMaximumByteDistance);
}
