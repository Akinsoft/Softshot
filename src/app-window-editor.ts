import type { ShortcutLabels } from "./app-window-shortcut-labels.js";
import { VideoEditor } from "./editor.js";
import { getRequiredElement } from "./overlay-dom.js";
import type { EditorBootstrap } from "./shared.js";
import { getSoftshotApi, reportError } from "./softshot-api.js";
import { TaskQueue } from "./task-queue.js";

const editorRootSelector = ".video-editor";

export interface EditorViewHost {
  backRequested(): void;
  editorClosed(): void;
  editorShown(): void;
  shortcutLabels(): ShortcutLabels;
}

export class EditorView {
  private editor: VideoEditor | null = null;

  private readonly page = getRequiredElement("editor-page", HTMLElement);

  private readonly template = getRequiredElement("editor-template", HTMLTemplateElement);

  private readonly transitions = new TaskQueue();

  constructor(private readonly host: EditorViewHost) {}

  private async closeEditor(): Promise<void> {
    const { editor } = this;
    if (!editor) {
      return;
    }

    this.editor = null;
    try {
      await editor.close();
    } finally {
      this.page.replaceChildren();
    }
  }

  private mountEditor(bootstrap: EditorBootstrap): VideoEditor {
    this.page.replaceChildren(this.template.content.cloneNode(true));
    const root = this.page.querySelector<HTMLElement>(editorRootSelector);
    if (!root) {
      throw new Error("The editor layout is missing.");
    }

    return new VideoEditor(root, bootstrap, {
      requestClose: (): void => {
        this.host.backRequested();
      },
      shortcutLabels: (): ShortcutLabels => this.host.shortcutLabels()
    });
  }

  private async openCurrentSession(): Promise<void> {
    const bootstrap = await getSoftshotApi().getEditorBootstrap();
    if (!bootstrap) {
      return;
    }

    if (bootstrap.sessionId === this.editor?.sessionId) {
      this.host.editorShown();
      return;
    }

    await this.closeEditor();
    const editor = this.mountEditor(bootstrap);
    this.editor = editor;
    this.host.editorShown();
    try {
      await editor.initialize();
    } catch (error) {
      await reportError("Could not open the editor.", error);
      if (this.editor === editor) {
        await this.closeEditor();
        this.host.editorClosed();
      }
    }
  }

  bind(): void {
    getSoftshotApi().onEditorOpened((): void => {
      void this.showCurrentSession();
    });
  }

  async close(): Promise<boolean> {
    return await this.transitions.run(async (): Promise<boolean> => {
      const { editor } = this;
      if (!editor) {
        return true;
      }

      if (!await editor.confirmClose()) {
        return false;
      }

      if (this.editor === editor) {
        await this.closeEditor();
      }

      return true;
    });
  }

  async showCurrentSession(): Promise<void> {
    await this.transitions.run(async (): Promise<void> => {
      try {
        await this.openCurrentSession();
      } catch (error) {
        await reportError("Could not open the editor.", error);
      }
    });
  }
}
