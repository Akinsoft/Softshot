import { type AppWindowContext, type AppWindowPage, runWithErrorToast } from "./app-window-controls.js";
import { shortcutKeycaps } from "./app-window-shortcut.js";
import { getRequiredElement } from "./overlay-dom.js";
import type { AppSettings, ClipEntry } from "./shared.js";
import { clipDurationLabel } from "./shared.js";
import { getSoftshotApi } from "./softshot-api.js";
import { TaskQueue } from "./task-queue.js";

const millisecondsPerDay = 86_400_000;
const secondsPerMinute = 60;
const secondsPadLength = 2;
const bytesPerKilobyte = 1000;
const bytesPerMegabyte = 1_000_000;
const bytesPerGigabyte = 1_000_000_000;
const svgNamespace = "http://www.w3.org/2000/svg";
const dayFormatter = new Intl.DateTimeFormat([], { day: "numeric", month: "long", weekday: "long" });
const yearDayFormatter = new Intl.DateTimeFormat([], { day: "numeric", month: "long", year: "numeric" });
const timeFormatter = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" });

interface ClipAction {
  className?: string;
  iconPaths: string[];
  label: string;
  run(clip: ClipEntry): Promise<void>;
}

export class GalleryPage implements AppWindowPage {
  private clips: ClipEntry[] = [];

  private readonly emptyDetail = getRequiredElement("gallery-empty-detail", HTMLParagraphElement);

  private readonly emptyState = getRequiredElement("gallery-empty", HTMLDivElement);

  private readonly goToClipsButton = getRequiredElement("gallery-go-to-clips", HTMLButtonElement);

  private readonly groups = getRequiredElement("gallery-groups", HTMLDivElement);

  private hasLoaded = false;

  private readonly openFolderButton = getRequiredElement("gallery-open-folder", HTMLButtonElement);

  private readonly refreshes = new TaskQueue();

  private readonly summary = getRequiredElement("gallery-summary", HTMLParagraphElement);

  constructor(private readonly context: AppWindowContext) {}

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

  private renderClips(): void {
    let totalBytes = 0;
    for (const clip of this.clips) {
      totalBytes += clip.sizeBytes;
    }

    this.summary.textContent = this.clips.length === 0
      ? "Every clip you save with Softshot shows up here."
      : `${clipCountLabel(this.clips.length)}, ${formatBytes(totalBytes)}`;
    this.emptyState.hidden = !this.hasLoaded || this.clips.length > 0;
    this.groups.replaceChildren(...groupClipsByDay(this.clips).map(({ clips, label }) => {
      const group = document.createElement("section");
      group.className = "gallery-group";
      const title = document.createElement("h2");
      title.className = "gallery-group-title";
      title.textContent = label;
      const grid = document.createElement("div");
      grid.className = "gallery-grid";
      grid.append(...clips.map((clip) => this.clipCard(clip)));
      group.append(title, grid);
      return group;
    }));
  }

  private clipCard(clip: ClipEntry): HTMLElement {
    const card = document.createElement("article");
    card.className = "clip-card";
    card.append(this.clipOpenButton(clip), this.clipMeta(clip));
    return card;
  }

  private clipOpenButton(clip: ClipEntry): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "clip-open";
    button.setAttribute("aria-label", `Edit ${clip.sourceName} clip`);
    const thumbnail = document.createElement("img");
    thumbnail.className = "clip-thumbnail";
    thumbnail.src = clip.thumbnailUrl;
    thumbnail.alt = "";
    thumbnail.loading = "lazy";
    thumbnail.draggable = false;
    const duration = document.createElement("span");
    duration.className = "clip-duration";
    duration.textContent = formatDuration(clip.durationSeconds);
    const hint = document.createElement("span");
    hint.className = "clip-edit-hint";
    const hintLabel = document.createElement("span");
    hintLabel.append(svgIcon(["m4 20 4-1 11-11-3-3L5 16Z", "m14 6 3 3"]), "Edit");
    hint.append(hintLabel);
    button.append(thumbnail, duration, hint);
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
    subtitle.textContent = `${timeFormatter.format(new Date(clip.createdAt))}, ${String(clip.height)}p, ${formatBytes(clip.sizeBytes)}`;
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

  private async loadClips(): Promise<void> {
    this.clips = await getSoftshotApi().listClips();
    this.hasLoaded = true;
    this.renderClips();
  }

  bind(): void {
    this.openFolderButton.addEventListener("click", (): void => {
      void runWithErrorToast(this.context, getSoftshotApi().openClipsDirectory());
    });
    this.goToClipsButton.addEventListener("click", (): void => {
      this.context.navigate("clips");
    });
  }

  async refresh(): Promise<void> {
    await this.refreshes.run(async (): Promise<void> => {
      await runWithErrorToast(this.context, this.loadClips());
    });
  }

  render(settings: AppSettings): void {
    const { clips } = settings;
    this.goToClipsButton.hidden = clips.enabled;
    this.emptyDetail.replaceChildren(...clips.enabled
      ? ["Press", shortcutKeycaps(clips.shortcut), `to save the last ${clipDurationLabel(clips.durationSeconds)}.`]
      : ["Turn on Clips, then press", shortcutKeycaps(clips.shortcut), "to save what just happened."]);
    this.renderClips();
  }
}

function groupClipsByDay(clips: readonly ClipEntry[]): Array<{ clips: ClipEntry[]; label: string }> {
  const groups: Array<{ clips: ClipEntry[]; label: string }> = [];
  for (const clip of clips) {
    const label = dayLabel(new Date(clip.createdAt));
    const group = groups.at(-1);
    if (group?.label === label) {
      group.clips.push(clip);
    } else {
      groups.push({ clips: [clip], label });
    }
  }

  return groups;
}

function dayLabel(date: Date): string {
  const today = startOfDay(new Date());
  const day = startOfDay(date);
  const daysAgo = Math.round((today - day) / millisecondsPerDay);
  if (daysAgo === 0) {
    return "Today";
  }

  if (daysAgo === 1) {
    return "Yesterday";
  }

  return date.getFullYear() === new Date().getFullYear() ? dayFormatter.format(date) : yearDayFormatter.format(date);
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function clipCountLabel(count: number): string {
  return count === 1 ? "1 clip" : `${String(count)} clips`;
}

function formatDuration(durationSeconds: number): string {
  const totalSeconds = Math.max(1, Math.round(durationSeconds));
  const minutes = Math.floor(totalSeconds / secondsPerMinute);
  const seconds = totalSeconds % secondsPerMinute;
  return `${String(minutes)}:${String(seconds).padStart(secondsPadLength, "0")}`;
}

function formatBytes(byteCount: number): string {
  if (byteCount >= bytesPerGigabyte) {
    return `${(byteCount / bytesPerGigabyte).toFixed(1)} GB`;
  }

  if (byteCount >= bytesPerMegabyte) {
    return `${String(Math.round(byteCount / bytesPerMegabyte))} MB`;
  }

  return `${String(Math.max(1, Math.round(byteCount / bytesPerKilobyte)))} KB`;
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
