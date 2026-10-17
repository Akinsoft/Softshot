import type {
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedPacketSink,
  EncodedVideoPacketSource
} from "mediabunny";

import type { ClipVideoSnapshot } from "./clip-video-capture";

const endEpsilonSeconds = 1e-6;

export interface ClipMuxOptions {
  audioFilePath: string | null;
  durationSeconds: number;
  endEpochSeconds: number;
  outputFilePath: string;
  video: ClipVideoSnapshot;
}

interface ClipTimeline {
  clipStartEpochSeconds: number;
  durationSeconds: number;
  lastVideoPacket: EncodedPacket;
  startKeyPacket: EncodedPacket;
}

interface ClipTracks {
  audioConfig: AudioDecoderConfig | null;
  audioPackets: AsyncGenerator<EncodedPacket> | null;
  audioSource: EncodedAudioPacketSource | null;
  videoConfig: VideoDecoderConfig;
  videoPackets: AsyncGenerator<EncodedPacket>;
  videoSource: EncodedVideoPacketSource;
}

export async function muxClip(options: ClipMuxOptions): Promise<void> {
  const {
    ALL_FORMATS,
    BufferSource,
    EncodedAudioPacketSource: AudioPacketSource,
    EncodedPacketSink: PacketSink,
    EncodedVideoPacketSource: VideoPacketSource,
    FilePathSource,
    FilePathTarget,
    Input,
    Mp4OutputFormat,
    Output
  } = await import("mediabunny");
  const videoInput = new Input({ formats: ALL_FORMATS, source: new BufferSource(options.video.bytes) });
  const audioInput = options.audioFilePath === null
    ? null
    : new Input({ formats: ALL_FORMATS, source: new FilePathSource(options.audioFilePath) });
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: false }),
    target: new FilePathTarget(options.outputFilePath)
  });
  try {
    const videoTrack = await videoInput.getPrimaryVideoTrack();
    const videoConfig = await videoTrack?.getDecoderConfig();
    if (!videoTrack || !videoConfig) {
      throw new Error("The clip has no video.");
    }

    const videoSink = new PacketSink(videoTrack);
    const timeline = await clipTimeline(videoSink, options);
    const audioTrack = audioInput ? await audioInput.getPrimaryAudioTrack() : null;
    const audioConfig = audioTrack ? await audioTrack.getDecoderConfig() : null;
    const tracks: ClipTracks = {
      audioConfig,
      audioPackets: audioTrack
        ? audioPackets(new PacketSink(audioTrack), timeline.clipStartEpochSeconds, options.endEpochSeconds)
        : null,
      audioSource: audioTrack ? new AudioPacketSource("aac") : null,
      videoConfig,
      videoPackets: videoPackets(videoSink, timeline),
      videoSource: new VideoPacketSource("avc")
    };
    output.addVideoTrack(tracks.videoSource);
    if (tracks.audioSource) {
      output.addAudioTrack(tracks.audioSource);
    }

    await output.start();
    await writeInterleaved(tracks);
    await output.finalize();
  } catch (error) {
    if (output.state === "started") {
      await output.cancel();
    }

    throw error;
  } finally {
    videoInput.dispose();
    audioInput?.dispose();
  }
}

async function clipTimeline(videoSink: EncodedPacketSink, options: ClipMuxOptions): Promise<ClipTimeline> {
  const videoTime = (epochSeconds: number): number => epochSeconds - options.video.startEpochSeconds;
  const targetStartEpochSeconds = options.endEpochSeconds - options.durationSeconds;
  const lastVideoPacket = await videoSink.getPacket(videoTime(options.endEpochSeconds) - endEpsilonSeconds);
  const startKeyPacket = await videoSink.getKeyPacket(videoTime(targetStartEpochSeconds))
    ?? await videoSink.getFirstKeyPacket();
  if (!lastVideoPacket || !startKeyPacket || startKeyPacket.timestamp > lastVideoPacket.timestamp) {
    throw new Error("No video was recorded for this clip.");
  }

  const startKeyEpochSeconds = options.video.startEpochSeconds + startKeyPacket.timestamp;
  const lastVideoEpochSeconds = options.video.startEpochSeconds + lastVideoPacket.timestamp;
  const clipStartEpochSeconds = lastVideoEpochSeconds < targetStartEpochSeconds ? targetStartEpochSeconds : startKeyEpochSeconds;
  return {
    clipStartEpochSeconds,
    durationSeconds: options.endEpochSeconds - clipStartEpochSeconds,
    lastVideoPacket,
    startKeyPacket
  };
}

async function* videoPackets(videoSink: EncodedPacketSink, timeline: ClipTimeline): AsyncGenerator<EncodedPacket> {
  const baseTimestamp = timeline.startKeyPacket.timestamp;
  let packet: EncodedPacket | null = timeline.startKeyPacket;
  while (packet) {
    const timestamp = packet.timestamp - baseTimestamp;
    if (packet.timestamp >= timeline.lastVideoPacket.timestamp) {
      yield packet.clone({ duration: Math.max(packet.duration, timeline.durationSeconds - timestamp), timestamp });
      return;
    }

    yield packet.clone({ timestamp });
    packet = await videoSink.getNextPacket(packet);
  }
}

async function* audioPackets(
  audioSink: EncodedPacketSink,
  clipStartEpochSeconds: number,
  endEpochSeconds: number
): AsyncGenerator<EncodedPacket> {
  let packet = await audioSink.getPacket(clipStartEpochSeconds) ?? await audioSink.getFirstPacket();
  while (packet && packet.timestamp < endEpochSeconds) {
    if (packet.timestamp >= clipStartEpochSeconds) {
      yield packet.clone({ timestamp: packet.timestamp - clipStartEpochSeconds });
    }

    packet = await audioSink.getNextPacket(packet);
  }
}

async function writeInterleaved(tracks: ClipTracks): Promise<void> {
  let nextVideo = await tracks.videoPackets.next();
  let nextAudio = await tracks.audioPackets?.next() ?? null;
  let hasWrittenVideo = false;
  let hasWrittenAudio = false;
  while (!nextVideo.done || (nextAudio && !nextAudio.done)) {
    const isVideoNext = !nextVideo.done
      && (nextAudio === null || nextAudio.done === true || nextVideo.value.timestamp <= nextAudio.value.timestamp);
    if (isVideoNext && !nextVideo.done) {
      await tracks.videoSource.add(nextVideo.value, hasWrittenVideo ? {} : { decoderConfig: tracks.videoConfig });
      hasWrittenVideo = true;
      nextVideo = await tracks.videoPackets.next();
    } else if (nextAudio && !nextAudio.done && tracks.audioSource) {
      await tracks.audioSource.add(
        nextAudio.value,
        hasWrittenAudio || tracks.audioConfig === null ? {} : { decoderConfig: tracks.audioConfig }
      );
      hasWrittenAudio = true;
      nextAudio = await tracks.audioPackets?.next() ?? null;
    }
  }
}
