import { clipShortDateTimeLabel } from "./app-window-clip-format.js";
import type { ClipStore } from "./app-window-clip-store.js";
import { type AppWindowContext, type AppWindowPage, runWithErrorToast } from "./app-window-controls.js";
import { getRequiredElement } from "./overlay-dom.js";
import type { AppSettings, ClipEntry } from "./shared.js";
import { getSoftshotApi } from "./softshot-api.js";

const recentClipLimit = 50;
const expandedClassName = "expanded";

export class RecentClips implements AppWindowPage {
  private readonly emptyMessage = getRequiredElement("recent-clips-empty", HTMLParagraphElement);

  private readonly list = getRequiredElement("recent-clips-list", HTMLUListElement);

  private readonly section = getRequiredElement("recent-clips", HTMLElement);

  private readonly toggleButton = getRequiredElement("recent-clips-toggle", HTMLButtonElement);

  constructor(private readonly context: AppWindowContext, private readonly store: ClipStore) {}

  private recentClipItem(clip: ClipEntry): HTMLLIElement {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "recent-clip";
    button.setAttribute("aria-label", `Edit ${clip.sourceName} clip from ${clipShortDateTimeLabel(new Date(clip.createdAt))}`);
    const thumbnail = document.createElement("img");
    thumbnail.className = "recent-clip-thumbnail";
    thumbnail.src = clip.thumbnailUrl;
    thumbnail.alt = "";
    thumbnail.loading = "lazy";
    thumbnail.draggable = false;
    const text = document.createElement("span");
    text.className = "recent-clip-text";
    const title = document.createElement("span");
    title.className = "recent-clip-title";
    title.textContent = clip.sourceName;
    const subtitle = document.createElement("span");
    subtitle.className = "recent-clip-subtitle";
    subtitle.textContent = clipShortDateTimeLabel(new Date(clip.createdAt));
    text.append(title, subtitle);
    button.append(thumbnail, text);
    button.addEventListener("click", (): void => {
      void runWithErrorToast(this.context, getSoftshotApi().openClip(clip.id));
    });
    item.append(button);
    return item;
  }

  bind(): void {
    this.toggleButton.addEventListener("click", (): void => {
      void this.context.updateSettings({ recentClipsExpanded: !this.context.settings().recentClipsExpanded });
    });
  }

  render(settings: AppSettings): void {
    const isExpanded = settings.recentClipsExpanded;
    this.section.classList.toggle(expandedClassName, isExpanded);
    this.toggleButton.ariaExpanded = String(isExpanded);
    this.renderClips();
  }

  renderClips(): void {
    const recentClips = recentlyViewedClips(this.store.entries);
    this.list.replaceChildren(...recentClips.map((clip) => this.recentClipItem(clip)));
    this.emptyMessage.hidden = !this.store.hasLoaded || recentClips.length > 0;
  }
}

function recentlyViewedClips(clips: readonly ClipEntry[]): ClipEntry[] {
  return clips
    .flatMap((clip) => clip.lastViewedAt === null ? [] : [{ clip, viewedAt: clip.lastViewedAt }])
    .toSorted((first, second) => second.viewedAt.localeCompare(first.viewedAt))
    .slice(0, recentClipLimit)
    .map(({ clip }) => clip);
}
