import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { ClipEntry } from "./shared";
import { TaskQueue } from "./task-queue";

const libraryFileName = "library.json";
const libraryVersion = 1;
const libraryIndentSpaces = 2;
const thumbnailsFolderName = "thumbnails";
const thumbnailFileExtension = ".jpg";
const jpegSignature = Buffer.from("ffd8ff", "hex");

interface StoredClip {
  createdAt: string;
  durationSeconds: number;
  filePath: string;
  height: number;
  id: string;
  sourceName: string;
  width: number;
}

interface NewClip {
  createdAt: Date;
  durationSeconds: number;
  filePath: string;
  height: number;
  sourceName: string;
  width: number;
}

export class ClipsLibrary {
  private readonly operations = new TaskQueue();

  constructor(private readonly directory: string) {}

  private libraryFilePath(): string {
    return path.join(this.directory, libraryFileName);
  }

  private thumbnailFilePath(clipId: string): string {
    return path.join(this.directory, thumbnailsFolderName, `${clipId}${thumbnailFileExtension}`);
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    return await this.operations.run(operation);
  }

  private async readClips(): Promise<StoredClip[]> {
    let contents: string;
    try {
      contents = await readFile(this.libraryFilePath(), "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        return [];
      }

      throw error;
    }

    return storedClipsFromJson(JSON.parse(contents), this.libraryFilePath());
  }

  private async writeClips(clips: StoredClip[]): Promise<void> {
    const filePath = this.libraryFilePath();
    const temporaryFilePath = `${filePath}.tmp`;
    await mkdir(this.directory, { recursive: true });
    try {
      const contents = { clips, version: libraryVersion };
      await writeFile(temporaryFilePath, `${JSON.stringify(contents, null, libraryIndentSpaces)}\n`);
      await rename(temporaryFilePath, filePath);
    } finally {
      await rm(temporaryFilePath, { force: true });
    }
  }

  private async clipEntry(clip: StoredClip): Promise<ClipEntry | null> {
    try {
      const fileStats = await stat(clip.filePath);
      return {
        ...clip,
        sizeBytes: fileStats.size,
        thumbnailUrl: pathToFileURL(this.thumbnailFilePath(clip.id)).toString()
      };
    } catch (error) {
      if (isMissingFileError(error)) {
        return null;
      }

      throw error;
    }
  }

  async add(clip: NewClip, thumbnail: Uint8Array): Promise<void> {
    if (jpegSignature.some((byte, index) => thumbnail[index] !== byte)) {
      throw new Error("Clip thumbnails must be JPEG images.");
    }

    await this.exclusive(async (): Promise<void> => {
      const storedClip: StoredClip = { ...clip, createdAt: clip.createdAt.toISOString(), id: randomUUID() };
      const thumbnailFilePath = this.thumbnailFilePath(storedClip.id);
      await mkdir(path.dirname(thumbnailFilePath), { recursive: true });
      await writeFile(thumbnailFilePath, thumbnail);
      try {
        await this.writeClips([...await this.readClips(), storedClip]);
      } catch (error) {
        await rm(thumbnailFilePath, { force: true });
        throw error;
      }
    });
  }

  async find(clipId: string): Promise<StoredClip> {
    const clips = await this.exclusive(async () => await this.readClips());
    const clip = clips.find((candidate) => candidate.id === clipId);
    if (!clip) {
      throw new Error("This clip is no longer in the gallery.");
    }

    return clip;
  }

  async list(): Promise<ClipEntry[]> {
    return await this.exclusive(async (): Promise<ClipEntry[]> => {
      const clips = await this.readClips();
      const entries = await Promise.all(clips.map(async (clip) => await this.clipEntry(clip)));
      const deletedClips = await deletedClipsFromEntries(clips, entries);
      if (deletedClips.size > 0) {
        await this.writeClips(clips.filter((clip) => !deletedClips.has(clip)));
        await Promise.all([...deletedClips].map(async (clip) => {
          await rm(this.thumbnailFilePath(clip.id), { force: true });
        }));
      }

      return entries
        .filter((entry): entry is ClipEntry => entry !== null)
        .toSorted((first, second) => second.createdAt.localeCompare(first.createdAt));
    });
  }

  async remove(clipId: string): Promise<StoredClip> {
    return await this.exclusive(async (): Promise<StoredClip> => {
      const clips = await this.readClips();
      const clip = clips.find((candidate) => candidate.id === clipId);
      if (!clip) {
        throw new Error("This clip is no longer in the gallery.");
      }

      await this.writeClips(clips.filter((candidate) => candidate !== clip));
      await rm(this.thumbnailFilePath(clip.id), { force: true });
      return clip;
    });
  }
}

async function deletedClipsFromEntries(
  clips: readonly StoredClip[],
  entries: ReadonlyArray<ClipEntry | null>
): Promise<Set<StoredClip>> {
  const deletedClips = new Set<StoredClip>();
  await Promise.all(clips.map(async (clip, index): Promise<void> => {
    if (entries[index] === null && await directoryExists(path.dirname(clip.filePath))) {
      deletedClips.add(clip);
    }
  }));
  return deletedClips;
}

async function directoryExists(directoryPath: string): Promise<boolean> {
  try {
    const directoryStats = await stat(directoryPath);
    return directoryStats.isDirectory();
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }

    throw error;
  }
}

function storedClipsFromJson(value: unknown, filePath: string): StoredClip[] {
  if (!isJsonObject(value) || value.version !== libraryVersion || !Array.isArray(value.clips)) {
    throw new Error(`The clips library at ${filePath} is not readable.`);
  }

  return value.clips.map((clip: unknown): StoredClip => {
    if (!isStoredClip(clip)) {
      throw new Error(`The clips library at ${filePath} contains an unreadable clip.`);
    }

    return clip;
  });
}

function isStoredClip(value: unknown): value is StoredClip {
  return isJsonObject(value) && hasStoredClipText(value) && hasStoredClipNumbers(value);
}

function hasStoredClipText(value: Record<string, unknown>): boolean {
  return typeof value.createdAt === "string"
    && typeof value.filePath === "string"
    && typeof value.id === "string"
    && typeof value.sourceName === "string";
}

function hasStoredClipNumbers(value: Record<string, unknown>): boolean {
  return isPositiveNumber(value.durationSeconds) && isPositiveNumber(value.height) && isPositiveNumber(value.width);
}

function isPositiveNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
