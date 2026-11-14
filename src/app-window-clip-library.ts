import { clipDayLabel, clipTimeLabel, formatClipBytes, formatClipDuration } from "./app-window-clip-format.js";
import { ClipHoverPreview } from "./app-window-clip-preview.js";
import type { ClipStore } from "./app-window-clip-store.js";
import { type AppWindowContext, type AppWindowPage, runWithErrorToast } from "./app-window-controls.js";
import { getRequiredElement } from "./overlay-dom.js";
import type { AppSettings, ClipEntry } from "./shared.js";
import { lastClipDurationLabel } from "./shared.js";
import { getSoftshotApi } from "./softshot-api.js";

const svgNamespace = "http://www.w3.org/2000/svg";

interface ClipAction {
  className?: string;
  iconPaths: string[];
  label: string;
  run(clip: ClipEntry): Promise<void>;
}

export class ClipLibrary implements AppWindowPage {
  private readonly emptyDetail = getRequiredElement("clip-library-empty-detail", HTMLParagraphElement);

  private readonly emptyState = getRequiredElement("clip-library-empty", HTMLDivElement);

  private readonly groups = getRequiredElement("clip-library-groups", HTMLDivElement);

  private readonly header = getRequiredElement("clip-library-header", HTMLDivElement);

  private readonly openFolderButton = getRequiredElement("clip-library-open-folder", HTMLButtonElement);

  private readonly preview = new ClipHoverPreview();

  private readonly summary = getRequiredElement("clip-library-summary", HTMLParagraphElement);

  constructor(private readonly context: AppWindowContext, private readonly store: ClipStore) {}

  private clipActions(): ClipAction[] {
    const api = getSoftshotApi();
    return [
      {
        iconPaths: ["M9 9h10v12H9Z", "M5 15V5a2 2 0 0 1 2-2h8"],
        label: "Copy",
        run: async (clip): Promise<void> => {
          await api.copyClip(clip.id);
          this.context.showMessage("Clip copied. Paste it anywhere to share it.");
        }
      },
      {
        iconPaths: ["M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"],
        label: "Show in folder",
        run: async (clip): Promise<void> => {
          await api.showClipInFolder(clip.id);
        }
      },
      {
        className: "danger",
        iconPaths: ["M4 7h16", "M10 11v6", "M14 11v6", "M6 7l1 13h10l1-13", "M9 7V4h6v3"],
        label: "Move to Recycle Bin",
        run: async (clip): Promise<void> => {
          await api.deleteClip(clip.id);
          this.context.showMessage("Clip moved to the Recycle Bin.");
        }
      }
    ];
  }

  private clipCard(clip: ClipEntry): HTMLElement {
    const card = document.createElement("article");
    card.className = "clip-card";
    const thumbnail = clipThumbnail(clip);
    card.append(this.clipOpenButton(clip, thumbnail), this.clipMeta(clip));
    card.addEventListener("pointerenter", (): void => {
      this.preview.start(card, thumbnail, clip.videoUrl);
    });
    card.addEventListener("pointerleave", (): void => {
      this.preview.stopFor(card);
    });
    return card;
  }

