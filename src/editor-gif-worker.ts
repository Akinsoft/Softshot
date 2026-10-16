import type { GifColorFormat } from "gifenc";

export interface GifWorkerRequest {
  colors: number;
  gifencUrl: string;
  height: number;
  id: number;
  pixels: Uint8ClampedArray;
  width: number;
}

export type GifWorkerResponse =
  | { bytes: Uint8Array; id: number; type: "frame" }
  | { id: number; message: string; type: "error" };

type GifencModule = typeof import("gifenc");

const gifColorFormat: GifColorFormat = "rgb565";
const gifencModules = new Map<string, Promise<GifencModule>>();

addEventListener("message", (event: MessageEvent<GifWorkerRequest>): void => {
  void encodeFrame(event.data);
});

async function loadGifenc(gifencUrl: string): Promise<GifencModule> {
  const loadedModule = gifencModules.get(gifencUrl) ?? (import(gifencUrl) as Promise<GifencModule>);
  gifencModules.set(gifencUrl, loadedModule);
  return await loadedModule;
}

async function encodeFrame(request: GifWorkerRequest): Promise<void> {
  try {
    const { applyPalette, GIFEncoder, quantize } = await loadGifenc(request.gifencUrl);
    const palette = quantize(request.pixels, request.colors, { format: gifColorFormat });
    const index = applyPalette(request.pixels, palette, gifColorFormat);
    const encoder = GIFEncoder({ auto: false });
    encoder.writeFrame(index, request.width, request.height, { palette });
    const bytes = encoder.bytes();
    const response: GifWorkerResponse = { bytes, id: request.id, type: "frame" };
    postMessage(response, { transfer: [bytes.buffer] });
  } catch (error) {
    const response: GifWorkerResponse = {
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
      type: "error"
    };
    postMessage(response);
  }
}
