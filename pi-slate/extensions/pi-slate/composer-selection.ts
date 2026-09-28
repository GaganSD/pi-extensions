import {
  isKeyRelease,
  isKeyRepeat,
  matchesKey,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { decodePrintableKey } from "@earendil-works/pi-tui/dist/keys.js";

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
  onPasteImage?(): void;
};

export type ComposerSelectionOptions = {
  copy(text: string): void | Promise<void>;
  requestRender?(): void;
  onCopyError?(error: unknown): void;
  imagePath?(number: string): string | undefined;
  matchesImage?(number: string, path: string): boolean;
  onTokenExpansion?(): void;
};

type PasteableEditor = ComposerSelectionEditor & {
  handlePaste?: (text: string) => void;
  insertTextAtCursor?: (text: string) => void;
};
type PasteToken = { kind: "paste" | "image"; start: number; end: number; number?: string };
// Pi has no public local paste expansion API; validate these fields before bypassing setText.
type EditorInternals = {
  state: { lines: string[]; cursorLine: number; cursorCol: number };
  pastes: Map<number, string>;
  normalizeText?: (text: string) => string;
  pasteCounter: number;
  undoStack: { push(value: unknown): void; pop(): unknown };
  pushUndoSnapshot(): void;
  cancelAutocomplete(): void;
  exitHistoryBrowsing(): void;
  lastAction: unknown;
  preferredVisualCol?: unknown;
  onChange?: (text: string) => void;
  invalidate?(): void;
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

const ESCAPE_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|_[^\x07]*(?:\x07|$)|\][^\x07]*(?:\x07|\x1b\\|$))/y;
const REVERSE_ON = "\x1b[7m";
const REVERSE_OFF = "\x1b[27m";
const RESET = "\x1b[0m";

function selectedLine(line: string): string {
  let firstText = -1;
  let lastTextEnd = -1;

  for (let index = 0; index < line.length;) {
    ESCAPE_SEQUENCE.lastIndex = index;
    const escape = ESCAPE_SEQUENCE.exec(line);
    if (escape) {
      index += escape[0].length;
      continue;
    }

    const codePoint = line.codePointAt(index);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    if (!/\s/u.test(character)) {
      if (firstText === -1) firstText = index;
      lastTextEnd = index + character.length;
    }
    index += character.length;
  }

  // Whitespace-only rendered rows are editor padding/chrome, not prompt text.
  if (firstText === -1) return line;
  const before = line.slice(0, firstText);
  const text = line.slice(firstText, lastTextEnd).replaceAll(RESET, `${RESET}${REVERSE_ON}`);
  const after = line.slice(lastTextEnd);
  return `${before}${REVERSE_ON}${text}${REVERSE_OFF}${after}`;
}

function isSelectAll(data: string): boolean {
  return matchesKey(data, "super+a") || matchesKey(data, "ctrl+shift+a");
}

function isCopy(data: string): boolean {
  return matchesKey(data, "ctrl+c") || matchesKey(data, "super+c") || matchesKey(data, "ctrl+shift+c");
}