  private clipOpenButton(clip: ClipEntry, thumbnail: HTMLImageElement): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "clip-open";
    button.setAttribute("aria-label", `Edit ${clip.sourceName} clip`);
    const duration = document.createElement("span");
    duration.className = "clip-duration";
    duration.textContent = formatClipDuration(clip.durationSeconds);
    button.append(thumbnail, duration);
    button.addEventListener("click", (): void => {
      void runWithErrorToast(this.context, getSoftshotApi().openClip(clip.id));
    });
    return button;
  }

  private clipMeta(clip: ClipEntry): HTMLDivElement {
    const meta = document.createElement("div");
    meta.className = "clip-meta";
    const text = document.createElement("div");
    text.className = "clip-text";
    const title = document.createElement("span");
    title.className = "clip-title";
    title.textContent = clip.sourceName;
    title.title = clip.sourceName;
    const subtitle = document.createElement("span");
    subtitle.className = "clip-subtitle";
    subtitle.textContent = `${clipTimeLabel(new Date(clip.createdAt))}, ${String(clip.height)}p, ${formatClipBytes(clip.sizeBytes)}`;
    text.append(title, subtitle);
    const actions = document.createElement("div");
    actions.className = "clip-actions";
    actions.append(...this.clipActions().map((action) => this.clipActionButton(clip, action)));
    meta.append(text, actions);
    return meta;
  }

  private clipActionButton(clip: ClipEntry, action: ClipAction): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = action.className ? `icon-button ${action.className}` : "icon-button";
    button.dataset.tooltip = action.label;
    button.setAttribute("aria-label", action.label);
    button.append(svgIcon(action.iconPaths));
    button.addEventListener("click", (): void => {
      void runWithErrorToast(this.context, action.run(clip));
    });
    return button;
  }

  bind(): void {
    this.openFolderButton.addEventListener("click", (): void => {
      void runWithErrorToast(this.context, getSoftshotApi().openClipsDirectory());
    });
  }

  render(settings: AppSettings): void {
    const { clips } = settings;
    const shortcutKeycaps = this.context.shortcutLabels().keycaps(clips.shortcut);
    this.emptyDetail.replaceChildren(...clips.enabled
      ? ["Press", shortcutKeycaps, `to save the last ${lastClipDurationLabel(clips.durationSeconds)}.`]
      : ["Turn on Clips, then press", shortcutKeycaps, "to save what just happened."]);
    this.renderClips();
  }

  renderClips(): void {
    const clips = this.store.entries;
    let totalBytes = 0;
    for (const clip of clips) {
      totalBytes += clip.sizeBytes;
    }

    const hasClips = clips.length > 0;
    this.preview.stop();
    this.summary.textContent = `${clipCountLabel(clips.length)}, ${formatClipBytes(totalBytes)}`;
    this.header.hidden = !hasClips;
    this.emptyState.hidden = !this.store.hasLoaded || hasClips;
    this.groups.replaceChildren(...groupClipsByDay(clips).map(({ clips: dayClips, label }) => {
      const group = document.createElement("section");
      group.className = "clip-group";
      const title = document.createElement("h2");
      title.className = "clip-group-title";
      title.textContent = label;
      const grid = document.createElement("div");
      grid.className = "clip-grid";
      grid.append(...dayClips.map((clip) => this.clipCard(clip)));
      group.append(title, grid);
      return group;
    }));
  }

  stopPreview(): void {
    this.preview.stop();
  }
}

function groupClipsByDay(clips: readonly ClipEntry[]): Array<{ clips: ClipEntry[]; label: string }> {
  const groups: Array<{ clips: ClipEntry[]; label: string }> = [];
  for (const clip of clips) {
    const label = clipDayLabel(new Date(clip.createdAt));
    const group = groups.at(-1);
    if (group?.label === label) {
      group.clips.push(clip);
    } else {
      groups.push({ clips: [clip], label });
    }
  }

  return groups;
}

function clipThumbnail(clip: ClipEntry): HTMLImageElement {
  const thumbnail = document.createElement("img");
  thumbnail.className = "clip-thumbnail";
  thumbnail.src = clip.thumbnailUrl;
  thumbnail.alt = "";
  thumbnail.loading = "lazy";
  thumbnail.draggable = false;
  return thumbnail;
}

function clipCountLabel(count: number): string {
  return count === 1 ? "1 clip" : `${String(count)} clips`;
}

function svgIcon(paths: readonly string[]): SVGSVGElement {
  const svg = document.createElementNS(svgNamespace, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const pathData of paths) {
    const path = document.createElementNS(svgNamespace, "path");
    path.setAttribute("d", pathData);
    svg.append(path);
  }

  return svg;
}
