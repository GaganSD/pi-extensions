import {
  isKeyRelease,
  isKeyRepeat,
  matchesKey,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { decodePrintableKey } from "@earendil-works/pi-tui/dist/keys.js";
import { paintSelectedContent } from "./composer.ts";

export type ComposerSelectionEditor = {
  getText(): string;
  setText(text: string): void;
  getExpandedText(): string;
  getCursor(): { line: number; col: number };
  handleInput(data: string): void;
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
  render(width: number): string[];
  isShowingAutocomplete(): boolean;
  focused?: boolean;
  selectionActive?: boolean;
};

export type ComposerSelectionOptions = {
  copy(text: string): void | Promise<void>;
  requestRender?(): void;
  onCopyError?(error: unknown): void;
};

type PasteableEditor = ComposerSelectionEditor & {
  handlePaste?: (text: string) => void;
  insertTextAtCursor?: (text: string) => void;
};

type InstalledEditor = {
  editor: PasteableEditor;
  originalHandleInput: ComposerSelectionEditor["handleInput"];
  originalHandleMouse: ComposerSelectionEditor["handleMouse"];
  originalHandlePaste?: PasteableEditor["handlePaste"];
  originalInsertTextAtCursor?: PasteableEditor["insertTextAtCursor"];
  originalSetText: ComposerSelectionEditor["setText"];
  originalRender: ComposerSelectionEditor["render"];
  handleInput: ComposerSelectionEditor["handleInput"];
  handleMouse: ComposerSelectionEditor["handleMouse"];
  handlePaste?: PasteableEditor["handlePaste"];
  insertTextAtCursor?: PasteableEditor["insertTextAtCursor"];
  setText: ComposerSelectionEditor["setText"];
  render: ComposerSelectionEditor["render"];
  originalFocus?: PropertyDescriptor;
  focusGetter?: () => boolean;
};

function isSelectAll(data: string): boolean {
  return matchesKey(data, "ctrl+a") || matchesKey(data, "super+a") || matchesKey(data, "ctrl+shift+a");
}

function isCopy(data: string): boolean {
  return matchesKey(data, "ctrl+c") || matchesKey(data, "super+c") || matchesKey(data, "ctrl+shift+c");
}

function isCut(data: string): boolean {
  return matchesKey(data, "ctrl+x") || matchesKey(data, "super+x") || matchesKey(data, "ctrl+shift+x");
}

function isPrintable(data: string): boolean {
  return data.length > 0 && !/[\x00-\x1f\x7f]/.test(data);
}

function isReplace(data: string): boolean {
  return decodePrintableKey(data) !== undefined
    || isPrintable(data)
    || data.includes("\x1b[200~")
    || matchesKey(data, "shift+enter")
    || matchesKey(data, "ctrl+j");
}

function isExpand(data: string): boolean {
  return matchesKey(data, "ctrl+r") || matchesKey(data, "f4");
}

function expandAll(editor: ComposerSelectionEditor): boolean {
  const expanded = editor.getExpandedText();
  if (expanded === editor.getText()) return false;
  editor.setText(expanded);
  return true;
}

/** Adds prompt selection and public-API paste expansion to one composer editor. */
export class ComposerSelectionController {
  private installed?: InstalledEditor;
  private selected = false;
  private escapeArmedText?: string;
  private escapeArmedAt = 0;
  private revision = 0;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  attach(editor: ComposerSelectionEditor, options: ComposerSelectionOptions): void {
    this.dispose();

    const pasteable = editor as unknown as PasteableEditor;
    const originalHandleInput = editor.handleInput;
    const originalHandleMouse = editor.handleMouse;
    const originalHandlePaste = pasteable.handlePaste;
    const originalInsertTextAtCursor = pasteable.insertTextAtCursor;
    const originalSetText = editor.setText;
    const originalRender = editor.render;

    const setSelected = (on: boolean): void => {
      this.selected = on;
      if (editor.selectionActive !== undefined) editor.selectionActive = on;
    };
    const collapse = (): void => {
      setSelected(false);
    };
    const disarmEscape = (): void => {
      this.escapeArmedText = undefined;
    };
    const clearInteraction = (): void => {
      collapse();
      disarmEscape();
      this.revision += 1;
    };
    const copySelected = (cut: boolean): void => {
      const rawText = editor.getText();
      const expandedText = editor.getExpandedText();
      const revision = this.revision;
      collapse();
      try {
        void Promise.resolve(options.copy(expandedText)).then(
          () => {
            if (cut && this.installed?.editor === editor && this.revision === revision && editor.getText() === rawText) {
              editor.setText("");
              options.requestRender?.();
            }
          },
          (error: unknown) => options.onCopyError?.(error),
        );
      } catch (error) {
        options.onCopyError?.(error);
      }
    };

    const setText = (text: string): void => {
      clearInteraction();
      originalSetText.call(editor, text);
    };

    const handleInput = (data: string): void => {
      if (matchesKey(data, "escape")) {
        if (isKeyRelease(data)) return;
        if (isKeyRepeat(data)) {
          if (this.escapeArmedText !== undefined && editor.getText() !== this.escapeArmedText) disarmEscape();
          originalHandleInput.call(editor, data);
          return;
        }

        const text = editor.getText();
        if (
          this.escapeArmedText !== undefined
          && this.now() - this.escapeArmedAt <= 500
          && text === this.escapeArmedText
          && text.length > 0
        ) {
          editor.setText("");
          collapse();
          disarmEscape();
          return;
        }

        collapse();
        this.revision += 1;
        originalHandleInput.call(editor, data);
        const after = editor.getText();
        this.escapeArmedText = after === text && after.length > 0 ? after : undefined;
        this.escapeArmedAt = this.now();
        return;
      }

      this.revision += 1;
      disarmEscape();
      if (isSelectAll(data)) {
        setSelected(editor.getText().length > 0);
        return;
      }
      if (isExpand(data) && expandAll(editor)) {
        options.requestRender?.();
        return;
      }

      if (this.selected) {
        if (isCopy(data) || isCut(data)) {
          copySelected(isCut(data));
          return;
        }
        if (matchesKey(data, "backspace") || matchesKey(data, "delete")) {
          editor.setText("");
          return;
        }
        if (isReplace(data)) {
          editor.setText("");
          originalHandleInput.call(editor, data);
          return;
        }
        collapse();
      }

      originalHandleInput.call(editor, data);
    };

    const handleMouse = (event: TuiMouseEvent): TuiMouseEventResult | undefined => {
      clearInteraction();
      return originalHandleMouse.call(editor, event);
    };

    const render = (width: number): string[] => {
      if (editor.focused === false) {
        collapse();
        disarmEscape();
      }
      const lines = originalRender.call(editor, width);
      if (editor.selectionActive !== undefined || !this.selected || lines.length < 3 || editor.isShowingAutocomplete()) {
        return lines;
      }
      return lines.map((line, index) => {
        if (index === 0 || index === lines.length - 1) return line;
        return paintSelectedContent(line);
      });
    };

    const handlePaste = originalHandlePaste
      ? (text: string): void => {
        this.revision += 1;
        disarmEscape();
        if (this.selected) {
          editor.setText("");
          collapse();
        }
        originalHandlePaste.call(editor, text);
      }
      : undefined;

    const insertTextAtCursor = originalInsertTextAtCursor
      ? (text: string): void => {
        this.revision += 1;
        disarmEscape();
        if (this.selected) {
          editor.setText("");
          collapse();
        }
        originalInsertTextAtCursor.call(editor, text);
      }
      : undefined;

    editor.handleInput = handleInput;
    editor.handleMouse = handleMouse;
    editor.render = render;
    editor.setText = setText;
    if (handlePaste) pasteable.handlePaste = handlePaste;
    if (insertTextAtCursor) pasteable.insertTextAtCursor = insertTextAtCursor;
    if (editor.selectionActive !== undefined) editor.selectionActive = false;

    let focusGetter: (() => boolean) | undefined;
    const originalFocus = Object.getOwnPropertyDescriptor(editor, "focused");
    if (originalFocus?.configurable && "value" in originalFocus && typeof originalFocus.value === "boolean") {
      let focused = originalFocus.value;
      focusGetter = () => focused;
      Object.defineProperty(editor, "focused", {
        configurable: true,
        enumerable: originalFocus.enumerable,
        get: focusGetter,
        set: (value: boolean) => {
          if (focused === value) return;
          focused = value;
          if (!value) clearInteraction();
        },
      });
    }

    this.installed = {
      editor: pasteable,
      originalHandleInput,
      originalHandleMouse,
      originalHandlePaste,
      originalInsertTextAtCursor,
      originalSetText,
      originalRender,
      handleInput,
      handleMouse,
      handlePaste,
      insertTextAtCursor,
      setText,
      render,
      originalFocus,
      focusGetter,
    };
  }

  dispose(): void {
    const installed = this.installed;
    if (installed) {
      if (installed.editor.handleInput === installed.handleInput) installed.editor.handleInput = installed.originalHandleInput;
      if (installed.editor.handleMouse === installed.handleMouse) installed.editor.handleMouse = installed.originalHandleMouse;
      if (installed.editor.render === installed.render) installed.editor.render = installed.originalRender;
      if (installed.editor.setText === installed.setText) installed.editor.setText = installed.originalSetText;
      if (installed.handlePaste && installed.editor.handlePaste === installed.handlePaste) {
        installed.editor.handlePaste = installed.originalHandlePaste;
      }
      if (installed.insertTextAtCursor && installed.editor.insertTextAtCursor === installed.insertTextAtCursor) {
        installed.editor.insertTextAtCursor = installed.originalInsertTextAtCursor;
      }
      if (installed.editor.selectionActive !== undefined) installed.editor.selectionActive = false;
      if (installed.originalFocus && installed.focusGetter) {
        const descriptor = Object.getOwnPropertyDescriptor(installed.editor, "focused");
        if (descriptor?.get === installed.focusGetter) {
          Object.defineProperty(installed.editor, "focused", {
            ...installed.originalFocus,
            value: installed.focusGetter(),
          });
        }
      }
    }
    this.installed = undefined;
    this.selected = false;
    this.escapeArmedText = undefined;
    this.revision += 1;
  }
}
