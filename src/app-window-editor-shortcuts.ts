import type { AppWindowContext, AppWindowPage } from "./app-window-controls.js";
import { recordingButtonText, statusClearDelayMs, waitingDots } from "./app-window-shortcut.js";
import {
  defaultEditorShortcuts,
  type EditorCommand,
  editorCommandLabels,
  editorCommands,
  editorCommandUsingShortcut,
  editorEscapeKeyCode,
  editorShortcutFromKeyState,
  type EditorShortcutKeyState,
  editorShortcutModifiers,
  editorShortcutProblem,
  type EditorShortcuts
} from "./editor-shortcuts.js";
import { getRequiredElement } from "./overlay-dom.js";
import type { AppSettings } from "./shared.js";
import { keySeparator } from "./shortcut-keys.js";

interface EditorShortcutRow {
  button: HTMLButtonElement;
  status: HTMLSpanElement;
}

export class EditorShortcutsSection implements AppWindowPage {
  private readonly card = getRequiredElement("editor-shortcuts-card", HTMLDivElement);

  private recordingCommand: EditorCommand | null = null;

  private readonly resetButton = getRequiredElement("editor-shortcuts-reset-button", HTMLButtonElement);

  private readonly rows = new Map<EditorCommand, EditorShortcutRow>();

  private shortcuts: EditorShortcuts = { ...defaultEditorShortcuts };

  private statusTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly context: AppWindowContext) {}

  private row(command: EditorCommand): EditorShortcutRow {
    const row = this.rows.get(command);
    if (!row) {
      throw new Error(`The ${editorCommandLabels[command]} shortcut row is missing.`);
    }

    return row;
  }

  private createRow(command: EditorCommand): HTMLDivElement {
    const label = document.createElement("span");
    label.className = "settings-label";
    label.textContent = editorCommandLabels[command];
    const status = document.createElement("span");
    status.className = "row-status";
    status.ariaLive = "polite";
    const button = document.createElement("button");
    button.className = "softshot-button keybind-button";
    button.type = "button";
    button.ariaLabel = `Change ${editorCommandLabels[command]} shortcut`;
    button.addEventListener("click", (): void => {
      this.beginRecording(command);
    });
    button.addEventListener("blur", (): void => {
      if (this.recordingCommand === command) {
        this.stopRecording();
      }
    });
    this.rows.set(command, { button, status });

    const row = document.createElement("div");
    row.className = "settings-row";
    row.append(label, status, button);
    return row;
  }

  private beginRecording(command: EditorCommand): void {
    if (this.recordingCommand === command) {
      return;
    }

    this.stopRecording();
    this.recordingCommand = command;
    const { button } = this.row(command);
    button.classList.add("recording");
    button.textContent = recordingButtonText;
    button.focus();
  }

  private stopRecording(): void {
    const command = this.recordingCommand;
    if (command === null) {
      return;
    }

    this.recordingCommand = null;
    this.row(command).button.classList.remove("recording");
    this.renderShortcut(command);
  }

  private showHeldModifiers(command: EditorCommand, state: EditorShortcutKeyState): void {
    const modifiers = editorShortcutModifiers(state);
    const { button } = this.row(command);
    if (modifiers.length === 0) {
      button.textContent = recordingButtonText;
      return;
    }

    button.replaceChildren(this.context.shortcutLabels().keycaps(modifiers.join(keySeparator)), waitingDots());
  }

  private handleKeyDown(event: KeyboardEvent): void {
    const command = this.recordingCommand;
    if (command === null) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) {
      return;
    }

    if (event.code === editorEscapeKeyCode) {
      this.stopRecording();
      return;
    }

    const shortcut = editorShortcutFromKeyState(event);
    if (shortcut === null) {
      this.showHeldModifiers(command, event);
      return;
    }

    this.recordShortcut(command, shortcut);
  }

  private handleKeyUp(event: KeyboardEvent): void {
    const command = this.recordingCommand;
    if (command !== null) {
      event.preventDefault();
      this.showHeldModifiers(command, event);
    }
  }

  private recordShortcut(command: EditorCommand, shortcut: string): void {
    const problem = editorShortcutProblem(shortcut);
    if (problem !== null) {
      this.showTemporaryStatus(command, problem);
      return;
    }

    const conflictingCommand = editorCommandUsingShortcut(this.shortcuts, shortcut, command);
    if (conflictingCommand !== null) {
      this.showTemporaryStatus(command, `Used by ${editorCommandLabels[conflictingCommand]}`);
      return;
    }

    this.stopRecording();
    void this.context.updateSettings({ editorShortcuts: { [command]: shortcut } });
  }

  private showTemporaryStatus(command: EditorCommand, message: string): void {
    this.clearStatus();
    const { status } = this.row(command);
    status.textContent = message;
    this.statusTimeout = setTimeout((): void => {
      this.statusTimeout = null;
      status.textContent = "";
    }, statusClearDelayMs);
  }

  private clearStatus(): void {
    if (this.statusTimeout !== null) {
      clearTimeout(this.statusTimeout);
      this.statusTimeout = null;
    }

    for (const { status } of this.rows.values()) {
      status.textContent = "";
    }
  }

  private renderShortcut(command: EditorCommand): void {
    this.row(command).button.replaceChildren(this.context.shortcutLabels().keycaps(this.shortcuts[command]));
  }

  bind(): void {
    this.card.prepend(...editorCommands.map((command) => this.createRow(command)));
    this.resetButton.addEventListener("click", (): void => {
      this.stopRecording();
      this.clearStatus();
      void this.context.updateSettings({ editorShortcuts: { ...defaultEditorShortcuts } });
    });
    addEventListener("keydown", (event): void => {
      this.handleKeyDown(event);
    }, { capture: true });
    addEventListener("keyup", (event): void => {
      this.handleKeyUp(event);
    }, { capture: true });
  }

  render(settings: AppSettings): void {
    this.shortcuts = settings.editorShortcuts;
    for (const command of editorCommands) {
      if (command !== this.recordingCommand) {
        this.renderShortcut(command);
      }
    }

    this.resetButton.disabled = editorCommands.every(
      (command) => settings.editorShortcuts[command] === defaultEditorShortcuts[command]
    );
  }
}
