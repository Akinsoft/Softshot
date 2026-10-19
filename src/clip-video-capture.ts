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

interface CaptureRun {
  ffmpeg: FfmpegProcess;
  fragments: Mp4Fragment[];
  outputAdvancedAtEpochSeconds: number;
  outputSeconds: number;
  reader: Mp4FragmentReader;
  startEpochSeconds: number;
  stderr: string;
  stderrLine: string;
}

export class ClipVideoCapture {
  static start(options: ClipVideoCaptureOptions): ClipVideoCapture {
    return new ClipVideoCapture(options);
  }

  private readonly exitHandlers = new Set<ClipVideoExitHandler>();

  private readonly firstVideoHandlers = new Set<() => void>();

  private exit: ClipVideoExit | null = null;

  private readonly fragmentListeners = new Set<() => void>();

  private readonly retainedSeconds: number;

  private run: CaptureRun;

  private hasReceivedVideo = false;

  private constructor(private readonly options: ClipVideoCaptureOptions) {
    this.retainedSeconds = options.durationSeconds + retainedExtraSeconds;
    this.run = this.startRun();
  }

  private startRun(): CaptureRun {
    const ffmpeg = spawn(this.options.ffmpegPath, captureArguments(this.options), {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const run: CaptureRun = {
      ffmpeg,
      fragments: [],
      outputAdvancedAtEpochSeconds: epochSeconds(),
      outputSeconds: 0,
      reader: new Mp4FragmentReader(),
      startEpochSeconds: Infinity,
      stderr: "",
      stderrLine: ""
    };
    ffmpeg.stdout.on("data", (chunk: Buffer): void => {
      if (run === this.run) {
        this.receive(chunk);
      }
    });
    ffmpeg.stderr.on("data", (chunk: Buffer): void => {
      if (run === this.run) {
        this.receiveStderr(chunk.toString());
      }
    });
    ffmpeg.on("error", (error): void => {
      if (run === this.run) {
        this.finish({ code: null, message: error.message });
      }
    });
    ffmpeg.on("exit", (code): void => {
      if (run === this.run) {
        this.finish({ code, message: run.stderr.trim() });
      }
    });
    return run;
  }

  private restartRun(): void {
    const previousRun = this.run;
    this.run = this.startRun();
    previousRun.ffmpeg.kill();
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
    const { run } = this;
    const lines = `${run.stderrLine}${text}`.split(/\r?\n/u);
    run.stderrLine = lines.pop() ?? "";
    for (const line of lines) {
      const progressMatch = progressTimePattern.exec(line.trim());
      if (progressMatch?.groups) {
        const outputSeconds = Number(progressMatch.groups.microseconds) / microsecondsPerSecond;
        if (this.isFillingLongGap(outputSeconds)) {
          this.restartRun();
          return;
        }

        this.receiveOutputTime(outputSeconds);
      } else if (!progressLinePattern.test(line.trim())) {
        run.stderr = `${run.stderr}${line}\n`.slice(-stderrLimitCharacters);
      }
    }
  }

  private isFillingLongGap(outputSeconds: number): boolean {
    return outputSeconds > this.run.outputSeconds
      && epochSeconds() - this.run.outputAdvancedAtEpochSeconds > this.retainedSeconds;
  }

  private receiveOutputTime(outputSeconds: number): void {
    this.updateTimeline(outputSeconds);
    if (outputSeconds > this.run.outputSeconds) {
      this.run.outputSeconds = outputSeconds;
      this.run.outputAdvancedAtEpochSeconds = epochSeconds();
    }
  }

  private updateTimeline(outputSeconds: number): void {
    this.run.startEpochSeconds = Math.min(this.run.startEpochSeconds, epochSeconds() - outputSeconds);
  }

  private receive(chunk: Buffer): void {
    const { run } = this;
    let fragments: Mp4Fragment[];
    try {
      fragments = run.reader.push(chunk);
    } catch (error) {
      run.ffmpeg.kill();
      this.finish({ code: null, message: errorMessage(error) });
      return;
    }

    if (fragments.length === 0) {
      return;
    }

    const isFirstVideo = run.fragments.length === 0 && !this.hasReceivedVideo;
    for (const fragment of fragments) {
      this.updateTimeline(fragment.endSeconds);
      run.fragments.push(fragment);
    }

    if (isFirstVideo) {
      this.hasReceivedVideo = true;
      for (const handler of this.firstVideoHandlers) {
        handler();
      }
    }

    const oldestKeptEndSeconds = (run.fragments.at(-1)?.endSeconds ?? 0) - this.retainedSeconds;
    while (run.fragments.length > 0 && run.fragments[0].endSeconds < oldestKeptEndSeconds) {
      run.fragments.shift();
    }

    for (const listener of this.fragmentListeners) {
      listener();
    }
  }

  private newestEndEpochSeconds(): number {
    const newest = this.run.fragments.at(-1);
    return newest ? this.run.startEpochSeconds + newest.endSeconds : -Infinity;
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
    const { run } = this;
    if (run.fragments.length === 0) {
      throw new Error("Nothing has been recorded yet. If Clips is following an app, it starts recording once the app draws something.");
    }

    return {
      bytes: Buffer.concat([...run.reader.header(), ...run.fragments.map((fragment) => fragment.bytes)]),
      startEpochSeconds: run.startEpochSeconds
    };
  }

  stop(): void {
    if (!this.exit) {
      this.run.ffmpeg.kill();
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
