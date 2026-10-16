import type { GifWorkerRequest, GifWorkerResponse } from "./editor-gif-worker.js";

const maximumGifWorkerCount = 8;
const reservedCoreCount = 2;

interface PendingFrame {
  reject: (error: Error) => void;
  resolve: (bytes: Uint8Array) => void;
}

export class GifWorkerPool {
  private readonly workers: Worker[];
  private readonly pendingFrames = new Map<number, PendingFrame>();
  private nextFrameId = 0;
  private nextWorkerIndex = 0;
  private failure: Error | null = null;
  private readonly gifencUrl = import.meta.resolve("gifenc");

  constructor() {
    const workerCount = Math.max(1, Math.min(maximumGifWorkerCount, navigator.hardwareConcurrency - reservedCoreCount));
    this.workers = Array.from({ length: workerCount }, () => {
      const worker = new Worker(new URL("editor-gif-worker.js", import.meta.url), { type: "module" });
      worker.addEventListener("message", (event: MessageEvent<GifWorkerResponse>): void => {
        this.handleResponse(event.data);
      });
      worker.addEventListener("error", (event): void => {
        this.fail(new Error(`A GIF worker failed: ${event.message}`));
      });
      return worker;
    });
  }

  private handleResponse(response: GifWorkerResponse): void {
    const pendingFrame = this.pendingFrames.get(response.id);
    if (!pendingFrame) {
      return;
    }

    this.pendingFrames.delete(response.id);
    if (response.type === "error") {
      pendingFrame.reject(new Error(`A GIF frame could not be encoded: ${response.message}`));
      return;
    }

    pendingFrame.resolve(response.bytes);
  }

  private fail(error: Error): void {
    this.failure = error;
    for (const pendingFrame of this.pendingFrames.values()) {
      pendingFrame.reject(error);
    }

    this.pendingFrames.clear();
  }

  get size(): number {
    return this.workers.length;
  }

  async encode(pixels: Uint8ClampedArray, width: number, height: number, colors: number): Promise<Uint8Array> {
    if (this.failure) {
      throw this.failure;
    }

    const worker = this.workers.at(this.nextWorkerIndex % this.workers.length);
    if (!worker) {
      throw new Error("The GIF worker pool is empty.");
    }

    const id = this.nextFrameId;
    this.nextFrameId += 1;
    this.nextWorkerIndex += 1;
    const { promise, reject, resolve } = Promise.withResolvers<Uint8Array>();
    this.pendingFrames.set(id, { reject, resolve });
    const request: GifWorkerRequest = { colors, gifencUrl: this.gifencUrl, height, id, pixels, width };
    worker.postMessage(request, [pixels.buffer]);
    return await promise;
  }

  dispose(): void {
    for (const worker of this.workers) {
      worker.terminate();
    }

    this.failure = new Error("The GIF workers were stopped.");
    this.pendingFrames.clear();
  }
}
