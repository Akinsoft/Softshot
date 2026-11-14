import type { SoftshotApi } from "./shared";

declare global {
  interface Navigator {
    readonly windowControlsOverlay?: WindowControlsOverlay;
  }

  interface Window {
    softshot: SoftshotApi;
  }

  interface WindowControlsOverlay {
    readonly visible: boolean;
    getTitlebarAreaRect(): DOMRect;
  }
}

export {};
