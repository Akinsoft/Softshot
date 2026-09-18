type ElementConstructor<TElement extends HTMLElement> = new() => TElement;

export async function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality?: number): Promise<Blob> {
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob): void => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error(`Could not encode the image as ${mimeType}.`));
      }
    }, mimeType, quality);
  });
}

export function getRequiredElement<TElement extends HTMLElement>(
  id: string,
  expectedType: ElementConstructor<TElement>
): TElement {
  const value = document.querySelector(`#${id}`);
  if (!(value instanceof expectedType)) {
    throw new TypeError(`Missing element: ${id}.`);
  }

  return value;
}

export function getCanvasContext(canvas: HTMLCanvasElement, errorMessage: string): CanvasRenderingContext2D {
  const value = canvas.getContext("2d");
  if (!value) {
    throw new Error(errorMessage);
  }

  return value;
}
