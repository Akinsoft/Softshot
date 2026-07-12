import { app, Notification } from "electron";
import { autoUpdater } from "electron-updater";

const appName = "Softshot";
const updateCheckDelayMs = 2500;
const updateInstallDelayMs = 1200;

interface UpdateCheckOptions {
  canInstallNow(): boolean;
  log(message: string): void;
}

export function startUpdateChecks(options: UpdateCheckOptions): void {
  if (!app.isPackaged || process.env.SOFTSHOT_DISABLE_UPDATES === "1") {
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("checking-for-update", (): void => {
    options.log("checking for updates");
  });
  autoUpdater.on("update-available", (): void => {
    options.log("update available");
  });
  autoUpdater.on("update-not-available", (): void => {
    options.log("no update available");
  });
  autoUpdater.on("error", (error): void => {
    options.log(`update check failed: ${errorMessage(error)}`);
  });
  autoUpdater.on("update-downloaded", (): void => {
    installDownloadedUpdate(options);
  });

  setTimeout((): void => {
    void autoUpdater.checkForUpdates().catch((error: unknown): void => {
      options.log(`update check failed: ${errorMessage(error)}`);
    });
  }, updateCheckDelayMs);
}

function installDownloadedUpdate(options: UpdateCheckOptions): void {
  options.log("update downloaded");
  if (!options.canInstallNow()) {
    showUpdateReadyNotification();
    return;
  }

  setTimeout((): void => {
    if (!options.canInstallNow()) {
      options.log("update install deferred because Softshot became busy");
      showUpdateReadyNotification();
      return;
    }

    autoUpdater.quitAndInstall(false, true);
  }, updateInstallDelayMs);
}

function showUpdateReadyNotification(): void {
  if (!Notification.isSupported()) {
    return;
  }

  new Notification({
    body: "Softshot will finish updating when it closes.",
    title: `${appName} update ready`
  }).show();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
