import type { ClipEntry } from "./shared.js";
import { getSoftshotApi } from "./softshot-api.js";
import { TaskQueue } from "./task-queue.js";

export class ClipStore {
  private clips: ClipEntry[] = [];

  private hasLoadedClips = false;

  private readonly refreshes = new TaskQueue();

  constructor(private readonly onChange: () => void) {}

  get entries(): readonly ClipEntry[] {
    return this.clips;
  }

  get hasLoaded(): boolean {
    return this.hasLoadedClips;
  }

  async refresh(): Promise<void> {
    await this.refreshes.run(async (): Promise<void> => {
      this.clips = await getSoftshotApi().listClips();
      this.hasLoadedClips = true;
      this.onChange();
    });
  }
}
