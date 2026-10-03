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
  pastes = new Map<number, string>();
  setTextCalls: string[] = [];
  inputCalls: string[] = [];
  pasteCalls: string[] = [];
  insertCalls: string[] = [];
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

  getExpandedText(): string {
    let result = this.text;
    for (const [id, body] of this.pastes) {
      result = result.replace(new RegExp(`\\[paste #${id}(?: \\+\\d+ lines| \\d+ chars)?\\]`, "g"), body);
    }
    return result;
  }

  setText(text: string): void {
    this.setTextCalls.push(text);
    this.text = text;
  }

  getCursor(): { line: number; col: number } {
    return this.cursor ?? { line: 0, col: this.text.length };
  }

  handlePaste = (text: string): void => {
    this.pasteCalls.push(text);
    this.text += text;
  };

  insertTextAtCursor = (text: string): void => {
    this.insertCalls.push(text);
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
  now: () => number = Date.now,
): ComposerSelectionController {
  const selection = new ComposerSelectionController(now);
  selection.attach(editor, {});
  return selection;
}

const SELECT_ALL = "\x01";

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

test("Kitty and xterm printable keys replace selection using the public TUI API", () => {
  for (const key of ["\x1b[120u", "\x1b[27;1;120~", "\x1b[27;2;88~", "\x1b[27;65;120~", "\x1b[27;1;128512~"]) {
    const editor = new FakeEditor("replace me");
    const selection = attach(editor);
    editor.handleInput(SELECT_ALL);
    editor.handleInput(key);
    assert.deepEqual(editor.setTextCalls, [""], JSON.stringify(key));
    assert.deepEqual(editor.inputCalls, [key]);
    selection.dispose();
  }
  for (const key of ["\x1b[27;5;120~", "\x1b[27;3;120~", "\x1b[27;9;120~"]) {
    const editor = new FakeEditor("keep me");
    const selection = attach(editor);
    editor.handleInput(SELECT_ALL);
    editor.handleInput(key);
    assert.deepEqual(editor.setTextCalls, [], JSON.stringify(key));
    assert.equal(editor.getText(), "keep me");
    selection.dispose();
  }
});

test("Ctrl+C and Ctrl+X pass through to Pi", () => {
  const editor = new FakeEditor("hello");
  attach(editor);
  editor.handleInput("\x03");
  editor.handleInput("\x18");
  assert.deepEqual(editor.inputCalls, ["\x03", "\x18"]);
  assert.equal(editor.getText(), "hello");
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

test("a first unchanged Escape passes through and a second within 500ms clears", () => {
  let time = 1_000;
  const editor = new FakeEditor("hello");
  attach(editor, () => time);

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
  assert.equal(editor.pastes.get(1), "one\ntwo");
  assert.equal(editor.pastes.get(2), "keep");

  editor.handleMouse({ type: "click", button: "left" } as TuiMouseEvent);
  assert.equal(editor.getText(), "see [paste #1 +10 lines] and [paste #2 +5 lines]");
  assert.equal(editor.pastes.get(1), "one\ntwo");
});

test("clicking away from a paste token does not expand", () => {
  const editor = new FakeEditor("see [paste #1 +10 lines]");
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

test("select-all then Enter submits the prompt instead of erasing it", () => {
  const submitted: string[] = [];
  const editor = new Editor({
    terminal: { rows: 24, columns: 80 },
    requestRender() {},
  } as TUI, { borderColor: (text) => text } as EditorTheme);
  editor.onSubmit = (text) => submitted.push(text);
  const selection = new ComposerSelectionController();
  selection.attach(editor, {});
  editor.setText("keep this prompt");
  editor.handleInput(SELECT_ALL);
  editor.handleInput("\r");
  assert.deepEqual(submitted, ["keep this prompt"]);
  selection.dispose();
});

test("large insertTextAtCursor stays collapsed as a paste token", async (t) => {
  const { editor } = createIntegratedEditor(t);
  const selection = new ComposerSelectionController();
  selection.attach(editor, {});
  const pasted = `${"stack trace line\n".repeat(20)}end`;
  editor.insertTextAtCursor(pasted);
  assert.match(editor.getText(), /^\[paste #1 /);
  assert.notEqual(editor.getText(), pasted);
  assert.equal(editor.getExpandedText(), pasted);
  selection.dispose();
});

test("large insertTextAtCursor uses handlePaste instead of inserting raw text", () => {
  const editor = new FakeEditor();
  attach(editor);
  const pasted = "x".repeat(1001);
  editor.insertTextAtCursor(pasted);
  assert.deepEqual(editor.pasteCalls, [pasted]);
  assert.deepEqual(editor.insertCalls, []);
});

test("short insertTextAtCursor is not collapsed", async (t) => {
  const { editor } = createIntegratedEditor(t);
  const selection = new ComposerSelectionController();
  selection.attach(editor, {});
  editor.insertTextAtCursor("hello");
  assert.equal(editor.getText(), "hello");
  selection.dispose();
});

test("selected Ctrl+C copies the expanded prompt and leaves it in place", async () => {
  const editor = new FakeEditor("[paste #1 +2 lines]");
  editor.pastes.set(1, "line one\nline two");
  const copied: string[] = [];
  const selection = new ComposerSelectionController();
  selection.attach(editor, { copy: (text) => { copied.push(text); } });
  editor.handleInput(SELECT_ALL);
  editor.handleInput("\x03");
  await Promise.resolve();
  assert.deepEqual(copied, ["line one\nline two"]);
  assert.equal(editor.getText(), "[paste #1 +2 lines]");
  assert.deepEqual(editor.inputCalls, []);
  assert.match(editor.render(20)[1]!, /\x1b\[7m/);
  selection.dispose();
});

test("selected Ctrl+X cuts only after a successful copy", async () => {
  const editor = new FakeEditor("keep me");
  const copied: string[] = [];
  const selection = new ComposerSelectionController();
  selection.attach(editor, { copy: (text) => { copied.push(text); } });
  editor.handleInput(SELECT_ALL);
  editor.handleInput("\x18");
  await Promise.resolve();
  assert.deepEqual(copied, ["keep me"]);
  assert.deepEqual(editor.setTextCalls, [""]);
  assert.equal(editor.getText(), "");
  selection.dispose();
});

test("unselected Ctrl+C and Ctrl+X still reach Pi", () => {
  const editor = new FakeEditor("hello");
  const copied: string[] = [];
  const selection = new ComposerSelectionController();
  selection.attach(editor, { copy: (text) => { copied.push(text); } });
  editor.handleInput("\x03");
  editor.handleInput("\x18");
  assert.deepEqual(copied, []);
  assert.deepEqual(editor.inputCalls, ["\x03", "\x18"]);
  selection.dispose();
});

test("wheel over the prompt keeps select-all", () => {
  const editor = new FakeEditor("hello");
  editor.renderedLines = ["TOP", "hello", "BOTTOM"];
  attach(editor);
  editor.handleInput(SELECT_ALL);
  editor.handleMouse({ type: "wheel", button: "none", wheelDelta: -1 } as TuiMouseEvent);
  assert.match(editor.render(20)[1]!, /\x1b\[7mhello\x1b\[27m/);
});
