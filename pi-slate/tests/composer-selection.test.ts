import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import {
  Editor,
  getKeybindings,
  setKeybindings,
  type EditorTheme,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { TuiBase } from "../node_modules/@earendil-works/pi-tui/dist/tui.js";
import { paintSelectedContent } from "../extensions/pi-slate/composer.ts";
import {
  ComposerSelectionController,
  pasteTokenAtCursor,
  type ComposerSelectionEditor,
} from "../extensions/pi-slate/composer-selection.ts";

class FakeEditor implements ComposerSelectionEditor {
  text: string;
  expandedText?: string;
  pastes = new Map<number, string>();
  setTextCalls: string[] = [];
  inputCalls: string[] = [];
  pasteCalls: string[] = [];
  mouseCalls = 0;
  cursor?: { line: number; col: number };
  renderedLines = ["TOP", "prompt", "BOTTOM"];
  autocomplete = false;
  onInput?: (data: string, editor: FakeEditor) => void;

  constructor(text = "") {
    this.text = text;
  }

  get state(): { lines: string[]; cursorLine: number; cursorCol: number } {
    const cursor = this.getCursor();
    return { lines: this.text.split("\n"), cursorLine: cursor.line, cursorCol: cursor.col };
  }

  set state(next: { lines: string[]; cursorLine: number; cursorCol: number }) {
    this.text = next.lines.join("\n");
    this.cursor = { line: next.cursorLine, col: next.cursorCol };
  }

  getText(): string {
    return this.text;
  }

  setText(text: string): void {
    this.setTextCalls.push(text);
    this.text = text;
  }

  getExpandedText(): string {
    return this.expandedText ?? this.text;
  }

  getCursor(): { line: number; col: number } {
    return this.cursor ?? { line: 0, col: this.text.length };
  }

  handlePaste = (text: string): void => {
    this.pasteCalls.push(text);
    this.text += text;
  };

  handleInput = (data: string): void => {
    this.inputCalls.push(data);
    if (this.onInput) {
      this.onInput(data, this);
    } else if (data.length > 0 && !/[\x00-\x1f\x7f]/.test(data)) {
      this.text += data;
    }
  };

  handleMouse = (_event: TuiMouseEvent): TuiMouseEventResult | undefined => {
    this.mouseCalls += 1;
    return { handled: true };
  };

  render = (_width: number): string[] => [...this.renderedLines];

  isShowingAutocomplete(): boolean {
    return this.autocomplete;
  }
}

function attach(
  editor: FakeEditor,
  copy: (text: string) => void = () => {},
  now: () => number = Date.now,
): ComposerSelectionController {
  const selection = new ComposerSelectionController(now);
  selection.attach(editor, { copy });
  return selection;
}

const SELECT_ALL = "\x01";
const COPY = "\x03";
const CUT = "\x18";

test("Ctrl+A selects all without inserting a", () => {
  const editor = new FakeEditor("hello");
  editor.renderedLines = ["TOP", "hello", "BOTTOM"];
  attach(editor);

  editor.handleInput(SELECT_ALL);

  assert.equal(editor.getText(), "hello");
  assert.deepEqual(editor.inputCalls, []);
  assert.match(editor.render(20)[1]!, /\x1b\[7mhello\x1b\[27m/);
});

test("Home still moves to the line start after select-all is available", () => {
  const editor = new FakeEditor("hello");
  attach(editor);
  editor.handleInput(SELECT_ALL);
  editor.handleInput("\x1b[H");
  assert.deepEqual(editor.inputCalls, ["\x1b[H"]);
  assert.equal(editor.getText(), "hello");
});

test("Backspace and printable input replace a select-all range", async (t) => {
  await t.test("Backspace clears", () => {
    const editor = new FakeEditor("hello");
    attach(editor);
    editor.handleInput(SELECT_ALL);
    editor.handleInput("\x7f");
    assert.deepEqual(editor.setTextCalls, [""]);
    assert.deepEqual(editor.inputCalls, []);
    assert.equal(editor.getText(), "");
  });

  await t.test("printable input clears then inserts through the editor", () => {
    const editor = new FakeEditor("hello");
    attach(editor);
    editor.handleInput(SELECT_ALL);
    editor.handleInput("x");
    assert.deepEqual(editor.setTextCalls, [""]);
    assert.deepEqual(editor.inputCalls, ["x"]);
    assert.equal(editor.getText(), "x");
  });
});

test("Enter, Tab, and Ctrl+D keep selected text and pass through", () => {
  for (const key of ["\r", "\t", "\x04"]) {
    const editor = new FakeEditor("keep me");
    attach(editor);
    editor.handleInput(SELECT_ALL);
    editor.handleInput(key);
    assert.equal(editor.getText(), "keep me", key);
    assert.deepEqual(editor.setTextCalls, [], key);
    assert.deepEqual(editor.inputCalls, [key], key);
  }
});

test("selected Ctrl+C copies expanded text without calling the editor", () => {
  const editor = new FakeEditor("[paste #1]");
  editor.expandedText = "full pasted text";
  const copied: string[] = [];
  attach(editor, (text) => copied.push(text));
  editor.handleInput(SELECT_ALL);
  editor.handleInput(COPY);
  assert.deepEqual(copied, ["full pasted text"]);
  assert.deepEqual(editor.inputCalls, []);
  assert.equal(editor.getText(), "[paste #1]");
});

test("unselected Ctrl+C and Ctrl+X pass through", () => {
  const editor = new FakeEditor("hello");
  const copied: string[] = [];
  attach(editor, (text) => copied.push(text));
  editor.handleInput(COPY);
  editor.handleInput(CUT);
  assert.deepEqual(copied, []);
  assert.deepEqual(editor.inputCalls, [COPY, CUT]);
  assert.equal(editor.getText(), "hello");
});

test("selected Ctrl+X cuts after a successful copy", async () => {
  const editor = new FakeEditor("hello");
  const copied: string[] = [];
  attach(editor, (text) => copied.push(text));
  editor.handleInput(SELECT_ALL);
  editor.handleInput(CUT);
  await Promise.resolve();
  assert.deepEqual(copied, ["hello"]);
  assert.equal(editor.getText(), "");
});

test("a first unchanged Escape passes through and a second within 500ms clears", () => {
  let time = 1_000;
  const editor = new FakeEditor("hello");
  attach(editor, () => {}, () => time);

  editor.handleInput("\x1b");
  assert.equal(editor.getText(), "hello");
  assert.deepEqual(editor.inputCalls, ["\x1b"]);

  time = 1_500;
  editor.handleInput("\x1b");
  assert.equal(editor.getText(), "");
  assert.deepEqual(editor.setTextCalls, [""]);
  assert.deepEqual(editor.inputCalls, ["\x1b"]);
});

test("pasteTokenAtCursor finds Pi paste markers and ignores nearby text", () => {
  const text = "see [paste #1 +10 lines] done";
  assert.equal(pasteTokenAtCursor(text, { line: 0, col: 6 })?.number, "1");
  assert.equal(pasteTokenAtCursor(text, { line: 0, col: 0 }), undefined);
  assert.equal(pasteTokenAtCursor("see [image-1]", { line: 0, col: 6 }), undefined);
});

test("clicking a paste token reveals only that token", () => {
  const editor = new FakeEditor("see [paste #1 +10 lines] and [paste #2 +5 lines]");
  editor.pastes.set(1, "one\ntwo");
  editor.pastes.set(2, "keep");
  editor.cursor = { line: 0, col: 10 };
  attach(editor);

  editor.handleMouse({ type: "move", button: "none" } as TuiMouseEvent);
  assert.deepEqual(editor.setTextCalls, []);
  assert.equal(editor.getText(), "see [paste #1 +10 lines] and [paste #2 +5 lines]");

  editor.handleMouse({ type: "click", button: "left" } as TuiMouseEvent);
  assert.deepEqual(editor.setTextCalls, []);
  assert.equal(editor.getText(), "see one\ntwo and [paste #2 +5 lines]");
  assert.equal(editor.pastes.has(1), false);
  assert.equal(editor.pastes.get(2), "keep");
});

test("clicking away from a paste token does not expand", () => {
  const editor = new FakeEditor("see [paste #1 +10 lines]");
  editor.expandedText = "see body";
  editor.cursor = { line: 0, col: 1 };
  attach(editor);
  editor.handleMouse({ type: "click", button: "left" } as TuiMouseEvent);
  assert.deepEqual(editor.setTextCalls, []);
  assert.equal(editor.getText(), "see [paste #1 +10 lines]");
});

test("paintSelectedContent skips rails, the › prompt, and empty shelf rows", () => {
  assert.equal(paintSelectedContent("  hello\x1b[0m world  "), "  \x1b[7mhello\x1b[0m\x1b[7m world\x1b[27m  ");
  assert.equal(paintSelectedContent("│ hello world │"), "│ \x1b[7mhello world\x1b[27m │");
  assert.equal(paintSelectedContent("│ ›                                        │"), "│ ›                                        │");
  assert.equal(paintSelectedContent("│                                          │"), "│                                          │");
});

test("selected rendering skips invert while autocomplete is open", () => {
  const editor = new FakeEditor("/help");
  editor.autocomplete = true;
  editor.renderedLines = ["TOP", "/help", "BOTTOM", "  help"];
  attach(editor);
  editor.handleInput(SELECT_ALL);
  assert.deepEqual(editor.render(20), ["TOP", "/help", "BOTTOM", "  help"]);
});

const bindingsByTest = new WeakMap<TestContext, { previous: ReturnType<typeof getKeybindings>; current: KeybindingsManager }>();

function createIntegratedEditor(t: TestContext): { editor: CustomEditor; tui: TuiBase } {
  let bindings = bindingsByTest.get(t);
  if (!bindings) {
    const previous = getKeybindings();
    const current = new KeybindingsManager();
    bindings = { previous, current };
    bindingsByTest.set(t, bindings);
    setKeybindings(current);
    t.after(() => setKeybindings(previous));
  }
  const TuiBaseRuntime = TuiBase as unknown as new (terminal: unknown) => TuiBase;
  const tui = new TuiBaseRuntime({ rows: 24, columns: 80, hideCursor() {} });
  (tui as unknown as { stopped: boolean }).stopped = true;
  const identity = (text: string): string => text;
  const theme = {
    borderColor: identity,
    selectList: {
      selectedPrefix: identity,
      selectedText: identity,
      description: identity,
      scrollInfo: identity,
      noMatch: identity,
    },
  } as EditorTheme;
  const editor = new CustomEditor(tui as unknown as TUI, theme, bindings.current);
  tui.setFocus(editor);
  return { editor, tui };
}

function send(tui: TuiBase, data: string): void {
  (tui as unknown as { handleTerminalInput(data: string): void }).handleTerminalInput(data);
}

test("select-all then Enter submits the prompt instead of erasing it", () => {
  const submitted: string[] = [];
  const editor = new Editor({
    terminal: { rows: 24, columns: 80 },
    requestRender() {},
  } as TUI, { borderColor: (text) => text } as EditorTheme);
  editor.onSubmit = (text) => submitted.push(text);
  const selection = new ComposerSelectionController();
  selection.attach(editor, { copy() {} });
  editor.setText("keep this prompt");
  editor.handleInput(SELECT_ALL);
  editor.handleInput("\r");
  assert.deepEqual(submitted, ["keep this prompt"]);
  selection.dispose();
});

test("selected Ctrl+C copies while unselected Ctrl+C keeps Pi clear behavior", async (t) => {
  const { editor, tui } = createIntegratedEditor(t);
  const copied: string[] = [];
  let clears = 0;
  editor.onAction("app.clear", () => { clears += 1; });
  const selection = new ComposerSelectionController();
  selection.attach(editor, { copy: (text) => { copied.push(text); } });
  editor.setText("prompt");
  send(tui, COPY);
  assert.equal(clears, 1);
  send(tui, SELECT_ALL);
  send(tui, COPY);
  await Promise.resolve();
  assert.deepEqual(copied, ["prompt"]);
  assert.equal(clears, 1);
  assert.equal(editor.getText(), "prompt");
  selection.dispose();
});

test("selected Ctrl+X cuts; unselected Ctrl+X keeps the last-message copy action", async (t) => {
  const { editor, tui } = createIntegratedEditor(t);
  const copied: string[] = [];
  let messageCopies = 0;
  editor.onAction("app.message.copy", () => { messageCopies += 1; });
  const selection = new ComposerSelectionController();
  selection.attach(editor, { copy: (text) => { copied.push(text); } });
  editor.setText("keep");
  send(tui, CUT);
  assert.equal(messageCopies, 1);
  assert.equal(editor.getText(), "keep");
  send(tui, SELECT_ALL);
  send(tui, CUT);
  await Promise.resolve();
  assert.deepEqual(copied, ["keep"]);
  assert.equal(editor.getText(), "");
  assert.equal(messageCopies, 1);
  selection.dispose();
});

test("async cuts repaint only after successful guarded prompt clearing", async (t) => {
  const successful = createIntegratedEditor(t);
  let finish!: () => void;
  let successfulRenders = 0;
  const selection = new ComposerSelectionController();
  selection.attach(successful.editor, {
    copy: () => new Promise<void>((resolve) => { finish = resolve; }),
    requestRender: () => { successfulRenders += 1; },
  });
  successful.editor.setText("cut after copy completes");
  send(successful.tui, SELECT_ALL);
  send(successful.tui, CUT);
  assert.equal(successful.editor.getText(), "cut after copy completes");
  assert.equal(successfulRenders, 0);
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(successful.editor.getText(), "");
  assert.equal(successfulRenders, 1);
  selection.dispose();
});
