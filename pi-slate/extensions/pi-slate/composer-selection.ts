import {
  decodeKittyPrintable,
  isKeyRelease,
  isKeyRepeat,
  matchesKey,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
  paintSelectedContent,
  sliceComposerText,
  type ComposerCursor,
  type ComposerSelectionRange,
} from "./composer.ts";

export type ComposerSelectionEditor = {
  getText(): string;
  setText(text: string): void;
  getCursor(): { line: number; col: number };
  handleInput(data: string): void;
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
  render(width: number): string[];
  isShowingAutocomplete(): boolean;
  focused?: boolean;
  selectionActive?: boolean;
  selectionRange?: ComposerSelectionRange;
};

export type ComposerSelectionOptions = {
  copy?(text: string): void | Promise<void>;
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

function isChromeRow(event: TuiMouseEvent): boolean {
  return event.y <= 0 || event.y >= Math.max(1, event.height) - 1;
}

function asClick(event: TuiMouseEvent): TuiMouseEvent {
  return { ...event, type: "click", button: "left" };
}

function sameCursor(a: ComposerCursor, b: ComposerCursor): boolean {
  return a.line === b.line && a.col === b.col;
}

function isPrintable(data: string): boolean {
  return data.length > 0 && !/[\x00-\x1f\x7f]/.test(data);
}

function isReplace(data: string): boolean {
  // Normalize xterm modifyOtherKeys to CSI-u so only the public Pi TUI API is needed.
  const printableInput = data.replace(/^\x1b\[27;(\d+);(\d+)~$/, "\x1b[$2;$1u");
  return decodeKittyPrintable(printableInput) !== undefined
    || isPrintable(data)
    || data.includes("\x1b[200~")
    || matchesKey(data, "shift+enter")
    || matchesKey(data, "ctrl+j");
}

const PASTE_TOKEN = /\[paste #(\d+)(?: \+\d+ lines| \d+ chars)?\]/g;

/** Same threshold Pi uses before collapsing a paste to `[paste #N]`. */
export function isCollapsedPaste(text: string): boolean {
  return text.split("\n").length > 10 || text.length > 1000;
}

export function pasteTokenAtCursor(
  text: string,
  cursor: { line: number; col: number },
): { start: number; end: number; number: string; token: string } | undefined {
  const line = text.split("\n")[cursor.line];
  if (line === undefined) return undefined;
  for (const match of line.matchAll(PASTE_TOKEN)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (cursor.col >= start && cursor.col <= end) {
      return { start, end, number: match[1]!, token: match[0] };
    }
  }
  return undefined;
}

function isPasteClick(event: TuiMouseEvent): boolean {
  return event.button === "left" && event.type === "click";
}

type EditorPasteState = {
  state: { lines: string[]; cursorLine: number; cursorCol: number };
  pastes: Map<number, string>;
  cancelAutocomplete?: () => void;
  exitHistoryBrowsing?: () => void;
  onChange?: (text: string) => void;
  invalidate?: () => void;
};

type RevealedPaste = {
  id: number;
  token: string;
  body: string;
  startLine: number;
  startCol: number;
};

function replaceRange(
  editor: ComposerSelectionEditor,
  startLine: number,
  startCol: number,
  endLine: number,
  endCol: number,
  replacement: string,
): boolean {
  const internals = editor as unknown as Partial<EditorPasteState>;
  const state = internals.state;
  if (!state || !Array.isArray(state.lines) || startLine < 0 || endLine >= state.lines.length) return false;
  const startLineText = state.lines[startLine];
  const endLineText = state.lines[endLine];
  if (!startLineText || !endLineText || startCol < 0 || endCol > endLineText.length) return false;

  internals.cancelAutocomplete?.call(editor);
  internals.exitHistoryBrowsing?.call(editor);

  const inserted = replacement.split("\n");
  const before = startLineText.slice(0, startCol);
  const after = endLineText.slice(endCol);
  const nextLines = [...state.lines];
  if (inserted.length === 1) nextLines.splice(startLine, endLine - startLine + 1, `${before}${inserted[0] ?? ""}${after}`);
  else nextLines.splice(startLine, endLine - startLine + 1, `${before}${inserted[0] ?? ""}`, ...inserted.slice(1, -1), `${inserted.at(-1) ?? ""}${after}`);

  internals.state = {
    lines: nextLines,
    cursorLine: startLine + inserted.length - 1,
    cursorCol: inserted.length === 1 ? before.length + (inserted[0] ?? "").length : (inserted.at(-1) ?? "").length,
  };
  internals.onChange?.(nextLines.join("\n"));
  internals.invalidate?.call(editor);
  return true;
}

function revealedRange(item: RevealedPaste): { endLine: number; endCol: number } {
  const lines = item.body.split("\n");
  if (lines.length === 1) return { endLine: item.startLine, endCol: item.startCol + (lines[0] ?? "").length };
  return { endLine: item.startLine + lines.length - 1, endCol: (lines.at(-1) ?? "").length };
}

function cursorInRevealed(item: RevealedPaste, cursor: { line: number; col: number }): boolean {
  const { endLine, endCol } = revealedRange(item);
  if (cursor.line < item.startLine || cursor.line > endLine) return false;
  if (cursor.line === item.startLine && cursor.col < item.startCol) return false;
  if (cursor.line === endLine && cursor.col > endCol) return false;
  return true;
}

/** Adds prompt selection and click-to-toggle paste expansion to one composer editor. */
export class ComposerSelectionController {
  private installed?: InstalledEditor;
  private selected = false;
  private range?: ComposerSelectionRange;
  private dragging = false;
  private escapeArmedText?: string;
  private escapeArmedAt = 0;
  private revision = 0;
  private revealed: RevealedPaste[] = [];
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  attach(editor: ComposerSelectionEditor, options: ComposerSelectionOptions = {}): void {
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
      if (on) {
        this.range = undefined;
        editor.selectionRange = undefined;
      }
      if (editor.selectionActive !== undefined) editor.selectionActive = on;
    };
    const setRange = (range: ComposerSelectionRange | undefined): void => {
      this.range = range;
      editor.selectionRange = range;
      if (range) setSelected(false);
    };
    const collapse = (): void => {
      this.dragging = false;
      setRange(undefined);
      setSelected(false);
    };
    const disarmEscape = (): void => {
      this.escapeArmedText = undefined;
    };
    const clearRevealed = (): void => {
      this.revealed = [];
    };
    const clearInteraction = (): void => {
      collapse();
      disarmEscape();
      this.revision += 1;
    };
    const togglePasteAtCursor = (): boolean => {
      const cursor = editor.getCursor();
      const open = [...this.revealed].reverse().find((item) => cursorInRevealed(item, cursor));
      if (open) {
        const { endLine, endCol } = revealedRange(open);
        if (!replaceRange(editor, open.startLine, open.startCol, endLine, endCol, open.token)) return false;
        this.revealed = this.revealed.filter((item) => item !== open);
        return true;
      }

      const token = pasteTokenAtCursor(editor.getText(), cursor);
      if (!token) return false;
      const internals = editor as unknown as Partial<EditorPasteState>;
      const id = Number(token.number);
      const body = internals.pastes instanceof Map ? internals.pastes.get(id) : undefined;
      if (typeof body !== "string") return false;
      if (!replaceRange(editor, cursor.line, token.start, cursor.line, token.end, body)) return false;
      this.revealed.push({ id, token: token.token, body, startLine: cursor.line, startCol: token.start });
      return true;
    };

    const setText = (text: string): void => {
      clearInteraction();
      clearRevealed();
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

      if (this.selected) {
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
      if (event.type === "wheel" || event.type === "move") {
        return originalHandleMouse.call(editor, event);
      }

      if (event.button === "left" && event.type === "press" && !isChromeRow(event)) {
        clearInteraction();
        originalHandleMouse.call(editor, asClick(event));
        const cursor = editor.getCursor();
        this.dragging = true;
        setRange({ start: cursor, end: cursor });
        return { handled: true, capture: true, focus: true };
      }

      if (event.button === "left" && event.type === "drag" && this.dragging) {
        originalHandleMouse.call(editor, asClick(event));
        const start = this.range?.start ?? editor.getCursor();
        setRange({ start, end: editor.getCursor() });
        return { handled: true, render: true };
      }

      if (event.type === "release" && this.dragging) {
        this.dragging = false;
        const range = this.range;
        if (!range || sameCursor(range.start, range.end)) {
          setRange(undefined);
          if (isPasteClick({ ...event, type: "click", button: "left" }) && togglePasteAtCursor()) {
            options.requestRender?.();
          }
          return { handled: true };
        }
        if (options.copy) {
          try {
            void Promise.resolve(options.copy(sliceComposerText(editor.getText(), range))).then(
              undefined,
              (error: unknown) => options.onCopyError?.(error),
            );
          } catch (error) {
            options.onCopyError?.(error);
          }
        }
        return { handled: true };
      }

      if (event.type !== "release") clearInteraction();
      const result = originalHandleMouse.call(editor, event);
      if (isPasteClick(event) && togglePasteAtCursor()) options.requestRender?.();
      return result;
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
        clearRevealed();
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
        if (isCollapsedPaste(text) && pasteable.handlePaste) {
          clearRevealed();
          pasteable.handlePaste(text);
          return;
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
      installed.editor.selectionRange = undefined;
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
    this.range = undefined;
    this.dragging = false;
    this.escapeArmedText = undefined;
    this.revealed = [];
    this.revision += 1;
  }
}
