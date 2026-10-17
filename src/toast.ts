import { getRequiredElement } from "./overlay-dom.js";
import type { ToastMessage } from "./shared.js";
import { getSoftshotApi } from "./softshot-api.js";

const enterDurationMs = 320;
const visibleDurationMs = 3000;
const exitDurationMs = 260;
const totalDurationMs = enterDurationMs + visibleDurationMs + exitDurationMs;
const hiddenTranslate = "calc(100% + 32px) 0";
const shownTranslate = "0 0";
const enterEasing = "cubic-bezier(0.16, 1, 0.3, 1)";
const exitEasing = "cubic-bezier(0.7, 0, 0.84, 0)";
const reducedMotionQuery = "(prefers-reduced-motion: reduce)";

class ToastView {
  private animation: Animation | null = null;

  private readonly card = getRequiredElement("toast", HTMLDivElement);

  private readonly detail = getRequiredElement("toast-detail", HTMLSpanElement);

  private readonly title = getRequiredElement("toast-title", HTMLSpanElement);

  private toast: ToastMessage | null = null;

  private play(toast: ToastMessage): void {
    this.animation?.cancel();
    this.toast = toast;
    this.title.textContent = toast.title;
    this.detail.textContent = toast.detail ?? "";
    this.detail.hidden = toast.detail === null;
    this.card.dataset.tone = toast.tone;
    this.card.classList.toggle("clickable", toast.isClickable);
    const hidden = matchMedia(reducedMotionQuery).matches ? shownTranslate : hiddenTranslate;
    const animation = this.card.animate([
      { easing: enterEasing, offset: 0, opacity: 0, translate: hidden },
      { offset: enterDurationMs / totalDurationMs, opacity: 1, translate: shownTranslate },
      { easing: exitEasing, offset: (enterDurationMs + visibleDurationMs) / totalDurationMs, opacity: 1, translate: shownTranslate },
      { offset: 1, opacity: 0, translate: hidden }
    ], { duration: totalDurationMs, fill: "both" });
    animation.addEventListener("finish", (): void => {
      void getSoftshotApi().finishToast(toast.id);
    });
    this.animation = animation;
  }

  private setPointerInside(isInside: boolean): void {
    if (!this.toast?.isClickable) {
      return;
    }

    if (isInside) {
      this.animation?.pause();
    } else {
      this.animation?.play();
    }

    void getSoftshotApi().setToastPointerInside(this.toast.id, isInside);
  }

  start(): void {
    const api = getSoftshotApi();
    api.onToastShow((toast): void => {
      this.play(toast);
    });
    this.card.addEventListener("pointerenter", (): void => {
      this.setPointerInside(true);
    });
    this.card.addEventListener("pointerleave", (): void => {
      this.setPointerInside(false);
    });
    this.card.addEventListener("click", (): void => {
      if (this.toast?.isClickable) {
        void api.clickToast(this.toast.id);
      }
    });
  }
}

new ToastView().start();
