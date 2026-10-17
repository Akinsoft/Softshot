import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable } from "node:stream";

import { errorMessage } from "./async-errors";
import { type Mp4Fragment, Mp4FragmentReader } from "./mp4-fragments";
import type { VideoFps } from "./shared";

export type ClipVideoEncoder = "h264_amf" | "h264_mf" | "h264_nvenc";
export type ClipCaptureTarget = { handle: string; kind: "display" } | { handle: string; kind: "window" };

const clipVideoEncoders: readonly ClipVideoEncoder[] = ["h264_nvenc", "h264_amf", "h264_mf"];
const encoderProbeTimeoutMs = 15_000;
const encoderProbeBitrate = 2_000_000;
const encoderProbeFps = 30;
const snapshotWaitMs = 1500;
const retainedExtraSeconds = 2;
const stderrLimitCharacters = 4000;
const millisecondsPerSecond = 1000;
const maxRateMultiplier = 1.5;
const bufferSizeMultiplier = 2;
const microsecondsPerSecond = 1_000_000;
const progressPeriodSeconds = "0.25";
const progressTimePattern = /^out_time_us=(?<microseconds>\d+)$/u;
const progressLinePattern = /^[a-z_]+=/u;

export interface ClipVideoCaptureOptions {
  bitrate: number;
  durationSeconds: number;
  encoder: ClipVideoEncoder;
  ffmpegPath: string;
  fps: VideoFps;
  height: number;
  target: ClipCaptureTarget;
  width: number;
}

export interface ClipVideoSnapshot {
  bytes: Buffer;
  startEpochSeconds: number;
}

export interface ClipVideoExit {
  code: number | null;
  message: string;
}

type ClipVideoExitHandler = (exit: ClipVideoExit) => void;
type FfmpegProcess = ChildProcessByStdio<null, Readable, Readable>;

