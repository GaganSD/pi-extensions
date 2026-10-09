import assert from "node:assert/strict";
import test from "node:test";
import { getKeybindings, setKeybindings, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { BoundaryEditor } from "../src/navigation.ts";

test("plain Pi navigation respects real wrapped movement, end-of-line movement and history before handoff", () => {
  const tui = { terminal: { rows: 24, columns: 80 }, requestRender() {} } as unknown as TUI;
  const editor = new BoundaryEditor(tui, { borderColor: (text: string) => text } as EditorTheme, new KeybindingsManager());
  editor.focused = true; let exits = 0; editor.onDownBoundary = () => exits++;
  editor.setText("hello"); editor.handleInput("\x1b[D"); editor.handleInput("\x1b[B");
  assert.equal(exits, 0, "first Down still performs native end-of-line navigation");
  editor.handleInput("\x1b[B"); assert.equal(exits, 1);
  editor.setText("long line ".repeat(20)); editor.render(20); editor.handleInput("\x1b[A");
  editor.handleInput("\x1b[B"); assert.equal(exits, 1);
  editor.handleInput("\x1b[B"); assert.equal(exits, 2);
  editor.addToHistory("history"); editor.setText(""); editor.handleInput("\x1b[A"); editor.handleInput("\x1b[B");
  assert.equal(editor.getText(), ""); assert.equal(exits, 2);
  editor.isShowingAutocomplete = () => true; editor.handleInput("\x1b[B"); assert.equal(exits, 2);
  editor.focused = false; editor.handleInput("\x1b[B"); assert.equal(exits, 2);
});

test("configured cursorDown remaps handoff once and leaves physical Down inert", t => {
  const previous = getKeybindings();
  const keys = new KeybindingsManager({ "tui.editor.cursorDown": "ctrl+n" });
  setKeybindings(keys);
  t.after(() => setKeybindings(previous));
  const tui = { terminal: { rows: 24, columns: 80 }, requestRender() {} } as unknown as TUI;
  const editor = new BoundaryEditor(tui, { borderColor: (text: string) => text } as EditorTheme, keys);
  editor.focused = true; let exits = 0; editor.onDownBoundary = () => exits++;
  editor.setText("first\nsecond"); editor.handleInput("\x1b[A");
  editor.handleInput("\x0e"); assert.equal(exits, 0, "native movement gets first refusal");
  editor.handleInput("\x0e"); assert.equal(exits, 1, "remapped boundary hands off once");
  editor.addToHistory("history"); editor.setText(""); editor.handleInput("\x1b[A"); editor.handleInput("\x0e");
  assert.equal(editor.getText(), ""); assert.equal(exits, 1, "history consumes the remapped key");
  editor.isShowingAutocomplete = () => true; editor.handleInput("\x0e"); assert.equal(exits, 1);
  editor.isShowingAutocomplete = () => false;
  editor.setText("boundary");
  editor.handleInput("\x1b[B"); assert.equal(exits, 1, "physical Down must not hand off when unbound");
});
