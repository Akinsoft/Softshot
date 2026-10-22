import type { AudioTrackMetadata, EncodedPacket, EncodedPacketSink, InputAudioTrack, Output } from "mediabunny";

import type { ClipVideoSnapshot } from "./clip-video-capture";
import type { ClipAudioTrackFile } from "./clips-library";
import { clipAudioTrackNames } from "./shared";

const endEpsilonSeconds = 1e-6;

interface ClipMuxOptions {
  audioFilePath: string | null;
  audioTrackFiles: readonly ClipAudioTrackFile[];
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

interface ClipStream {
  hasStarted: boolean;
  head: EncodedPacket | null;
  packets: AsyncGenerator<EncodedPacket>;
  write(packet: EncodedPacket, isFirstPacket: boolean): Promise<void>;
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
    Output: MediaOutput
  } = await import("mediabunny");
  const createOutput = (filePath: string): Output => new MediaOutput({
    format: new Mp4OutputFormat({ fastStart: false }),
    target: new FilePathTarget(filePath)
  });
  const addAudioStream = async (
    output: Output,
    audioTrack: InputAudioTrack,
    metadata: AudioTrackMetadata,
    timeline: ClipTimeline
  ): Promise<ClipStream> => {
    const audioConfig = await audioTrack.getDecoderConfig();
    const audioSource = new AudioPacketSource("aac");
    output.addAudioTrack(audioSource, metadata);
    const packets = audioPackets(new PacketSink(audioTrack), timeline.clipStartEpochSeconds, options.endEpochSeconds);
    return clipStream(packets, async (packet, isFirstPacket): Promise<void> => {
      await audioSource.add(packet, isFirstPacket && audioConfig ? { decoderConfig: audioConfig } : {});
    });
  };
  const videoInput = new Input({ formats: ALL_FORMATS, source: new BufferSource(options.video.bytes) });
  const audioInput = options.audioFilePath === null
    ? null
    : new Input({ formats: ALL_FORMATS, source: new FilePathSource(options.audioFilePath) });
  try {
    const videoTrack = await videoInput.getPrimaryVideoTrack();
    const videoConfig = await videoTrack?.getDecoderConfig();
    if (!videoTrack || !videoConfig) {
      throw new Error("The clip has no video.");
    }

    const videoSink = new PacketSink(videoTrack);
    const timeline = await clipTimeline(videoSink, options);
    const output = createOutput(options.outputFilePath);
    const videoSource = new VideoPacketSource("avc");
    output.addVideoTrack(videoSource);
    const streams = [clipStream(videoPackets(videoSink, timeline), async (packet, isFirstPacket): Promise<void> => {
      await videoSource.add(packet, isFirstPacket ? { decoderConfig: videoConfig } : {});
    })];
    const separateTracks: Array<{ audioTrack: InputAudioTrack; file: ClipAudioTrackFile }> = [];
    const audioTracks = audioInput ? await audioInput.getAudioTracks() : [];
    for (const audioTrack of audioTracks) {
      const name = await audioTrack.getName();
      const file = options.audioTrackFiles.find((candidate) => clipAudioTrackNames[candidate.kind] === name);
      if (file) {
        separateTracks.push({ audioTrack, file });
      } else {
        streams.push(await addAudioStream(output, audioTrack, await audioTrackMetadata(audioTrack), timeline));
      }
    }

    await writeOutput(output, streams);
    for (const { audioTrack, file } of separateTracks) {
      const trackOutput = createOutput(file.filePath);
      await writeOutput(trackOutput, [await addAudioStream(trackOutput, audioTrack, { name: clipAudioTrackNames[file.kind] }, timeline)]);
    }
  } finally {
    videoInput.dispose();
    audioInput?.dispose();
  }
}

async function writeOutput(output: Output, streams: readonly ClipStream[]): Promise<void> {
  try {
    await output.start();
    await writeInterleaved(streams);
    await output.finalize();
  } catch (error) {
    if (output.state === "started") {
      await output.cancel();
    }

    throw error;
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

async function audioTrackMetadata(audioTrack: InputAudioTrack): Promise<AudioTrackMetadata> {
  const [disposition, name] = await Promise.all([audioTrack.getDisposition(), audioTrack.getName()]);
  return name === null ? { disposition } : { disposition, name };
}

function clipStream(packets: AsyncGenerator<EncodedPacket>, write: ClipStream["write"]): ClipStream {
  return { hasStarted: false, head: null, packets, write };
}

async function nextPacket(stream: ClipStream): Promise<EncodedPacket | null> {
  const result = await stream.packets.next();
  return result.done === true ? null : result.value;
}

function earliestStream(streams: readonly ClipStream[]): ClipStream | null {
  let earliest: ClipStream | null = null;
  for (const stream of streams) {
    if (stream.head && (!earliest?.head || stream.head.timestamp < earliest.head.timestamp)) {
      earliest = stream;
    }
  }

  return earliest;
}

async function writeInterleaved(streams: readonly ClipStream[]): Promise<void> {
  for (const stream of streams) {
    stream.head = await nextPacket(stream);
  }

  for (let stream = earliestStream(streams); stream?.head; stream = earliestStream(streams)) {
    await stream.write(stream.head, !stream.hasStarted);
    stream.hasStarted = true;
    stream.head = await nextPacket(stream);
  }
}
