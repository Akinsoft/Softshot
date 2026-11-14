import { isInterruptedPlayback, playMedia } from "./media-element.js";

const previewClassName = "clip-preview";
const playingClassName = "playing";

interface ActivePreview {
  container: HTMLElement;
  listeners: AbortController;
  video: HTMLVideoElement;
}

export class ClipHoverPreview {
  private active: ActivePreview | null = null;

  private async playAfterZoom(preview: ActivePreview, thumbnail: HTMLElement): Promise<void> {
    await waitForHoverZoom(thumbnail);
    if (this.active !== preview) {
      return;
    }

    try {
      await playMedia(preview.video);
    } catch (error) {
      if (!isInterruptedPlayback(error)) {
        throw error;
      }
    }
  }

  private stopPreview(preview: ActivePreview): void {
    if (this.active === preview) {
      this.active = null;
    }

    preview.listeners.abort();
    preview.video.pause();
    preview.video.removeAttribute("src");
    preview.video.load();
    preview.video.remove();
  }

  start(container: HTMLElement, thumbnail: HTMLElement, videoUrl: string): void {
    if (this.active?.container === container) {
      return;
    }

    this.stop();
    const listeners = new AbortController();
    const video = document.createElement("video");
    video.className = previewClassName;
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = "auto";
    video.disablePictureInPicture = true;
    video.setAttribute("aria-hidden", "true");
    video.addEventListener("playing", (): void => {
      video.classList.add(playingClassName);
    }, { signal: listeners.signal });
    video.src = videoUrl;
    thumbnail.after(video);
    const preview = { container, listeners, video };
    this.active = preview;
    void this.playAfterZoom(preview, thumbnail).catch((): void => {
      this.stopPreview(preview);
    });
  }

  stop(): void {
    if (this.active) {
      this.stopPreview(this.active);
    }
  }

  stopFor(container: HTMLElement): void {
    if (this.active?.container === container) {
      this.stopPreview(this.active);
    }
  }
}

async function waitForHoverZoom(thumbnail: HTMLElement): Promise<void> {
  await Promise.all(thumbnail.getAnimations().map(async (animation) => await animation.finished));
}
