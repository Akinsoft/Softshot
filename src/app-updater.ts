import { app } from "electron";
import { autoUpdater } from "electron-updater";

import { errorMessage } from "./async-errors";
import type { AppUpdateStatus } from "./shared";

const updateCheckDelayMs = 2500;

interface AppUpdaterHost {
  canInstallNow(): boolean;
  log(message: string): void;
  statusChanged(status: AppUpdateStatus): void;
}

export class AppUpdater {
  private hasDownloadedThisSession = false;

  private status: AppUpdateStatus = { state: "none" };

  constructor(private readonly host: AppUpdaterHost) {}

  private setStatus(status: AppUpdateStatus): void {
    this.status = status;
    this.host.statusChanged(status);
  }

  currentStatus(): AppUpdateStatus {
    return this.status;
  }

  start(): void {
    if (!app.isPackaged || process.env.SOFTSHOT_DISABLE_UPDATES === "1") {
      return;
    }

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on("checking-for-update", (): void => {
      this.host.log("checking for updates");
    });
    autoUpdater.on("update-available", (): void => {
      this.host.log("update available");
      this.setStatus({ percent: 0, state: "downloading" });
    });
    autoUpdater.on("update-not-available", (): void => {
      this.host.log("no update available");
    });
    autoUpdater.on("error", (error): void => {
      this.host.log(`update failed: ${errorMessage(error)}`);
      if (this.status.state === "downloading") {
        this.setStatus({ state: "none" });
      }
    });
    autoUpdater.on("download-progress", (progress): void => {
      this.hasDownloadedThisSession = true;
      const percent = Math.floor(progress.percent);
      if (this.status.state === "downloading" && this.status.percent !== percent) {
        this.setStatus({ percent, state: "downloading" });
      }
    });
    autoUpdater.on("update-downloaded", (): void => {
      this.host.log("update downloaded");
      if (!this.hasDownloadedThisSession && this.host.canInstallNow()) {
        this.host.log("installing the update downloaded in an earlier session");
        autoUpdater.quitAndInstall(true, true);
        return;
      }

      this.setStatus({ state: "ready" });
    });

    setTimeout((): void => {
      void autoUpdater.checkForUpdates().catch((error: unknown): void => {
        this.host.log(`update check failed: ${errorMessage(error)}`);
      });
    }, updateCheckDelayMs);
  }

  install(): void {
    if (this.status.state !== "ready") {
      throw new Error("No Softshot update is ready to install.");
    }

    autoUpdater.quitAndInstall(true, true);
  }
}
