import type { EditorBootstrap } from "./shared";

export type UnsavedEditingWork = "edits" | "recording";

export interface EditingSessionFileCleanup {
  deletedFiles: string[];
  isCompleted: boolean;
  retainedFiles: string[];
}

export class EditingSession {
  private clipboardFilePath: string | null = null;

  private hasUnsavedEdits = false;

  private isCompleted = false;

  private operationCount = 0;

  private readonly savePaths = new Set<string>();

  private savedFilePath: string | null = null;

  private readonly temporaryFiles: Set<string>;

  constructor(readonly data: EditorBootstrap, temporaryFilePaths: readonly string[]) {
    this.temporaryFiles = new Set(temporaryFilePaths);
  }

  private isReusableSourceFile(filePath: string): boolean {
    return this.data.canReuseSourceFile && this.data.sourceFilePath === filePath;
  }

  get id(): string {
    return this.data.sessionId;
  }

  get isBusy(): boolean {
    return this.operationCount > 0;
  }

  assertPreparedFile(filePath: string): void {
    if (!this.isReusableSourceFile(filePath)) {
      this.assertTemporaryFile(filePath);
    }
  }

  assertSavePath(filePath: string): void {
    if (!this.savePaths.has(filePath)) {
      throw new Error("The save path was not selected by this editor.");
    }
  }

  assertTemporaryFile(filePath: string): void {
    if (!this.temporaryFiles.has(filePath)) {
      throw new Error("The prepared recording file does not belong to this editor.");
    }
  }

  fileCleanup(): EditingSessionFileCleanup {
    const keptSourceFilePath = this.data.source.kind === "recording" && this.temporaryFiles.has(this.data.sourceFilePath)
      ? this.data.sourceFilePath
      : null;
    const completedFiles = [this.clipboardFilePath, this.savedFilePath]
      .filter((filePath): filePath is string => filePath !== null && this.temporaryFiles.has(filePath));
    const retainedCandidates = this.isCompleted && completedFiles.length > 0 ? completedFiles : [keptSourceFilePath];
    const retainedFiles = new Set(retainedCandidates.filter((filePath): filePath is string => filePath !== null));
    const deletedFiles = new Set(this.temporaryFiles);
    for (const filePath of retainedFiles) {
      deletedFiles.delete(filePath);
    }

    return {
      deletedFiles: [...deletedFiles],
      isCompleted: this.isCompleted,
      retainedFiles: [...retainedFiles]
    };
  }

  hasTemporaryFile(filePath: string): boolean {
    return this.temporaryFiles.has(filePath);
  }

  isEditingFile(filePath: string): boolean {
    return this.data.source.kind === "file" && this.data.source.filePath === filePath;
  }

  markSaved(preparedFilePath: string, targetFilePath: string): void {
    this.isCompleted = true;
    this.savedFilePath = preparedFilePath;
    this.savePaths.delete(targetFilePath);
  }

  registerSavePath(filePath: string): void {
    this.savePaths.add(filePath);
  }

  registerTemporaryFile(filePath: string): void {
    this.temporaryFiles.add(filePath);
  }

  replaceClipboardFile(filePath: string): string | null {
    const previousFilePath = this.clipboardFilePath;
    if (previousFilePath !== null) {
      this.temporaryFiles.delete(previousFilePath);
    }

    this.registerTemporaryFile(filePath);
    this.clipboardFilePath = filePath;
    this.isCompleted = true;
    return previousFilePath;
  }

  async runOperation<T>(operation: () => Promise<T>): Promise<T> {
    this.operationCount += 1;
    try {
      return await operation();
    } finally {
      this.operationCount -= 1;
    }
  }

  setUnsavedEdits(hasUnsavedEdits: boolean): void {
    this.hasUnsavedEdits = hasUnsavedEdits;
  }

  unsavedWork(): UnsavedEditingWork | null {
    if (this.hasUnsavedEdits) {
      return "edits";
    }

    return this.data.source.kind === "recording" && !this.isCompleted ? "recording" : null;
  }
}
