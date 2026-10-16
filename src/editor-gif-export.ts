import { CanvasSink, type InputVideoTrack } from "mediabunny";

import type { ExportProgress, TrimRange } from "./editor-export.js";
import type { GifPlan } from "./editor-export-settings.js";
import { GifWorkerPool } from "./editor-gif-worker-pool.js";
import { VideoUpscaler } from "./editor-upscaler.js";

const gifTimeUnitsPerSecond = 100;
const gifSignature = "GIF89a";
const gifExtensionIntroducer = 0x21;
const gifGraphicControlLabel = 0xF9;
const gifAppExtensionLabel = 0xFF;
const gifAppIdentifier = "NETSCAPE2.0";
const gifLoopSubBlockSize = 3;
const gifLoopSubBlockId = 1;
const gifLoopForever = 0;
const gifBlockTerminator = 0;
const gifTrailer = 0x3B;
const gifColorResolutionWithoutGlobalTable = 0x70;
const gifBackgroundColorIndex = 0;
const gifPixelAspectRatio = 0;
const gifDelayOffset = 4;
const gifSizeByteLength = 2;
const gifFrameQueueDepthPerWorker = 2;

interface QueuedGifFrame {
  outputTime: number;
  result: Promise<GifFrameResult>;
}

type GifFrameResult = { bytes: Uint8Array; isEncoded: true } | { error: Error; isEncoded: false };

class GifFrameWriter {
  private readonly frameContext: OffscreenCanvasRenderingContext2D;
  private readonly queue: QueuedGifFrame[] = [];
  private frameCount = 0;

  constructor(
    private readonly streamWriter: WritableStreamDefaultWriter<Uint8Array>,
    private readonly plan: GifPlan,
    private readonly pool: GifWorkerPool
  ) {
    const { height, width } = plan.outputSize;
    const context = new OffscreenCanvas(width, height).getContext("2d", { willReadFrequently: true });
    if (!context) {
      throw new Error("The GIF frame canvas is unavailable.");
    }

    this.frameContext = context;
  }

  private async writeOldestFrame(nextFrameTime: number): Promise<void> {
    const frame = this.queue.shift();
    if (!frame) {
      throw new Error("The GIF frame queue is empty.");
    }

    const result = await frame.result;
    if (!result.isEncoded) {
      throw result.error;
    }

    const delayUnits = Math.round(nextFrameTime * gifTimeUnitsPerSecond) - Math.round(frame.outputTime * gifTimeUnitsPerSecond);
    setGifFrameDelay(result.bytes, Math.max(1, delayUnits));
    await this.streamWriter.write(result.bytes);
  }

  async start(): Promise<void> {
    await this.streamWriter.write(gifHeader(this.plan.outputSize.width, this.plan.outputSize.height));
  }

  async addFrame(canvas: HTMLCanvasElement | OffscreenCanvas, outputTime: number): Promise<void> {
    const { height, width } = this.plan.outputSize;
    this.frameContext.drawImage(canvas, 0, 0, width, height);
    const pixels = this.frameContext.getImageData(0, 0, width, height).data;
    const result = settledFrame(this.pool.encode(pixels, width, height, this.plan.colors));
    this.queue.push({ outputTime, result });
    this.frameCount += 1;
    while (this.queue.length > this.pool.size * gifFrameQueueDepthPerWorker) {
      const nextFrame = this.queue.at(1);
      if (!nextFrame) {
        throw new Error("The GIF frame queue is out of order.");
      }

      await this.writeOldestFrame(nextFrame.outputTime);
    }
  }

  async finish(endTime: number): Promise<void> {
    if (this.frameCount === 0) {
      throw new Error("The GIF did not contain any frames.");
    }

    while (this.queue.length > 0) {
      await this.writeOldestFrame(this.queue.at(1)?.outputTime ?? endTime);
    }

    await this.streamWriter.write(Uint8Array.of(gifTrailer));
  }
}

