const frameRateSamplePacketCount = 300;

export interface VideoFileProbe {
  audioTrackNames: Array<string | null>;
  durationSeconds: number;
  fps: number;
  hasAudio: boolean;
  height: number;
  startSeconds: number;
  width: number;
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

    const audioTracks = await input.getAudioTracks();
    return {
      audioTrackNames: await Promise.all(audioTracks.map(async (audioTrack) => await audioTrack.getName())),
      durationSeconds,
      fps: averagePacketRate,
      hasAudio: audioTracks.length > 0,
      height: await videoTrack.getDisplayHeight(),
      startSeconds: await input.getFirstTimestamp(),
      width: await videoTrack.getDisplayWidth()
    };
  } finally {
    input.dispose();
  }
}