export class ClipVideoCapture {
  static start(options: ClipVideoCaptureOptions): ClipVideoCapture {
    const ffmpeg = spawn(options.ffmpegPath, captureArguments(options), {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    return new ClipVideoCapture(ffmpeg, options.durationSeconds);
  }

  private readonly exitHandlers = new Set<ClipVideoExitHandler>();

  private readonly firstVideoHandlers = new Set<() => void>();

  private exit: ClipVideoExit | null = null;

  private readonly fragmentListeners = new Set<() => void>();

  private readonly fragments: Mp4Fragment[] = [];

  private readonly reader = new Mp4FragmentReader();

  private startEpochSeconds = Infinity;

  private stderr = "";

  private stderrLine = "";

  private hasReceivedVideo = false;

  private constructor(private readonly ffmpeg: FfmpegProcess, private readonly durationSeconds: number) {
    ffmpeg.stdout.on("data", (chunk: Buffer): void => {
      this.receive(chunk);
    });
    ffmpeg.stderr.on("data", (chunk: Buffer): void => {
      this.receiveStderr(chunk.toString());
    });
    ffmpeg.on("error", (error): void => {
      this.finish({ code: null, message: error.message });
    });
    ffmpeg.on("exit", (code): void => {
      this.finish({ code, message: this.stderr.trim() });
    });
  }

  private finish(exit: ClipVideoExit): void {
    if (this.exit) {
      return;
    }

    this.exit = exit;
    for (const listener of this.fragmentListeners) {
      listener();
    }

    for (const handler of this.exitHandlers) {
      handler(exit);
    }
  }

  private receiveStderr(text: string): void {
    const lines = `${this.stderrLine}${text}`.split(/\r?\n/u);
    this.stderrLine = lines.pop() ?? "";
    for (const line of lines) {
      const progressMatch = progressTimePattern.exec(line.trim());
      if (progressMatch?.groups) {
        this.updateTimeline(Number(progressMatch.groups.microseconds) / microsecondsPerSecond);
      } else if (!progressLinePattern.test(line.trim())) {
        this.stderr = `${this.stderr}${line}\n`.slice(-stderrLimitCharacters);
      }
    }
  }

  private updateTimeline(outputSeconds: number): void {
    this.startEpochSeconds = Math.min(this.startEpochSeconds, epochSeconds() - outputSeconds);
  }

  private receive(chunk: Buffer): void {
    let fragments: Mp4Fragment[];
    try {
      fragments = this.reader.push(chunk);
    } catch (error) {
      this.ffmpeg.kill();
      this.finish({ code: null, message: errorMessage(error) });
      return;
    }

    if (fragments.length === 0) {
      return;
    }

    const isFirstVideo = this.fragments.length === 0 && !this.hasReceivedVideo;
    for (const fragment of fragments) {
      this.updateTimeline(fragment.endSeconds);
      this.fragments.push(fragment);
    }

    if (isFirstVideo) {
      this.hasReceivedVideo = true;
      for (const handler of this.firstVideoHandlers) {
        handler();
      }
    }

    const oldestKeptEndSeconds = (this.fragments.at(-1)?.endSeconds ?? 0) - this.durationSeconds - retainedExtraSeconds;
    while (this.fragments.length > 0 && this.fragments[0].endSeconds < oldestKeptEndSeconds) {
      this.fragments.shift();
    }

    for (const listener of this.fragmentListeners) {
      listener();
    }
  }

  private newestEndEpochSeconds(): number {
    const newest = this.fragments.at(-1);
    return newest ? this.startEpochSeconds + newest.endSeconds : -Infinity;
  }

  private async waitForFragmentEndingAfter(epochSecondsToReach: number): Promise<void> {
    if (this.newestEndEpochSeconds() >= epochSecondsToReach || this.exit) {
      return;
    }

    const { promise, resolve } = Promise.withResolvers<boolean>();
    const listener = (): void => {
      if (this.newestEndEpochSeconds() >= epochSecondsToReach || this.exit) {
        resolve(true);
      }
    };
    const timeoutHandle = setTimeout((): void => {
      resolve(false);
    }, snapshotWaitMs);
    this.fragmentListeners.add(listener);
    try {
      await promise;
    } finally {
      clearTimeout(timeoutHandle);
      this.fragmentListeners.delete(listener);
    }
  }

  onFirstVideo(handler: () => void): void {
    this.firstVideoHandlers.add(handler);
  }

  onExit(handler: ClipVideoExitHandler): void {
    this.exitHandlers.add(handler);
  }

  async snapshot(requestedAtEpochSeconds: number): Promise<ClipVideoSnapshot> {
    await this.waitForFragmentEndingAfter(requestedAtEpochSeconds);
    if (this.fragments.length === 0) {
      throw new Error("Nothing has been recorded yet. If Clips is following an app, it starts recording once the app draws something.");
    }

    return {
      bytes: Buffer.concat([...this.reader.header(), ...this.fragments.map((fragment) => fragment.bytes)]),
      startEpochSeconds: this.startEpochSeconds
    };
  }

  stop(): void {
    if (!this.exit) {
      this.ffmpeg.kill();
    }
  }
}

export async function findClipVideoEncoder(ffmpegPath: string): Promise<ClipVideoEncoder> {
  for (const encoder of clipVideoEncoders) {
    if (await canUseEncoder(ffmpegPath, encoder)) {
      return encoder;
    }
  }

  throw new Error("Clips needs a hardware video encoder (NVIDIA, AMD, or Intel graphics), and none is available on this PC.");
}

export function epochSeconds(): number {
  return (performance.timeOrigin + performance.now()) / millisecondsPerSecond;
}

async function canUseEncoder(ffmpegPath: string, encoder: ClipVideoEncoder): Promise<boolean> {
  const probe = spawn(ffmpegPath, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=640x360:r=30:d=0.5",
    ...encoderArguments(encoder, encoderProbeBitrate, encoderProbeFps),
    "-f",
    "null",
    "-"
  ], { stdio: "ignore", windowsHide: true });
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const timeoutHandle = setTimeout((): void => {
    probe.kill();
  }, encoderProbeTimeoutMs);
  probe.on("error", (): void => {
    resolve(false);
  });
  probe.on("exit", (code): void => {
    resolve(code === 0);
  });
  try {
    return await promise;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function captureArguments(options: ClipVideoCaptureOptions): string[] {
  const sourceOption = options.target.kind === "display" ? `hmonitor=${options.target.handle}` : `hwnd=${options.target.handle}`;
  const capture = [
    `gfxcapture=${sourceOption}`,
    `max_framerate=${String(options.fps)}`,
    `width=${String(options.width)}`,
    `height=${String(options.height)}`,
    "resize_mode=scale_aspect",
    "capture_cursor=1"
  ].join(":");
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-f",
    "lavfi",
    "-i",
    capture,
    "-fps_mode",
    "cfr",
    "-r",
    String(options.fps),
    ...encoderArguments(options.encoder, options.bitrate, options.fps),
    "-an",
    "-f",
    "mp4",
    "-movflags",
    "frag_keyframe+empty_moov+default_base_moof",
    "-flush_packets",
    "1",
    "-nostats",
    "-progress",
    "pipe:2",
    "-stats_period",
    progressPeriodSeconds,
    "pipe:1"
  ];
}

function encoderArguments(encoder: ClipVideoEncoder, bitrate: number, fps: number): string[] {
  const keyframeInterval = String(fps);
  const averageRate = String(bitrate);
  const maxRate = String(Math.round(bitrate * maxRateMultiplier));
  switch (encoder) {
    case "h264_nvenc": {
      return [
        "-c:v", "h264_nvenc", "-preset", "p4", "-tune", "ll", "-rc", "vbr",
        "-b:v", averageRate, "-maxrate", maxRate, "-bufsize", String(bitrate * bufferSizeMultiplier),
        "-g", keyframeInterval, "-bf", "0", "-profile:v", "high"
      ];
    }

    case "h264_amf": {
      return [
        "-c:v", "h264_amf", "-usage", "lowlatency", "-rc", "vbr_peak",
        "-b:v", averageRate, "-maxrate", maxRate, "-g", keyframeInterval, "-bf", "0", "-profile:v", "high"
      ];
    }

    case "h264_mf": {
      return ["-c:v", "h264_mf", "-hw_encoding", "1", "-rate_control", "u_vbr", "-b:v", averageRate, "-g", keyframeInterval];
    }

    default: {
      throw new Error("Unsupported clip encoder.");
    }
  }
}
