const imageLoadTimeoutMs = 10_000;

type ElementConstructor<TElement extends HTMLElement> = new() => TElement;

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

export async function loadImage(image: HTMLImageElement, source: string, timeoutMessage: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    function cleanup(): void {
      image.removeEventListener("load", onLoad);
      image.removeEventListener("error", onError);

      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
      }
    }

    function complete(): void {
      cleanup();
      resolve();
    }

    function onLoad(): void {
      complete();
    }

    function onError(): void {
      cleanup();
      reject(new Error("Could not load the frozen screen image."));
    }

    image.addEventListener("load", onLoad);
    image.addEventListener("error", onError);
    timeoutHandle = setTimeout(() => {
      cleanup();
      reject(new Error(timeoutMessage));
    }, imageLoadTimeoutMs);
    image.src = source;

    if (image.complete && image.naturalWidth > 0) {
      complete();
    }
  });
}
