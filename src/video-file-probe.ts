const frameRateSamplePacketCount = 300;

export interface VideoFileProbe {
  durationSeconds: number;
  fps: number;
  hasAudio: boolean;
}

export async function probeVideoFile(filePath: string): Promise<VideoFileProbe> {
  const { ALL_FORMATS, FilePathSource, Input } = await import("mediabunny");
  const input = new Input({
    formats: ALL_FORMATS,
    source: new FilePathSource(filePath)
  });
  try {
    if (!await input.canRead()) {
      throw new Error("The file is not a supported video format.");
    }

    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) {
      throw new Error("The file does not contain a video track.");
    }

    const durationSeconds = await input.computeDuration();
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new Error("The video has no playable duration.");
    }

    const { averagePacketRate } = await videoTrack.computePacketStats(frameRateSamplePacketCount);
    if (!Number.isFinite(averagePacketRate) || averagePacketRate <= 0) {
      throw new Error("The video frame rate could not be read.");
    }

    return {
      durationSeconds,
      fps: averagePacketRate,
      hasAudio: await input.getPrimaryAudioTrack() !== null
    };
  } finally {
    input.dispose();
  }
}
