import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { ComposerEditor } from "../extensions/pi-slate/composer.ts";
import { installConversationBridge } from "../extensions/pi-slate/conversation-bridge.ts";
import { SidebarSplit } from "../extensions/pi-slate/sidebar-split.ts";

const theme = { fg: (_color: string, text: string) => text } as Theme;
function editorFixture() {
  let focused: Component | undefined;
  const tui = { terminal: { rows: 24, columns: 100 }, requestRender() {}, setFocus(view: Component) { focused = view; }, getFocusedComponent: () => focused ?? null } as unknown as TUI;
  const editor = new ComposerEditor(tui, { borderColor: (text: string) => text } as EditorTheme,
    new KeybindingsManager(), () => ({ project: "fixture", branch: null, model: undefined, footer: "standard", theme }));
  editor.focused = true;
  return { editor, tui, get focused() { return focused; } };
}

test("Down runs Slate editing first and transfers only at an unchanged lower navigation boundary", () => {
  const { editor } = editorFixture(); let exits = 0;
  editor.onDownBoundary = () => exits++;
  editor.setText("first\nsecond"); editor.handleInput("\x1b[A");
  editor.handleInput("\x1b[B"); assert.equal(exits, 0, "normal movement reaches lower line");
  editor.handleInput("\x1b[B"); assert.equal(exits, 1);
  editor.setText("long wrapped line ".repeat(8)); editor.render(35); editor.handleInput("\x1b[A");
  editor.handleInput("\x1b[B"); assert.equal(exits, 1, "wrapped visual movement remains editor-owned");
  editor.handleInput("\x1b[B"); assert.equal(exits, 2);
});

test("history, autocomplete and unfocused input do not hand off to the roster", () => {
  const { editor } = editorFixture(); let exits = 0;
  editor.onDownBoundary = () => exits++;
  editor.addToHistory("history entry"); editor.setText(""); editor.handleInput("\x1b[A");
  assert.equal(editor.getText(), "history entry"); editor.handleInput("\x1b[B");
  assert.equal(editor.getText(), ""); assert.equal(exits, 0);
  const showing = editor.isShowingAutocomplete.bind(editor);
  editor.isShowingAutocomplete = () => true;
  editor.handleInput("\x1b[B"); assert.equal(exits, 0);
  editor.isShowingAutocomplete = showing;
  editor.focused = false; editor.handleInput("\x1b[B"); assert.equal(exits, 0);
});

test("replacing only Slate's chat slot retains sidebar and original objects, including updates while hidden", () => {
  const main = new Text("MAIN ORIGINAL", 0, 0), sidebar = new Text("SIDEBAR RETAINED", 0, 0), worker = new Text("WORKER THREAD", 0, 0);
  const split = new SidebarSplit(main, sidebar, () => 30);
  const restore = split.replaceChat(worker);
  const thread = split.render(140).join("\n");
  assert(thread.includes("WORKER THREAD") && thread.includes("SIDEBAR RETAINED")); assert(!thread.includes("MAIN ORIGINAL"));
  assert.equal(split.chat(), main);
  main.setText("MAIN UPDATED WHILE HIDDEN"); restore();
  const parent = split.render(140).join("\n"); assert(parent.includes("MAIN UPDATED WHILE HIDDEN") && parent.includes("SIDEBAR RETAINED"));
  assert(!parent.includes("WORKER THREAD")); restore(); assert.equal(split.chat(), main);
});

test("bridge rejects incompatible and cross-session requests and releases focus/mount leases on shutdown", () => {
  const listeners = new Set<(request: unknown) => void>();
  const pi = { events: { on(_name: string, fn: (request: unknown) => void) { listeners.add(fn); return () => listeners.delete(fn); } } } as unknown as ExtensionAPI;
  const f = editorFixture(); let restored = 0, disposed = 0;
  const ctx = { mode: "tui", sessionManager: { getSessionId: () => "owner" } } as unknown as ExtensionContext;
  const bridge = installConversationBridge(pi, { context: () => ctx, editor: () => f.editor, tui: () => f.tui,
    replaceChat: () => () => { restored++; } });
  let host: { focusEditor(data?: string): void; bindDown(handler: () => void): () => void; mount(view: Component): () => void } | undefined;
  const accept = (value: unknown) => { host = value as typeof host; };
  for (const fn of listeners) { fn({ version: 2, owner: "owner", accept }); fn({ version: 1, owner: "foreign", accept }); }
  assert.equal(host, undefined);
  for (const fn of listeners) fn({ version: 1, owner: "owner", accept });
  const active = host as { focusEditor(data?: string): void; bindDown(handler: () => void): () => void; mount(view: Component): () => void } | undefined;
  assert(active);
  let down = 0; active.bindDown(() => down++); f.editor.handleInput("\x1b[B"); assert.equal(down, 1);
  const view = { render: () => ["worker"], invalidate() {}, dispose() { disposed++; } };
  active.mount(view); assert.equal(f.focused, view);
  active.focusEditor("z"); assert.equal(f.focused, f.editor); assert.equal(f.editor.getText(), "z");
  bridge.dispose(); assert.equal(restored, 1); assert.equal(disposed, 1); assert.equal(listeners.size, 0);
  assert.equal(f.editor.onDownBoundary, undefined); bridge.dispose(); assert.equal(disposed, 1);
});

