export const mediaElementOperationTimeoutMs = 10_000;

export async function playMedia(media: HTMLMediaElement): Promise<void> {
  const { promise: timeout, reject } = Promise.withResolvers<never>();
  const timeoutHandle = setTimeout((): void => {
    media.pause();
    reject(new Error("Timed out starting media playback."));
  }, mediaElementOperationTimeoutMs);
  try {
    await Promise.race([media.play(), timeout]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

export async function waitForMediaMetadata(media: HTMLMediaElement): Promise<void> {
  if (media.readyState >= HTMLMediaElement.HAVE_METADATA) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    function cleanup(): void {
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
      }

      media.removeEventListener("loadedmetadata", onLoadedMetadata);
      media.removeEventListener("error", onError);
    }
    function onLoadedMetadata(): void {
      cleanup();
      resolve();
    }
    function onError(): void {
      cleanup();
      reject(mediaElementError(media, "loading recording metadata"));
    }

    media.addEventListener("loadedmetadata", onLoadedMetadata, { once: true });
    media.addEventListener("error", onError, { once: true });
    timeoutHandle = setTimeout((): void => {
      cleanup();
      reject(new Error("Timed out loading recording metadata."));
    }, mediaElementOperationTimeoutMs);
  });
}

export function mediaElementError(media: HTMLMediaElement, action: string): Error {
  const detail = media.error?.message;
  return new Error(detail ? `The media decoder failed while ${action}: ${detail}` : `The media decoder failed while ${action}.`);
}