export async function encodeGifRanges(
  inputTrack: InputVideoTrack,
  streamWriter: WritableStreamDefaultWriter<Uint8Array>,
  plan: GifPlan,
  trimRanges: readonly TrimRange[],
  progress: ExportProgress,
  signal: AbortSignal | undefined
): Promise<void> {
  const upscaler = plan.scaling === "up" ? new VideoUpscaler(plan.outputSize.width, plan.outputSize.height) : null;
  const pool = new GifWorkerPool();
  try {
    const sink = new CanvasSink(inputTrack, upscaler ? {} : { fit: "fill", ...plan.outputSize });
    const frameWriter = new GifFrameWriter(streamWriter, plan, pool);
    await frameWriter.start();
    await encodeGifFrames(sink, frameWriter, upscaler, plan, trimRanges, progress, signal);
  } finally {
    pool.dispose();
    upscaler?.dispose();
  }
}

async function encodeGifFrames(
  sink: CanvasSink,
  frameWriter: GifFrameWriter,
  upscaler: VideoUpscaler | null,
  plan: GifPlan,
  trimRanges: readonly TrimRange[],
  progress: ExportProgress,
  signal: AbortSignal | undefined
): Promise<void> {
  const frameDuration = 1 / plan.fps;
  let outputOffset = 0;
  for (const trimRange of trimRanges) {
    const rangeDuration = trimRange.end - trimRange.start;
    const frameOffsets = gridOffsets(rangeDuration, frameDuration);
    const canvases = sink.canvasesAtTimestamps(frameOffsets.map((frameOffset) => trimRange.start + frameOffset));
    let frameIndex = 0;
    for await (const wrappedCanvas of canvases) {
      signal?.throwIfAborted();
      const outputTime = outputOffset + (frameOffsets[frameIndex] ?? 0);
      frameIndex += 1;
      if (wrappedCanvas) {
        const { canvas } = wrappedCanvas;
        await frameWriter.addFrame(upscaler ? upscaler.upscale(canvas, canvas.width, canvas.height) : canvas, outputTime);
        progress.update("video", Math.min(outputOffset + rangeDuration, outputTime + frameDuration));
      }
    }

    outputOffset += rangeDuration;
  }

  await frameWriter.finish(outputOffset);
}

async function settledFrame(encodedFrame: Promise<Uint8Array>): Promise<GifFrameResult> {
  try {
    return { bytes: await encodedFrame, isEncoded: true };
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)), isEncoded: false };
  }
}

function gifHeader(width: number, height: number): Uint8Array {
  const encoder = new TextEncoder();
  const sizes = new Uint8Array(gifSizeByteLength * gifSizeByteLength);
  const view = new DataView(sizes.buffer);
  view.setUint16(0, width, true);
  view.setUint16(gifSizeByteLength, height, true);
  const appIdentifier = encoder.encode(gifAppIdentifier);
  return Uint8Array.from([
    ...encoder.encode(gifSignature),
    ...sizes,
    gifColorResolutionWithoutGlobalTable,
    gifBackgroundColorIndex,
    gifPixelAspectRatio,
    gifExtensionIntroducer,
    gifAppExtensionLabel,
    appIdentifier.byteLength,
    ...appIdentifier,
    gifLoopSubBlockSize,
    gifLoopSubBlockId,
    gifLoopForever,
    gifLoopForever,
    gifBlockTerminator
  ]);
}

function setGifFrameDelay(frameBytes: Uint8Array, delayUnits: number): void {
  if (frameBytes[0] !== gifExtensionIntroducer || frameBytes[1] !== gifGraphicControlLabel) {
    throw new Error("An encoded GIF frame is missing its timing block.");
  }

  new DataView(frameBytes.buffer, frameBytes.byteOffset, frameBytes.byteLength).setUint16(gifDelayOffset, delayUnits, true);
}

function gridOffsets(duration: number, step: number): number[] {
  const offsets: number[] = [];
  const count = Math.max(1, Math.ceil(duration / step));
  for (let index = 0; index < count; index += 1) {
    offsets.push(index * step);
  }

  return offsets;
}