test("a stale host never focuses or replaces a newer editor", () => {
  let request!: (value: unknown) => void;
  const pi = { events: { on(_name: string, fn: typeof request) { request = fn; return () => {}; } } } as unknown as ExtensionAPI;
  const first = editorFixture(), second = editorFixture(); let editor = first.editor, mounts = 0;
  const ctx = { mode: "tui", sessionManager: { getSessionId: () => "owner" } } as unknown as ExtensionContext;
  const bridge = installConversationBridge(pi, { context: () => ctx, editor: () => editor, tui: () => first.tui, replaceChat: () => { mounts++; return () => {}; } });
  let host!: { focusEditor(data?: string): void; mount(view: Component): unknown };
  request({ version: 1, owner: "owner", accept(value: typeof host) { host = value; } });
  editor = second.editor; host.focusEditor("z"); assert.equal(first.editor.getText(), "");
  assert.equal(host.mount(new Text("worker", 0, 0)), undefined); assert.equal(mounts, 0); bridge.dispose();
});

test("a stale restore cannot erase a new loan even when it reuses the same component", () => {
  const main = new Text("main", 0, 0), worker = new Text("worker", 0, 0), split = new SidebarSplit(main, new Text("sidebar", 0, 0));
  const stale = split.replaceChat(worker); stale();
  const current = split.replaceChat(worker); stale();
  assert(split.render(120).join("\n").includes("worker")); current();
  assert(!split.render(120).join("\n").includes("worker"));
});

test("a parent dialog reclaims the workspace without stealing its focus", async () => {
  const f = editorFixture(); let request!: (value: unknown) => void, restored = 0, disposed = 0;
  const pi = { events: { on(_name: string, fn: typeof request) { request = fn; return () => {}; } } } as unknown as ExtensionAPI;
  const ctx = { mode: "tui", sessionManager: { getSessionId: () => "owner" } } as unknown as ExtensionContext;
  const bridge = installConversationBridge(pi, { context: () => ctx, editor: () => f.editor, tui: () => f.tui, replaceChat: () => () => { restored++; } });
  let host!: { mount(view: Component): unknown; canFocusRoster(): boolean };
  request({ version: 1, owner: "owner", accept(value: typeof host) { host = value; } });
  const view = { render: () => ["worker"], invalidate() {}, dispose() { disposed++; } };
  host.mount(view); const dialog = new Text("parent question", 0, 0); f.tui.setFocus(dialog);
  view.render(); await Promise.resolve();
  assert.equal(restored, 1); assert.equal(disposed, 1); assert.equal(f.focused, dialog); assert.equal(host.canFocusRoster(), false);
  bridge.dispose(); assert.equal(disposed, 1);
});

test("editor-only hosts offer focus navigation without pretending to own a conversation pane", () => {
  const f = editorFixture(); let request!: (value: unknown) => void;
  const pi = { events: { on(_name: string, fn: typeof request) { request = fn; return () => {}; } } } as unknown as ExtensionAPI;
  const ctx = { mode: "tui", sessionManager: { getSessionId: () => "owner" } } as unknown as ExtensionContext;
  const bridge = installConversationBridge(pi, { context: () => ctx, editor: () => f.editor, tui: () => f.tui,
    canMount: () => false, replaceChat: () => { assert.fail("unowned surface must remain untouched"); } });
  let host!: { mount?: unknown; bindDown(handler: () => void): () => void };
  request({ version: 1, owner: "owner", accept(value: typeof host) { host = value; } });
  assert.equal(host.mount, undefined); assert.equal(typeof host.bindDown, "function"); bridge.dispose();
});
