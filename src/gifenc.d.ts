declare module "gifenc" {
  export type GifColorFormat = "rgb444" | "rgb565" | "rgba4444";
  export type GifPalette = number[][];

  export interface GifStream {
    reset(): void;
  }

  export interface GifFrameOptions {
    delay?: number;
    palette?: GifPalette;
    repeat?: number;
  }

  export interface GifEncoderInstance {
    readonly stream: GifStream;
    bytes(): Uint8Array;
    finish(): void;
    writeFrame(index: Uint8Array, width: number, height: number, options?: GifFrameOptions): void;
  }

  export function GIFEncoder(options?: { auto?: boolean; initialCapacity?: number }): GifEncoderInstance;
  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: { format?: GifColorFormat }
  ): GifPalette;
  export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: GifPalette, format?: GifColorFormat): Uint8Array;
}
