import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { isMissingFileError } from "./async-errors";
import { windowsRecognizedGamePaths } from "./powershell";

const steamLibraryGamesFolder = `${path.win32.sep}steamapps${path.win32.sep}common${path.win32.sep}`;
const epicManifestsFolder = ["Epic", "EpicGamesLauncher", "Data", "Manifests"] as const;
const epicManifestExtension = ".item";
const epicGamesCategory = "games";

export class GameLibrary {
  static async load(): Promise<GameLibrary> {
    const [recognizedGamePaths, epicGameFolders] = await Promise.all([windowsRecognizedGamePaths(), epicInstallFolders()]);
    return new GameLibrary(
      new Set(recognizedGamePaths.map((gamePath) => pathKey(gamePath))),
      epicGameFolders.map((folder) => folderKey(folder))
    );
  }

  private constructor(
    private readonly recognizedGamePaths: ReadonlySet<string>,
    private readonly gameFolders: readonly string[]
  ) {}

  isGame(executablePath: string): boolean {
    const key = pathKey(executablePath);
    return this.recognizedGamePaths.has(key)
      || key.includes(steamLibraryGamesFolder)
      || this.gameFolders.some((folder) => key.startsWith(folder));
  }
}

async function epicInstallFolders(): Promise<string[]> {
  const { ProgramData: programData } = process.env;
  if (!programData) {
    return [];
  }

  const manifestsFolder = path.win32.join(programData, ...epicManifestsFolder);
  let fileNames: string[];
  try {
    fileNames = await readdir(manifestsFolder);
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }

    throw error;
  }

  const manifests = await Promise.all(fileNames
    .filter((fileName) => fileName.toLowerCase().endsWith(epicManifestExtension))
    .map(async (fileName) => await epicGameInstallFolder(path.win32.join(manifestsFolder, fileName))));
  return manifests.filter((folder) => folder !== null);
}

async function epicGameInstallFolder(manifestPath: string): Promise<string | null> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError || isMissingFileError(error)) {
      return null;
    }

    throw error;
  }

  if (typeof manifest !== "object" || manifest === null || !("InstallLocation" in manifest)) {
    return null;
  }

  const { InstallLocation: installLocation } = manifest;
  const categories = "AppCategories" in manifest ? manifest.AppCategories : null;
  const isGame = Array.isArray(categories) && categories.includes(epicGamesCategory);
  return isGame && typeof installLocation === "string" && path.win32.isAbsolute(installLocation) ? installLocation : null;
}

function pathKey(filePath: string): string {
  return path.win32.normalize(filePath).toLowerCase();
}

function folderKey(folderPath: string): string {
  const key = pathKey(folderPath);
  return key.endsWith(path.win32.sep) ? key : `${key}${path.win32.sep}`;
}
