import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import {
  Editor,
  getKeybindings,
  setKeybindings,
  type AutocompleteProvider,
  type EditorTheme,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { TuiBase } from "../node_modules/@earendil-works/pi-tui/dist/tui.js";
import { ImagePeek } from "../extensions/pi-slate/image-peek.ts";
import {
  ComposerSelectionController,
  type ComposerSelectionEditor,
} from "../extensions/pi-slate/composer-selection.ts";

class FakeEditor implements ComposerSelectionEditor {
  text: string;
  expandedText?: string;
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
  imagePath?: (number: string) => string | undefined,
): ComposerSelectionController {
  const selection = new ComposerSelectionController(now);
  selection.attach(editor, { copy, imagePath });
  return selection;
}

const SELECT_ALL = "\x1b[97;9u";

test("Kitty super+a selects all without inserting a", () => {
  const editor = new FakeEditor("hello");
  editor.renderedLines = ["TOP", "hello", "BOTTOM"];
  attach(editor);

  editor.handleInput(SELECT_ALL);

  assert.equal(editor.getText(), "hello");
  assert.deepEqual(editor.inputCalls, []);
  assert.match(editor.render(20)[1]!, /\x1b\[7mhello\x1b\[27m/);
});

test("ctrl+a remains an editor key and is not intercepted", () => {
  const editor = new FakeEditor("hello");
  attach(editor);
  editor.handleInput(SELECT_ALL);

  editor.handleInput("\x01");

  assert.deepEqual(editor.inputCalls, ["\x01"]);
  assert.deepEqual(editor.setTextCalls, []);
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

test("ctrl+shift+a selects all and super+c copies expanded text", () => {
  const editor = new FakeEditor("[paste #1]");
  editor.expandedText = "full pasted text";
  const copied: string[] = [];
  attach(editor, (text) => copied.push(text));

  editor.handleInput("\x1b[97;6u");
  editor.handleInput("\x1b[99;9u");

  assert.deepEqual(copied, ["full pasted text"]);
  assert.deepEqual(editor.inputCalls, []);
  assert.equal(editor.getText(), "[paste #1]");
});

test("ctrl+c copies expanded selected text without calling the editor", () => {
  const editor = new FakeEditor("[paste #1]");
  editor.expandedText = "full pasted text";
  const copied: string[] = [];
  attach(editor, (text) => copied.push(text));
  editor.handleInput(SELECT_ALL);

  editor.handleInput("\x03");

  assert.deepEqual(copied, ["full pasted text"]);
  assert.deepEqual(editor.inputCalls, []);
  assert.equal(editor.getText(), "[paste #1]");
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

test("mouse input disarms the Escape clear gesture", () => {
  let time = 4_000;
  const editor = new FakeEditor("hello");
  attach(editor, () => {}, () => time);
  editor.handleInput("\x1b");
  time += 10;
  editor.handleMouse({} as TuiMouseEvent);
  editor.handleInput("\x1b");
  assert.equal(editor.getText(), "hello");
  assert.deepEqual(editor.inputCalls, ["\x1b", "\x1b"]);
});

test("an Escape that changes the text does not arm clear", () => {
  let time = 2_000;
  const editor = new FakeEditor("hello");
  editor.onInput = (data, target) => {
    if (data === "\x1b") target.setText("");
  };
  attach(editor, () => {}, () => time);

  editor.handleInput("\x1b");
  time += 100;
  editor.handleInput("\x1b");

  assert.deepEqual(editor.inputCalls, ["\x1b", "\x1b"]);
  assert.deepEqual(editor.setTextCalls, ["", ""]);
});

test("Escape passes through every time for an empty editor", () => {
  let time = 3_000;
  const editor = new FakeEditor("");
  attach(editor, () => {}, () => time);

  editor.handleInput("\x1b");
  time += 100;
  editor.handleInput("\x1b");

  assert.deepEqual(editor.inputCalls, ["\x1b", "\x1b"]);
  assert.deepEqual(editor.setTextCalls, []);
});

test("an outer wrapper still forwards select-all into the selection controller", () => {
  const editor = new FakeEditor("hello");
  const selection = new ComposerSelectionController();
  selection.attach(editor, { copy() {} });
  const selectedHandleInput = editor.handleInput;
  const outerCalls: string[] = [];
  editor.handleInput = (data: string): void => {
    outerCalls.push(`outer:${data}`);
    selectedHandleInput.call(editor, data);
  };

  editor.handleInput(SELECT_ALL);
  assert.deepEqual(outerCalls, [`outer:${SELECT_ALL}`]);
  assert.match(editor.render(20)[1]!, /\x1b\[7m/);
  selection.dispose();
});

test("selected rendering leaves borders and padding-only rows unchanged", () => {
  const editor = new FakeEditor("hello world");
  editor.renderedLines = [
    "TOP BORDER",
    "  hello\x1b[0m world  ",
    "    ",
    "BOTTOM BORDER",
  ];
  attach(editor);
  editor.handleInput(SELECT_ALL);

  const lines = editor.render(30);

  assert.equal(lines[0], "TOP BORDER");
  assert.equal(lines[3], "BOTTOM BORDER");
  assert.equal(lines[2], "    ");
  assert.equal(lines[1], "  \x1b[7mhello\x1b[0m\x1b[7m world\x1b[27m  ");
});

test("selected rendering skips invert while autocomplete is open", () => {
  const editor = new FakeEditor("/help");
  editor.autocomplete = true;
  editor.renderedLines = ["TOP", "/help", "BOTTOM", "  help"];
  attach(editor);
  editor.handleInput(SELECT_ALL);

  assert.deepEqual(editor.render(20), ["TOP", "/help", "BOTTOM", "  help"]);
});

test("dispose restores only wrappers installed by the selection controller", () => {
  const editor = new FakeEditor("hello");
  const originalInput = editor.handleInput;
  const originalMouse = editor.handleMouse;
  const selection = attach(editor);
  const laterRender = (_width: number): string[] => ["later"];
  editor.render = laterRender;

  selection.dispose();

  assert.equal(editor.handleInput, originalInput);
  assert.equal(editor.handleMouse, originalMouse);
  assert.equal(editor.render, laterRender);
});

test("unsupported private paste storage leaves repeat-paste bytes untouched", () => {
  const editor = new FakeEditor("[paste #1 +18 lines]");
  const pasted = "line\n".repeat(18);
  attach(editor);

  editor.handlePaste(pasted);

  assert.deepEqual(editor.pasteCalls, [pasted]);
  assert.equal(editor.getText(), `[paste #1 +18 lines]${pasted}`);
});

test("unsupported private image storage does not rewrite an image token", () => {
  const editor = new FakeEditor("see [image-1]");
  editor.cursor = { line: 0, col: 13 };
  attach(editor, () => {}, Date.now, (number) => number === "1" ? "/tmp/shot.png" : undefined);

  editor.handleInput("\x1b[118;9u");

  assert.equal(editor.getText(), "see [image-1]");
  assert.deepEqual(editor.inputCalls, ["\x1b[118;9u"]);
});

test("paste away from a collapsed token still inserts", () => {
  const editor = new FakeEditor("hello [paste #1 +18 lines]");
  editor.expandedText = "hello hidden paste body";
  editor.cursor = { line: 0, col: 1 };
  attach(editor);

  editor.handlePaste("more");

  assert.deepEqual(editor.pasteCalls, ["more"]);
  assert.equal(editor.getText(), "hello [paste #1 +18 lines]more");
});

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

test("a second large paste on the real editor expands the collapse marker", () => {
  const editor = new Editor({
    terminal: { rows: 24, columns: 80 },
    requestRender() {},
  } as TUI, { borderColor: (text) => text } as EditorTheme);
  const selection = new ComposerSelectionController();
  selection.attach(editor, { copy() {} });
  const pasted = Array.from({ length: 18 }, (_, index) => `line ${index + 1}`).join("\n");
  editor.handleInput(`\x1b[200~${pasted}\x1b[201~`);
  assert.match(editor.getText(), /\[paste #1 \+18 lines\]/);
  editor.handleInput(`\x1b[200~${pasted}\x1b[201~`);
  assert.equal(editor.getText(), pasted);
  selection.dispose();
});

const bindingsByTest = new WeakMap<TestContext, { previous: ReturnType<typeof getKeybindings>; current: KeybindingsManager }>();

function createIntegratedEditor(t: TestContext): { editor: CustomEditor; tui: TuiBase; keybindings: KeybindingsManager } {
  let bindings = bindingsByTest.get(t);
  if (!bindings) {
    const previous = getKeybindings();
    const current = new KeybindingsManager();
    bindings = { previous, current };
    bindingsByTest.set(t, bindings);
    setKeybindings(current);
    t.after(() => setKeybindings(previous));
  }
  const keybindings = bindings.current;
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
  const editor = new CustomEditor(tui as unknown as TUI, theme, keybindings);
  tui.setFocus(editor);
  return { editor, tui, keybindings };
}

function send(tui: TuiBase, data: string): void {
  (tui as unknown as { handleTerminalInput(data: string): void }).handleTerminalInput(data);
}

function moveTo(editor: CustomEditor, column: number): void {
  editor.handleInput("\x01");
  for (let index = 0; index < column; index += 1) editor.handleInput("\x1b[C");
}

function setCursor(editor: CustomEditor, column: number): void {
  const state = (editor as unknown as { state: { cursorLine: number; cursorCol: number } }).state;
  state.cursorLine = 0;
  state.cursorCol = column;
}

function bracketedPaste(tui: TuiBase, text: string, splitAt?: number): void {
  if (splitAt === undefined) send(tui, `\x1b[200~${text}\x1b[201~`);
  else {
    send(tui, `\x1b[200~${text.slice(0, splitAt)}`);
    send(tui, `${text.slice(splitAt)}\x1b[201~`);
  }
}

const largePaste = (label: string): string => Array.from({ length: 12 }, (_, index) => `${label} ${index + 1}`).join("\n");
const F4 = "\x1b[14~";
const KITTY_CTRL_D = "\x1b[100;5u";

for (const key of ["\x04", KITTY_CTRL_D]) {
  test(`focused TUI preserves native Ctrl+D behavior (${JSON.stringify(key)})`, (t) => {
    for (const cursor of [0, 2, 5]) {
      const native = createIntegratedEditor(t);
      native.editor.setText("hello");
      moveTo(native.editor, cursor);
      send(native.tui, key);
      const nativeText = native.editor.getText();

      for (const selected of [false, true]) {
        const { editor, tui } = createIntegratedEditor(t);
        const selection = new ComposerSelectionController();
        selection.attach(editor, { copy() {} });
        editor.setText("hello");
        moveTo(editor, cursor);
        if (selected) send(tui, SELECT_ALL);
        send(tui, key);
        assert.equal(editor.getText(), nativeText, `native comparison at cursor ${cursor}, selected ${selected}`);
        selection.dispose();
      }
    }
    const nativeEmpty = createIntegratedEditor(t);
    let nativeExits = 0;
    nativeEmpty.editor.onCtrlD = () => { nativeExits += 1; };
    send(nativeEmpty.tui, key);

    const { editor, tui } = createIntegratedEditor(t);
    let exits = 0;
    editor.onCtrlD = () => { exits += 1; };
    const selection = new ComposerSelectionController();
    selection.attach(editor, { copy() {} });
    send(tui, key);
    assert.equal(exits, nativeExits);
    assert.equal(exits, 1);
    selection.dispose();
  });
}

test("selected Ctrl+C copies while unselected Ctrl+C keeps Pi clear behavior", async (t) => {
  const { editor, tui } = createIntegratedEditor(t);
  const copied: string[] = [];
  let clears = 0;
  editor.onAction("app.clear", () => { clears += 1; });
  const selection = new ComposerSelectionController();
  selection.attach(editor, { copy: (text) => { copied.push(text); } });
  editor.setText("prompt");
  send(tui, "\x03");
  assert.equal(clears, 1);
  send(tui, SELECT_ALL);
  send(tui, "\x03");
  await Promise.resolve();
  assert.deepEqual(copied, ["prompt"]);
  assert.equal(clears, 1);
  assert.equal(editor.getText(), "prompt");
  selection.dispose();
});

test("focused TUI filters Ctrl+D releases and leaves Ctrl+C/Ctrl+X app actions intact", (t) => {
  const { editor, tui } = createIntegratedEditor(t);
  let exits = 0;
  let clears = 0;
  let messageCopies = 0;
  editor.onCtrlD = () => { exits += 1; };
  editor.onAction("app.clear", () => { clears += 1; });
  editor.onAction("app.message.copy", () => { messageCopies += 1; });
  const selection = new ComposerSelectionController();
  selection.attach(editor, { copy() {} });
  editor.setText("hello");
  send(tui, SELECT_ALL);
  send(tui, "\x1b[100;5:3u");
  assert.equal(editor.getText(), "hello");
  assert.equal(exits, 0);
  send(tui, "\x18");
  assert.equal(editor.getText(), "hello");
  assert.equal(messageCopies, 1);
  assert.equal(clears, 0);
  selection.dispose();
});

test("selection copy/cut key encodings preserve native shortcuts and only cut on success", async (t) => {
  for (const [key, kind] of [["\x1b[99;6u", "copy"], ["\x1b[120;9u", "cut"], ["\x1b[120;6u", "cut"]] as const) {
    const { editor, tui } = createIntegratedEditor(t);
    const copied: string[] = [];
    let messageCopies = 0;
    editor.onAction("app.message.copy", () => { messageCopies += 1; });
    const selection = new ComposerSelectionController();
    selection.attach(editor, { copy: (text) => { copied.push(text); } });
    editor.setText("multi\n  🙂 prompt  ");
    send(tui, SELECT_ALL);
    send(tui, key);
    await Promise.resolve();
    assert.deepEqual(copied, ["multi\n  🙂 prompt  "]);
    assert.equal(editor.getText(), kind === "cut" ? "" : "multi\n  🙂 prompt  ");
    assert.equal(messageCopies, 0);
    selection.dispose();
  }

  const { editor, tui } = createIntegratedEditor(t);
  const copied: string[] = [];
  let messageCopies = 0;
  editor.onAction("app.message.copy", () => { messageCopies += 1; });
  const selection = new ComposerSelectionController();
  selection.attach(editor, { copy: (text) => { copied.push(text); } });
  editor.setText("keep");
  send(tui, SELECT_ALL);
  send(tui, "\x18");
  assert.deepEqual(copied, []);
  assert.equal(editor.getText(), "keep");
  assert.equal(messageCopies, 1);
  selection.dispose();
});

test("Pi-decoded printable keys replace select-all, while modified app keys remain distinct", (t) => {
  for (const [key, replacement] of [["\x1b[120u", "x"], ["\x1b[27;1;120~", "x"], ["\x1b[32;2u", " "]] as const) {
    const { editor, tui } = createIntegratedEditor(t);
    const selection = new ComposerSelectionController();
    selection.attach(editor, { copy() {} });
    editor.setText("old");
    send(tui, SELECT_ALL);
    send(tui, key);
    assert.equal(editor.getText(), replacement, JSON.stringify(key));
    selection.dispose();
  }
});

test("selected multiline whitespace/Unicode is copied, replaced, or deleted locally", async (t) => {
  const { editor, tui } = createIntegratedEditor(t);
  const copied: string[] = [];
  const selection = new ComposerSelectionController();
  selection.attach(editor, { copy: (text) => { copied.push(text); } });
  editor.setText("  whitespace \n猫🙂  ");
  send(tui, SELECT_ALL);
  send(tui, "\x1b[99;9u");
  await Promise.resolve();
  assert.deepEqual(copied, ["  whitespace \n猫🙂  "]);
  editor.setText("  whitespace \n猫🙂  ");
  send(tui, SELECT_ALL);
  send(tui, "🪴");
  assert.equal(editor.getText(), "🪴");
  editor.setText("  \n  ");
  send(tui, SELECT_ALL);
  send(tui, "\x7f");
  assert.equal(editor.getText(), "");
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
  send(successful.tui, "\x1b[120;9u");
  assert.equal(successful.editor.getText(), "cut after copy completes");
  assert.equal(successfulRenders, 0);
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(successful.editor.getText(), "");
  assert.equal(successfulRenders, 1);
  selection.dispose();

  const { editor, tui } = createIntegratedEditor(t);
  const errors: unknown[] = [];
  let failureRenders = 0;
  const failedSelection = new ComposerSelectionController();
  failedSelection.attach(editor, {
    copy: () => Promise.reject(new Error("clipboard unavailable")),
    requestRender: () => { failureRenders += 1; },
    onCopyError: (error) => errors.push(error),
  });
  editor.setText("whitespace \n🙂");
  send(tui, SELECT_ALL);
  send(tui, "\x1b[120;9u");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(editor.getText(), "whitespace \n🙂");
  assert.equal(errors.length, 1);
  assert.equal(failureRenders, 0);
  failedSelection.dispose();

  const second = new ComposerSelectionController();
  const late = createIntegratedEditor(t);
  let finishLate!: () => void;
  let lateRenders = 0;
  second.attach(late.editor, {
    copy: () => new Promise<void>((resolve) => { finishLate = resolve; }),
    requestRender: () => { lateRenders += 1; },
  });
  late.editor.setText("old draft");
  send(late.tui, SELECT_ALL);
  send(late.tui, "\x1b[120;9u");
  late.editor.setText("new draft");
  finishLate();
  await Promise.resolve();
  assert.equal(late.editor.getText(), "new draft");
  assert.equal(lateRenders, 0);
  second.dispose();
});

test("Pi clipboard shortcuts, Cmd+V payloads, and bracketed paste route correctly", (t) => {
  const { editor, tui, keybindings } = createIntegratedEditor(t);
  keybindings.setUserBindings({ "app.clipboard.pasteImage": ["ctrl+v", "alt+v"] });
  let clipboardReads = 0;
  let clipboardPayload = "clipboard payload";
  editor.onPasteImage = () => {
    clipboardReads += 1;
    editor.insertTextAtCursor(clipboardPayload);
  };
  const selection = new ComposerSelectionController();
  selection.attach(editor, { copy() {} });
  editor.setText("existing");
  send(tui, "\x16");
  assert.equal(clipboardReads, 1);
  assert.equal(editor.getText(), "existingclipboard payload");
  send(tui, "\x1b[118;3u");
  assert.equal(clipboardReads, 2);
  assert.equal(editor.getText(), "existingclipboard payloadclipboard payload");

  editor.setText("replace this");
  send(tui, SELECT_ALL);
  send(tui, "\x1b[118;3u");
  assert.equal(clipboardReads, 3);
  assert.equal(editor.getText(), "clipboard payload");

  const matchingBody = largePaste("CmdV matching");
  editor.setText("");
  bracketedPaste(tui, matchingBody);
  clipboardPayload = matchingBody;
  send(tui, "\x1b[118;9u");
  assert.equal(clipboardReads, 4);
  assert.equal(editor.getText(), matchingBody);

  const differentBody = largePaste("CmdV stored");
  editor.setText("");
  bracketedPaste(tui, differentBody);
  const marker = editor.getText();
  clipboardPayload = "different clipboard content";
  send(tui, "\x1b[118;9u");
  assert.equal(clipboardReads, 5);
  assert.equal(editor.getText(), `${marker}different clipboard content`);
  assert.equal(editor.getExpandedText(), `${differentBody}different clipboard content`);

  editor.setText("replace bracketed");
  send(tui, SELECT_ALL);
  clipboardPayload = "CmdV replaces selection";
  send(tui, "\x1b[118;9u");
  assert.equal(clipboardReads, 6);
  assert.equal(editor.getText(), "CmdV replaces selection");

  editor.setText("replace bracketed");
  send(tui, SELECT_ALL);
  bracketedPaste(tui, "bracketed payload");
  assert.equal(editor.getText(), "bracketed payload");
  selection.dispose();
});

test("native line movement, undo, Enter, Shift+Enter, and global debug still route", (t) => {
  const { editor, tui } = createIntegratedEditor(t);
  const selection = new ComposerSelectionController();
  selection.attach(editor, { copy() {} });
  editor.setText("hello");
  send(tui, F4);
  assert.equal(editor.getText(), "hello");
  send(tui, SELECT_ALL);
  send(tui, "\x01");
  assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
  send(tui, "\x05");
  assert.deepEqual(editor.getCursor(), { line: 0, col: 5 });
  send(tui, SELECT_ALL);
  send(tui, "\x7f");
  send(tui, "\x1f");
  assert.equal(editor.getText(), "hello");
  const submitted: string[] = [];
  editor.onSubmit = (text) => submitted.push(text);
  send(tui, SELECT_ALL);
  send(tui, "\r");
  assert.deepEqual(submitted, ["hello"]);
  editor.setText("hello");
  send(tui, SELECT_ALL);
  send(tui, "\x1b[13;2u");
  assert.equal(editor.getText(), "\n");
  let debug = 0;
  tui.onDebug = () => { debug += 1; };
  send(tui, "\x1b[100;6u");
  assert.equal(debug, 1);
  selection.dispose();
});

test("Escape press/repeat/release and a deliberate second press are distinguished", (t) => {
  const { editor, tui } = createIntegratedEditor(t);
  let interrupts = 0;
  editor.onEscape = () => { interrupts += 1; };
  const selection = new ComposerSelectionController(() => 1000);
  selection.attach(editor, { copy() {} });
  editor.setText(" ");
  send(tui, "\x1b");
  send(tui, "\x1b[27;1:2u");
  assert.equal(editor.getText(), " ");
  assert.equal(interrupts, 2);
  send(tui, "\x1b[27;1:3u");
  assert.equal(editor.getText(), " ");
  send(tui, "\x1b");
  assert.equal(editor.getText(), "");
  assert.equal(interrupts, 2);
  selection.dispose();
});

test("focus, setText, history, and submit invalidate stale all-selection state", (t) => {
  const { editor, tui } = createIntegratedEditor(t);
  const selection = new ComposerSelectionController();
  selection.attach(editor, { copy() {} });
  editor.setText("hello");
  send(tui, SELECT_ALL);
  const overlay = { focused: false, render: () => [], handleInput() {}, invalidate() {} };
  tui.setFocus(overlay);
  tui.setFocus(editor);
  send(tui, "x");
  assert.equal(editor.getText(), "hellox");

  editor.setText("old draft");
  send(tui, "\x01");
  editor.addToHistory("previous");
  send(tui, SELECT_ALL);
  send(tui, "\x1b[A");
  assert.equal(editor.getText(), "previous");

  editor.setText("submitted");
  send(tui, SELECT_ALL);
  send(tui, "\r");
  editor.setText("new draft");
  send(tui, "!");
  assert.equal(editor.getText(), "new draft!");
  selection.dispose();
});

test("repeated CRLF-tab pastes compare Pi-normalized payloads and retain different content", (t) => {
  const { editor, tui } = createIntegratedEditor(t);
  const selection = new ComposerSelectionController();
  selection.attach(editor, { copy() {} });
  const raw = Array.from({ length: 12 }, (_, index) => `line\t${index + 1}`).join("\r\n");
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\t/g, "    ");

  bracketedPaste(tui, raw);
  assert.match(editor.getText(), /^\[paste #\d+ \+12 lines\]$/);
  bracketedPaste(tui, raw);
  assert.equal(editor.getText(), normalized);
  assert.equal(editor.getExpandedText(), normalized);

  editor.setText("");
  bracketedPaste(tui, raw);
  const different = raw.replace("line\t6", "different\t6");
  bracketedPaste(tui, different);
  assert.match(editor.getText(), /^\[paste #\d+ \+12 lines\]\[paste #\d+ \+12 lines\]$/);
  assert.equal(editor.getExpandedText(), `${normalized}${different.replace(/\r\n/g, "\n").replace(/\t/g, "    ")}`);

  editor.setText("");
  bracketedPaste(tui, raw);
  editor.insertTextAtCursor(raw);
  assert.equal(editor.getText(), normalized);

  editor.setText("");
  bracketedPaste(tui, raw);
  const marker = editor.getText();
  editor.insertTextAtCursor(different);
  const differentNormalized = different.replace(/\r\n/g, "\n").replace(/\t/g, "    ");
  assert.equal(editor.getText(), `${marker}${differentNormalized}`);
  assert.equal(editor.getExpandedText(), `${normalized}${differentNormalized}`);
  selection.dispose();
});

test("split bracketed matching paste expands in place, different data inserts, and undo restores bodies", (t) => {
  const { editor, tui } = createIntegratedEditor(t);
  const selection = new ComposerSelectionController();
  selection.attach(editor, { copy() {} });
  const first = largePaste("first");
  const second = largePaste("second");
  editor.setText("left right");
  moveTo(editor, 5);
  bracketedPaste(tui, first, 17);
  const firstMarker = editor.getText().match(/\[paste #1[^\]]+\]/)?.[0];
  assert.ok(firstMarker);
  bracketedPaste(tui, first, 21);
  assert.equal(editor.getText(), `left ${first}right`);
  assert.deepEqual(editor.getCursor(), { line: 11, col: "first 12".length });
  send(tui, "\x1f");
  assert.equal(editor.getText(), `left ${firstMarker}right`);
  assert.equal(editor.getExpandedText(), `left ${first}right`);

  editor.setText("left ");
  bracketedPaste(tui, second);
  const marker = editor.getText();
  bracketedPaste(tui, "different bytes");
  assert.equal(editor.getText(), `${marker}different bytes`);
  assert.equal(editor.getExpandedText(), `left ${second}different bytes`);
  selection.dispose();
});

test("F4 expands a middle token without losing sibling paste bodies, image tokens, caret, or undo", (t) => {
  const { editor, tui } = createIntegratedEditor(t);
  const first = largePaste("alpha");
  const second = largePaste("beta");
  const selection = new ComposerSelectionController();
  selection.attach(editor, { copy() {}, imagePath: (number) => number === "1" ? "/tmp/photo.png" : undefined });
  editor.setText("left ");
  bracketedPaste(tui, first);
  editor.insertTextAtCursor(" middle ");
  bracketedPaste(tui, second);
  editor.insertTextAtCursor(" end [image-1]");
  const marker1 = editor.getText().match(/\[paste #1[^\]]+\]/)?.[0];
  const marker2 = editor.getText().match(/\[paste #2[^\]]+\]/)?.[0];
  assert.ok(marker1 && marker2);
  setCursor(editor, editor.getText().indexOf(marker2) + 3);
  send(tui, F4);
  assert.equal(editor.getText(), `left ${marker1} middle ${second} end [image-1]`);
  assert.equal(editor.getExpandedText(), `left ${first} middle ${second} end [image-1]`);
  assert.deepEqual(editor.getCursor(), { line: 11, col: "beta 12".length });
  const internals = editor as unknown as { pastes: Map<number, string>; pasteCounter: number };
  assert.deepEqual([...internals.pastes.keys()], [1]);
  bracketedPaste(tui, largePaste("gamma"));
  assert.match(editor.getText(), /\[paste #3/);
  assert.deepEqual([...internals.pastes.keys()], [1, 3]);
  send(tui, "\x1f");
  assert.deepEqual([...internals.pastes.keys()], [1]);
  send(tui, "\x1f");
  assert.equal(editor.getText().includes(marker2), true);
  assert.equal(editor.getExpandedText(), `left ${first} middle ${second} end [image-1]`);
  selection.dispose();
});

test("expanding one duplicate paste marker retains the shared body for its sibling", (t) => {
  const { editor, tui } = createIntegratedEditor(t);
  const body = "x".repeat(1001);
  const selection = new ComposerSelectionController();
  selection.attach(editor, { copy() {} });
  bracketedPaste(tui, body);
  const marker = editor.getText();
  editor.insertTextAtCursor(` sibling ${marker}`);
  setCursor(editor, 3);
  send(tui, F4);
  assert.equal(editor.getText(), `${body} sibling ${marker}`);
  assert.equal(editor.getExpandedText(), `${body} sibling ${body}`);
  const getPastes = (): Map<number, string> => (editor as unknown as { pastes: Map<number, string> }).pastes;
  assert.equal(getPastes().get(1), body);

  setCursor(editor, body.length + " sibling ".length + 3);
  send(tui, F4);
  assert.equal(editor.getText(), `${body} sibling ${body}`);
  assert.equal(getPastes().has(1), false);
  selection.dispose();
});

test("Pi async insertTextAtCursor expands only matching clipboard data and replaces selected prompt", (t) => {
  const { editor, tui } = createIntegratedEditor(t);
  const pasted = largePaste("clipboard");
  const selection = new ComposerSelectionController();
  selection.attach(editor, { copy() {} });
  bracketedPaste(tui, pasted);
  assert.match(editor.getText(), /^\[paste #1/);
  editor.insertTextAtCursor(pasted);
  assert.equal(editor.getText(), pasted);
  editor.setText("prefix ");
  bracketedPaste(tui, largePaste("different"));
  const marker = editor.getText();
  editor.insertTextAtCursor("unrelated clipboard data");
  assert.equal(editor.getText(), `${marker}unrelated clipboard data`);
  assert.equal(editor.getExpandedText(), `prefix ${largePaste("different")}unrelated clipboard data`);
  editor.setText("old prompt");
  editor.handleInput(SELECT_ALL);
  editor.insertTextAtCursor("replacement");
  assert.equal(editor.getText(), "replacement");
  selection.dispose();
});

test("Tab/autocomplete and Shift+Tab thinking actions remain available around selection", async (t) => {
  const { editor, tui } = createIntegratedEditor(t);
  let suggestions = 0;
  let completions = 0;
  let thinkingCycles = 0;
  const provider: AutocompleteProvider = {
    async getSuggestions() {
      suggestions += 1;
      return { items: [
        { value: "@alice", label: "@alice" },
        { value: "@bob", label: "@bob" },
      ], prefix: "@" };
    },
    applyCompletion() {
      completions += 1;
      return { lines: ["@alice"], cursorLine: 0, cursorCol: 6 };
    },
  };
  editor.setAutocompleteProvider(provider);
  editor.onAction("app.thinking.cycle", () => { thinkingCycles += 1; });
  const nativeRender = editor.render;
  const selection = new ComposerSelectionController();
  selection.attach(editor, { copy() {} });
  editor.setText("@");
  send(tui, "\t");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(suggestions > 0, true);
  assert.equal(editor.isShowingAutocomplete(), true);
  send(tui, SELECT_ALL);
  assert.deepEqual(editor.render(40), nativeRender.call(editor, 40));
  send(tui, "\t");
  assert.equal(completions, 1);
  assert.equal(editor.getText(), "@alice");

  editor.setText("prompt");
  send(tui, SELECT_ALL);
  send(tui, "\x1b[Z");
  assert.equal(thinkingCycles, 1);
  assert.equal(editor.getText(), "prompt");
  selection.dispose();
});

test("attaching a replacement editor restores wrappers on the previous instance", (t) => {
  const first = createIntegratedEditor(t);
  const second = createIntegratedEditor(t);
  const selection = new ComposerSelectionController();
  const originalInput = first.editor.handleInput;
  selection.attach(first.editor, { copy() {} });
  selection.attach(second.editor, { copy() {} });
  assert.equal(first.editor.handleInput, originalInput);
  second.editor.setText("new prompt");
  send(second.tui, SELECT_ALL);
  assert.match(second.editor.render(40)[1]!, /\x1b\[7m/);
  selection.dispose();
});

test("outer ImagePeek refreshes after token expansion and wrappers dispose in reverse order", (t) => {
  const { editor, tui } = createIntegratedEditor(t);
  const preview = { current: undefined as { id: string } | undefined };
  const theme = { fg: (_tone: string, text: string) => text };
  const workspace = {
    currentViewId: () => preview.current?.id,
    setView: (view: { id: string } | undefined) => { preview.current = view; },
    requireTheme: () => theme,
  };
  const imagePath = "/tmp/pi-slate-peek-test.png";
  let peek!: ImagePeek;
  const selection = new ComposerSelectionController();
  selection.attach(editor, {
    copy() {},
    imagePath: (number) => number === "1" ? imagePath : undefined,
    matchesImage: (number, path) => number === "1" && path === imagePath,
    onTokenExpansion: () => peek.update(),
  });
  const selectedInput = editor.handleInput;
  const store = new Map([["1", imagePath]]);
  peek = new ImagePeek(store, editor, workspace as never, () => ({
    type: "image", data: "", mimeType: "image/png",
  }));
  const peekInput = editor.handleInput;
  editor.setText("[image-1]");
  setCursor(editor, 4);
  peek.update();
  assert.equal(preview.current?.id, `image:1:${imagePath}`);
  send(tui, F4);
  assert.equal(editor.getText(), imagePath);
  assert.equal(preview.current, undefined);
  editor.setText("[image-1]");
  setCursor(editor, 4);
  peek.update();
  editor.insertTextAtCursor(imagePath);
  assert.equal(editor.getText(), imagePath);
  assert.equal(preview.current, undefined);

  peek.dispose();
  assert.equal(editor.handleInput, selectedInput);
  selection.dispose();
  assert.notEqual(editor.handleInput, peekInput);
});

test("image expansion preserves paste metadata and compares incoming image payload", (t) => {
  const { editor, tui } = createIntegratedEditor(t);
  const pasted = largePaste("body");
  const selection = new ComposerSelectionController();
  selection.attach(editor, {
    copy() {},
    imagePath: () => "/tmp/stored.png",
    matchesImage: (number, path) => number === "1" && path === "/tmp/same-bytes.png",
  });
  bracketedPaste(tui, pasted);
  editor.insertTextAtCursor(" [image-1]");
  const originalText = editor.getText();
  const pasteMarker = originalText.match(/\[paste #1[^\]]+\]/)?.[0];
  assert.ok(pasteMarker);
  setCursor(editor, editor.getText().indexOf("[image-1]") + 4);
  editor.insertTextAtCursor("/tmp/different.png");
  assert.equal(editor.getText().includes("/tmp/different.png"), true);
  editor.handleInput("\x1f");
  assert.equal(editor.getText(), originalText);
  setCursor(editor, editor.getText().indexOf("[image-1]") + 4);
  editor.insertTextAtCursor("/tmp/same-bytes.png");
  assert.equal(editor.getText(), `${pasteMarker} /tmp/stored.png`);
  assert.equal(editor.getExpandedText(), `${pasted} /tmp/stored.png`);
  assert.deepEqual([...(editor as unknown as { pastes: Map<number, string> }).pastes.values()], [pasted]);
  selection.dispose();
});