function isCut(data: string): boolean {
  return matchesKey(data, "super+x") || matchesKey(data, "ctrl+shift+x");
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

function isPasteKey(data: string): boolean {
  return matchesKey(data, "super+v") || matchesKey(data, "ctrl+v") || matchesKey(data, "alt+v");
}

export function tokenAtCursor(
  text: string,
  cursor: { line: number; col: number },
): PasteToken | undefined {
  const line = text.split("\n")[cursor.line];
  if (line === undefined) return undefined;
  for (const match of line.matchAll(/\[paste #(\d+)( (?:\+\d+ lines|\d+ chars))?\]/g)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (cursor.col >= start && cursor.col <= end) return { kind: "paste", start, end, number: match[1] };
  }
  for (const match of line.matchAll(/\[image[ -](\d+)\]/g)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (cursor.col >= start && cursor.col <= end) {
      return { kind: "image", start, end, number: match[1] };
    }
  }
  return undefined;
}

function replaceToken(
  editor: ComposerSelectionEditor,
  token: PasteToken,
  replacement: string,
  onExpansion?: () => void,
): boolean {
  const internals = editor as unknown as Partial<EditorInternals>;
  const state = internals.state;
  const pastes = internals.pastes;
  const cursor = editor.getCursor();
  if (
    !state || !Array.isArray(state.lines) || !state.lines.every((line) => typeof line === "string")
    || !Number.isInteger(cursor.line) || !Number.isInteger(cursor.col)
    || cursor.line < 0 || cursor.line >= state.lines.length
    || cursor.col < 0 || cursor.col > state.lines[cursor.line]!.length
    || state.cursorLine !== cursor.line || state.cursorCol !== cursor.col
    || !(pastes instanceof Map) || !Number.isSafeInteger(internals.pasteCounter) || internals.pasteCounter! < 0
    || !internals.undoStack || typeof internals.undoStack.push !== "function"
    || typeof internals.undoStack.pop !== "function" || typeof internals.pushUndoSnapshot !== "function"
    || typeof internals.cancelAutocomplete !== "function" || typeof internals.exitHistoryBrowsing !== "function"
  ) return false;
  let highestPasteId = 0;
  for (const [id, body] of pastes) {
    if (!Number.isSafeInteger(id) || id < 1 || typeof body !== "string") return false;
    highestPasteId = Math.max(highestPasteId, id);
  }
  if (internals.pasteCounter! < highestPasteId) return false;

  const line = state.lines[cursor.line]!;
  if (token.end > line.length || token.start < 0 || token.start > cursor.col || cursor.col > token.end) return false;
  const insertedLines = replacement.split("\n");
  const nextLines = [...state.lines];
  const before = line.slice(0, token.start);
  const after = line.slice(token.end);
  const firstLine = `${before}${insertedLines[0] ?? ""}`;
  const lastLine = `${insertedLines.at(-1) ?? ""}${after}`;
  const lineCount = insertedLines.length;
  if (lineCount === 1) nextLines[cursor.line] = `${firstLine}${after}`;
  else nextLines.splice(cursor.line, 1, firstLine, ...insertedLines.slice(1, -1), lastLine);

  try {
    internals.cancelAutocomplete.call(editor);
    internals.exitHistoryBrowsing.call(editor);
    internals.pushUndoSnapshot.call(editor);
  } catch {
    return false;
  }

  const nextPastes = new Map(pastes);
  if (token.kind === "paste" && token.number) {
    const id = Number(token.number);
    const stillReferenced = nextLines.some((nextLine) =>
      [...nextLine.matchAll(/\[paste #(\d+)(?: \+\d+ lines| \d+ chars)?\]/g)]
        .some((match) => Number(match[1]) === id),
    );
    if (!stillReferenced) nextPastes.delete(id);
  }
  const nextCursorLine = cursor.line + lineCount - 1;
  const nextCursorCol = lineCount === 1 ? firstLine.length : lastLine.length - after.length;
  internals.state = { lines: nextLines, cursorLine: nextCursorLine, cursorCol: nextCursorCol };
  internals.pastes = nextPastes;
  internals.lastAction = null;
  internals.preferredVisualCol = null;
  internals.onChange?.(nextLines.join("\n"));
  internals.invalidate?.call(editor);
  try {
    onExpansion?.();
  } catch {
    // Preview refresh is best-effort; the editor mutation and undo snapshot are complete.
  }
  return true;
}

function expandAtCursor(
  editor: ComposerSelectionEditor,
  imagePath?: (number: string) => string | undefined,
  onExpansion?: () => void,
): boolean {
  const token = tokenAtCursor(editor.getText(), editor.getCursor());
  if (!token) return false;
  if (token.kind === "paste") {
    const pastes = (editor as unknown as Partial<EditorInternals>).pastes;
    const body = pastes instanceof Map ? pastes.get(Number(token.number)) : undefined;
    return typeof body === "string" && replaceToken(editor, token, body, onExpansion);
  }
  const path = token.number ? imagePath?.(token.number) : undefined;
  return Boolean(path && replaceToken(editor, token, path, onExpansion));
}

function normalizeEditorText(editor: ComposerSelectionEditor, text: string): string | undefined {
  const normalizeText = (editor as unknown as Partial<EditorInternals>).normalizeText;
  if (typeof normalizeText !== "function") return undefined;
  try {
    return normalizeText.call(editor, text);
  } catch {
    return undefined;
  }
}

function expandsPayload(
  editor: ComposerSelectionEditor,
  text: string,
  options: ComposerSelectionOptions,
): boolean {
  const token = tokenAtCursor(editor.getText(), editor.getCursor());
  if (!token) return false;
  if (token.kind === "paste") {
    const pastes = (editor as unknown as Partial<EditorInternals>).pastes;
    const body = pastes instanceof Map ? pastes.get(Number(token.number)) : undefined;
    const normalizedText = normalizeEditorText(editor, text);
    return normalizedText !== undefined && body === normalizedText
      && replaceToken(editor, token, body, options.onTokenExpansion);
  }
  return Boolean(
    token.number && options.matchesImage?.(token.number, text)
    && options.imagePath && replaceToken(editor, token, options.imagePath(token.number) ?? "", options.onTokenExpansion),
  );
}

/** Adds prompt selection and token-local expansion to one composer editor. */
export class ComposerSelectionController {
  private installed?: InstalledEditor;
  private selectedLength?: number;
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

    const collapse = (): void => {
      this.selectedLength = undefined;
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
    const expandPayload = (text: string): boolean => expandsPayload(editor, text, options);

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
        const length = editor.getText().length;
        this.selectedLength = length > 0 ? length : undefined;
        return;
      }
      if (matchesKey(data, "super+v") && pasteable.onPasteImage) {
        pasteable.onPasteImage.call(editor);
        return;
      }

      if (this.selectedLength !== undefined) {
        if (isCopy(data) || isCut(data)) {
          copySelected(isCut(data));
          return;
        }
        if (isPasteKey(data)) {
          // Pi reads the clipboard asynchronously; the payload hook below decides
          // whether to replace the selection or expand the token under the caret.
          originalHandleInput.call(editor, data);
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
      } else if (matchesKey(data, "f4")) {
        if (expandAtCursor(editor, options.imagePath, options.onTokenExpansion)) return;
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
      if (this.selectedLength === undefined || lines.length < 3 || editor.isShowingAutocomplete()) return lines;
      return lines.map((line, index) => {
        if (index === 0 || index === lines.length - 1) return line;
        return selectedLine(line);
      });
    };

    const handlePaste = originalHandlePaste
      ? (text: string): void => {
        this.revision += 1;
        disarmEscape();
        if (this.selectedLength !== undefined) {
          editor.setText("");
          collapse();
        } else if (expandPayload(text)) {
          return;
        }
        originalHandlePaste.call(editor, text);
      }
      : undefined;

    const insertTextAtCursor = originalInsertTextAtCursor
      ? (text: string): void => {
        this.revision += 1;
        disarmEscape();
        if (this.selectedLength !== undefined) {
          editor.setText("");
          collapse();
        } else if (expandPayload(text)) {
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
    this.selectedLength = undefined;
    this.escapeArmedText = undefined;
    this.revision += 1;
  }
}
