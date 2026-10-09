import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, setKeybindings, visibleWidth, TuiAltScreen, type TUI, type Terminal, type Focusable, type Component } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { InspectView, attach, type InspectActions } from "../src/inspect.ts";
import { HumanState } from "../src/presentation.ts";
import { SubagentWidget } from "../src/ui.ts";
import { readConversation } from "../src/conversation.ts";
import type { RunRecord } from "../src/types.ts";
import { until } from "./helpers.ts";

const theme = { fg: (_color: string, text: string) => text } as Theme;
function record(id = "opaque-run-uuid", state: RunRecord["state"] = "running"): RunRecord {
  return { id, owner: "parent-session-uuid", agent: "worker", mode: "inspect", cwd: "/workspace", workspace: "/workspace", model: "fixture/worker",
    thinking: "low", task: "A useful human task", state, startedAt: new Date(0).toISOString(), elapsedMs: 0,
    metadataPath: `/evidence/${id}/run.json`, sessionId: "native-session-uuid", pid: 999999 };
}
function terminal() {
  let focused: (Component & Partial<Focusable>) | undefined;
  const screen = { rows: 24, columns: 80 };
  return { terminal: screen, resize(rows: number) { screen.rows = rows; }, requestRender() {},
    setFocus(next: Component & Partial<Focusable>) { if (focused) focused.focused = false; focused = next; next.focused = true; }, getFocusedComponent: () => focused ?? null,
  } as unknown as TUI & { resize(rows: number): void };
}
function harness(initial = record()) {
  let current = initial;
  const listeners = new Set<() => void>();
  const replies: { id: string; requestId: string; text: string }[] = [], steers: string[] = [];
  let stops = 0;
  const actions: InspectActions = {
    status: () => current, preview: () => ["Recent readable message"], live: () => [current],
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async reply(id, requestId, text) { replies.push({ id, requestId, text }); },
    async steer(_id, text) { steers.push(text); return "queued"; },
    async stop() { stops++; },
  };
  return { actions, replies, steers, get stops() { return stops; }, get listeners() { return listeners.size; },
    update(next: RunRecord) { current = next; for (const fn of listeners) fn(); } };
}
function type(view: InspectView, text: string) { for (const character of text) view.handleInput(character === "\n" ? "\x1b[13;2u" : character); }
function action(view: InspectView, index: number) { view.handleInput("\t"); view.handleInput("\t"); for (let i = 0; i < index; i++) view.handleInput("\x1b[C"); view.handleInput("\r"); }
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

test("overlay creation leaves focus to the host and restores an unknown custom editor", async () => {
  const tty = { columns: 80, rows: 24, write() {}, start() {}, stop() {}, hideCursor() {}, showCursor() {} } as unknown as Terminal;
  const tui = new TuiAltScreen(tty);
  const editor = { focused: false, render: () => ["custom editor"], invalidate() {} };
  tui.setLayoutRoot(editor); tui.setFocus(editor);
  const h = harness();
  const ctx = { ui: { async custom(factory: (tui: TUI, theme: Theme, keys: unknown, done: () => void) => InspectView) {
    // Same ordering as Pi showExtensionCustom: factory first, then showOverlay.
    const view = factory(tui, theme, undefined, () => tui.hideOverlay());
    assert.equal(editor.focused, true, "factory must not replace the overlay restore target");
    tui.showOverlay(view, { width: "100%", maxHeight: "100%" });
    assert.equal(view.focused, true);
    view.handleInput("\x1b");
    assert.equal(editor.focused, true, "SDK must restore the original custom editor");
  } } } as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext;
  await attach(ctx, record().id, h.actions);
  assert.equal(h.listeners, 0);
});

test("stable human identities drop settled completions from the roster", () => {
  const state = new HumanState(), a = record("a"), b = record("b");
  state.remember([a, b]);
  assert.match(state.title(a), /^Worker 1/); assert.match(state.title(b), /^Worker 2/);
  const done = { ...a, state: "completed" as const, endedAt: new Date(1).toISOString() };
  assert.equal(state.visible([done, b]).length, 1);
  assert.equal(state.visible([done, b])[0]?.id, b.id);
  state.markRead(done); assert.equal(state.recent([done, b]).length, 1);
  state.selected = a.id; assert.equal(state.visible([done, b]).length, 1);
  state.open = a.id; assert.equal(state.visible([done, b]).length, 1);
  assert.match(state.title(b), /^Worker 2/, "settling a sibling never renumbers the remaining worker");
});

test("settling the selected live row moves selection to a remaining worker", () => {
  const opened: string[] = [];
  const a = record("a"), b = record("b");
  const widget = new SubagentWidget(terminal(), theme, id => opened.push(id));
  widget.update([a, b], false); widget.focusRoster("a");
  widget.update([{ ...a, state: "completed", endedAt: new Date(1).toISOString() }, b], false);
  widget.handleInput("\r");
  assert.deepEqual(opened, ["b"]);
});

test("Down focuses and selects without activating; Enter and Space activate exact IDs; typing returns intact to editor", () => {
  const opened: string[] = [], returned: (string | undefined)[] = [];
  const a = record("a"), b = record("b"), state = new HumanState();
  const widget = new SubagentWidget(terminal(), theme, id => opened.push(id), state, data => returned.push(data));
  widget.update([a, b], false); widget.focusRoster(); widget.handleInput("\x1b[B");
  assert.equal(opened.length, 0); assert.equal(state.selected, "b");
  widget.handleInput("\r"); assert.equal(opened.at(-1), "b");
  widget.focusRoster("a"); widget.handleInput(" "); assert.equal(opened.at(-1), "a");
  widget.focusRoster("b"); widget.handleInput("\x1b[32u"); assert.equal(opened.at(-1), "b", "Kitty space must activate");
  widget.handleInput("z"); assert.equal(returned.at(-1), "z"); assert.equal(state.selected, undefined);
  widget.focusRoster("a"); widget.handleInput("\x1b[A"); assert.equal(returned.at(-1), undefined);
});

test("idle roster stays bounded and lists only live rows", () => {
  const live = Array.from({ length: 4 }, (_, i) => ({ ...record(`live-${i}`), task: `Live task ${i}` }));
  const unread = Array.from({ length: 28 }, (_, i) => ({ ...record(`done-${i}`, "completed"), endedAt: new Date(i + 1).toISOString(), task: `Settled task ${i}` }));
  const runs = [...unread, ...live];
  const opened: string[] = [];
  const tui = terminal();
  const editor = { render: () => ["MAIN EDITOR"], invalidate() {}, focused: true, handleInput() {} };
  tui.setFocus(editor);
  const widget = new SubagentWidget(tui, theme, id => opened.push(id));
  widget.update(runs, false);
  const idle = widget.render(80);
  assert(idle.length <= 10, `idle roster must leave the editor usable, got ${idle.length} lines`);
  for (const task of ["Live task 0", "Live task 1", "Live task 2", "Live task 3"]) {
    assert(idle.some(line => line.includes(task)), task);
  }
  assert.match(idle[0]!, /4 live/);
  assert.doesNotMatch(idle.join("\n"), /unread|Settled task/);
  widget.focusRoster(unread[27]!.id);
  assert.doesNotMatch(widget.render(80).join("\n"), /Settled task/);
  widget.focusRoster(live[2]!.id);
  const painted = widget.render(80);
  const row = painted.findIndex(line => line.includes("Live task 2"));
  assert(row > 0, "focused window must paint the selected live row");
  widget.handleMouse({ type: "click", button: "left", x: 0, y: row, screenX: 0, screenY: 0, width: 80, height: painted.length, shift: false, alt: false, ctrl: false, clickCount: 2 });
  assert.equal(opened.at(-1), live[2]!.id);
  const focusedId = live[0]!.id;
  widget.focusRoster(focusedId);
  widget.update([...unread, { ...live[1]!, state: "completed", endedAt: new Date(100).toISOString() }, live[0]!, live[2]!, live[3]!], false);
  assert.equal(widget.state.selected, focusedId, "completion must not reorder the focused selection");
});

test("a settled-only roster has no rows to activate", () => {
  const state = new HumanState(), done = { ...record("done", "completed"), endedAt: new Date(1).toISOString() };
  state.markRead(done);
  const opened: string[] = [], widget = new SubagentWidget(terminal(), theme, id => opened.push(id), state);
  widget.update([done], false); widget.focusRoster();
  widget.handleInput("\r"); assert.equal(opened.length, 0);
  widget.handleInput("\x1b[B"); widget.handleInput(" "); assert.equal(opened.length, 0);
  assert.doesNotMatch(widget.render(80).join("\n"), /Finished|Recent|Worker/);
});

test("thread Space/arrows edit, Tab changes focus, Esc returns; per-run drafts survive switching", () => {
  const h = harness(), state = new HumanState(); let closed = 0;
  const view = new InspectView(terminal(), theme, record().id, h.actions, () => closed++, state);
  type(view, "hello world"); view.handleInput("\x1b[D"); type(view, "!");
  assert.equal(state.draft(record()).text, "hello worl!d");
  view.handleInput("\t"); view.handleInput(" "); assert.equal(state.draft(record()).text, "hello worl!d");
  view.handleInput("\x1b"); assert.equal(closed, 1); assert.equal(h.listeners, 0);
  const reopened = new InspectView(terminal(), theme, record().id, h.actions, () => {}, state);
  assert(reopened.render(80).join("\n").includes("hello worl!d")); reopened.dispose();
});

test("failed steering retains the exact draft and sends no reply", async t => {
  const h = harness(), state = new HumanState();
  h.actions.steer = async () => { throw new Error("delivery failed"); };
  const view = new InspectView(terminal(), theme, record().id, h.actions, () => {}, state); t.after(() => view.dispose());
  type(view, "retain this"); view.handleInput("\r"); await tick();
  assert.equal(state.draft(record()).text, "retain this"); assert.equal(h.replies.length, 0);
  assert(view.render(100).join("\n").includes("delivery failed"));
});

test("a stale question cannot consume a draft intended for an earlier question", async t => {
  const first = { ...record(), question: { id: "question-one", message: "First question?" } };
  const h = harness(first), state = new HumanState();
  const view = new InspectView(terminal(), theme, first.id, h.actions, () => {}, state); t.after(() => view.dispose());
  type(view, "answer one"); h.update({ ...first, question: { id: "question-two", message: "Second question?" } });
  view.handleInput("\r"); await tick();
  assert.equal(h.replies.length, 0); assert.equal(h.steers.length, 0); assert.equal(state.draft(first).text, "answer one");
  assert(view.render(100).join("\n").includes("Question changed"));
  view.handleInput("\x15"); type(view, "answer two"); view.handleInput("\r"); await tick();
  assert.equal(h.replies[0]?.requestId, "question-two"); assert.equal(h.replies[0]?.id, first.id);
  assert.equal(state.draft(first).text, "");
});

test("success clears only its submitted revision; typing while sending is retained", async t => {
  const h = harness(), state = new HumanState(); let delivered!: () => void;
  h.actions.steer = () => new Promise(resolve => { delivered = () => resolve("queued"); });
  const view = new InspectView(terminal(), theme, record().id, h.actions, () => {}, state); t.after(() => view.dispose());
  type(view, "first"); view.handleInput("\r"); view.handleInput("\x15"); type(view, "next");
  delivered(); await tick(); assert.equal(state.draft(record()).text, "next");
});

test("Stop stays available during an in-flight send and requires separate confirmation", async t => {
  const h = harness(), state = new HumanState(); let delivered!: () => void;
  h.actions.steer = () => new Promise(resolve => { delivered = () => resolve("queued"); });
  const view = new InspectView(terminal(), theme, record().id, h.actions, () => {}, state); t.after(() => view.dispose());
  type(view, "still sending"); view.handleInput("\r"); action(view, 5);
  assert.equal(h.stops, 0); view.handleInput("\r"); await tick(); assert.equal(h.stops, 1);
  delivered(); await tick();
});

test("completion does not clear an unsent draft, close the selected thread or permit late input", async t => {
  const h = harness(), state = new HumanState(); let closed = 0;
  const view = new InspectView(terminal(), theme, record().id, h.actions, () => closed++, state); t.after(() => view.dispose());
  type(view, "unsent"); h.update({ ...record(), state: "completed", endedAt: new Date(1).toISOString() });
  view.handleInput("\r"); await tick(); assert.equal(h.steers.length, 0); assert.equal(closed, 0);
  assert.equal(state.draft(record()).text, "unsent"); assert(view.render(100).join("\n").includes("Finished · report saved"));
});

test("normal headers contain no execution identifiers; Details exposes diagnostics on demand", () => {
  const h = harness(), view = new InspectView(terminal(), theme, record().id, h.actions, () => {});
  const normal = view.render(120).join("\n");
  for (const hidden of [record().id, record().sessionId!, "/evidence", "999999"]) assert(!normal.includes(hidden));
  action(view, 1);
  const details = view.render(120).join("\n");
  for (const shown of [record().id, record().sessionId!, "/evidence", "999999"]) assert(details.includes(shown));
  view.dispose();
});

test("thread wraps Unicode and long replies across narrow/resized viewports without terminal injection", () => {
  const first = { ...record(), question: { id: "question", message: "界".repeat(400) + "\x1b]52;c;attack\x07\u202e" } };
  const h = harness(first), tui = terminal(), view = new InspectView(tui, theme, first.id, h.actions, () => {});
  type(view, "a retained reply");
  for (const width of [1, 8, 20, 60, 120]) for (const rows of [4, 12, 30]) {
    tui.resize(rows);
    const lines = view.render(width); assert.equal(lines.length, rows);
    assert(lines.every(line => visibleWidth(line) <= width));
    assert(!lines.some(line => line.includes("\x1b]52") || line.includes("\u202e")));
  }
  view.dispose();
});

test("conversation reads are asynchronous bounded pages, recover torn tails, and strip terminal controls", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "subagent-conversation-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "thread.jsonl");
  const line = (text: string, role = "assistant") => JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }] } });
  await writeFile(file, Array.from({ length: 300 }, (_, i) => line(`message ${i}`)).join("\n") + "\n" + '{"type":"message"');
  const latest = await readConversation(file);
  assert.equal(latest.messages.length, 128); assert.equal(latest.messages.at(-1)?.text, "message 299");
  assert.equal(latest.omitted, true); assert(latest.before! > 0);
  const older = await readConversation(file, latest.before);
  assert.equal(older.messages.at(-1)?.text, "message 171");
  await writeFile(file, line("oversized " + "x".repeat(100000)) + "\n" + line("\x1b]52;c;attack\x07\u202e safe") + "\n");
  const bounded = await readConversation(file); assert.equal(bounded.messages.length, 1); assert.equal(bounded.omitted, true);
  assert(!bounded.messages[0]!.text.includes("\x1b") && !bounded.messages[0]!.text.includes("\u202e"));
  await writeFile(file, line("only " + "y".repeat(100000)) + "\n");
  const giant = await readConversation(file);
  assert.equal(giant.messages.length, 0);
  assert.equal(giant.omitted, true);
  assert.notEqual(giant.before, (await stat(file)).size, "an empty page must not re-offer the same end offset");
  if (giant.before !== undefined) {
    const older = await readConversation(file, giant.before);
    assert.notEqual(older.before, giant.before);
  }
});

test("Older pages and unsent drafts survive reopening; live status never silently advances a history page", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "subagent-history-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "thread.jsonl");
  await writeFile(file, Array.from({ length: 300 }, (_, i) => JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: `message ${i}` }] } })).join("\n") + "\n");
  const run = { ...record(), sessionPath: file }, h = harness(run), state = new HumanState();
  const view = new InspectView(terminal(), theme, run.id, h.actions, () => {}, state); t.after(() => view.dispose());
  await until(() => view.render(80).join("\n").includes("message 299"));
  type(view, "retain this draft"); action(view, 3);
  await until(() => view.render(80).join("\n").includes("message 171"));
  view.dispose();
  const reopened = new InspectView(terminal(), theme, run.id, h.actions, () => {}, state); t.after(() => reopened.dispose());
  h.update({ ...run, elapsedMs: 200 });
  await until(() => reopened.render(80).join("\n").includes("message 171"));
  assert.equal(state.draft(run).text, "retain this draft"); assert(!reopened.render(80).join("\n").includes("message 299"));
});

test("a throwing workspace host does not hang attach and uses the overlay", async () => {
  const h = harness();
  let overlay = 0;
  const tui = terminal();
  const ctx = {
    ui: {
      setWidget() { throw new Error("widget factory unavailable"); },
      async custom(factory: (tui: TUI, theme: Theme, keys: unknown, done: () => void) => InspectView) {
        overlay++;
        factory(tui, theme, undefined, () => {}).dispose();
      },
    },
  } as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext;
  await Promise.race([
    attach(ctx, record().id, h.actions, new HumanState(), {
      version: 1, focusEditor() {}, bindDown() { return () => {}; }, mount() { return () => {}; },
    }),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error("attach hung after host widget failure")), 500)),
  ]);
  assert.equal(overlay, 1);
});

test("a host that offers mount but cannot lend a slot falls back to the opaque overlay", async () => {
  const h = harness();
  let overlay = 0, mounted = 0;
  const notices: string[] = [];
  const tui = terminal();
  const ctx = {
    ui: {
      setWidget(_key: string, factory?: (tui: TUI, theme: Theme) => { dispose(): void }) {
        factory?.(tui, theme)?.dispose();
      },
      async custom(factory: (tui: TUI, theme: Theme, keys: unknown, done: () => void) => InspectView) {
        overlay++;
        const view = factory(tui, theme, undefined, () => {});
        assert.match(view.render(80).join("\n"), /sidebar not preserved/);
        view.dispose();
      },
      notify(message: string) { notices.push(message); },
    },
  } as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext;
  await attach(ctx, record().id, h.actions, new HumanState(), {
    version: 1,
    focusEditor() {},
    bindDown() { return () => {}; },
    mount() { mounted++; return undefined; },
  });
  assert.equal(mounted, 1);
  assert.equal(overlay, 1);
  assert.match(notices.join("\n"), /Workspace unavailable.*sidebar not preserved/);
  assert.equal(h.listeners, 0);
});

test("setWidget throw after a successful mount still releases the loan when unset also throws", async () => {
  const done = { ...record("done", "completed"), endedAt: new Date(1).toISOString() };
  const h = harness(done);
  const state = new HumanState();
  let released = 0, overlay = 0, closer: (() => void) | undefined;
  const notices: string[] = [];
  const tui = terminal();
  const ctx = {
    ui: {
      setWidget(_key: string, factory?: (tui: TUI, theme: Theme) => { dispose(): void }) {
        if (!factory) throw new Error("unset failed");
        factory(tui, theme);
        throw new Error("setWidget failed after factory");
      },
      async custom(factory: (tui: TUI, theme: Theme, keys: unknown, done: () => void) => InspectView) {
        overlay++;
        factory(tui, theme, undefined, () => {}).dispose();
      },
      notify(message: string) { notices.push(message); },
    },
  } as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext;
  await attach(ctx, done.id, h.actions, state, {
    version: 1, focusEditor() {}, bindDown() { return () => {}; },
    mount() {
      let once = false;
      return () => { if (once) return; once = true; released++; };
    },
  }, close => { closer = close; });
  closer?.();
  assert.equal(released, 1);
  assert.equal(h.listeners, 0);
  assert.equal(overlay, 1);
  assert.equal(state.open, undefined);
  assert.match(notices.join("\n"), /overlay|sidebar not preserved/i);
});

test("constructing or failing to open a thread does not mark a completed worker read", async () => {
  const done = { ...record("done", "completed"), endedAt: new Date(1).toISOString() };
  const constructed = harness(done);
  const state = new HumanState();
  const tui = terminal();
  const view = new InspectView(tui, theme, done.id, constructed.actions, () => {}, state);
  assert.equal(state.unread(done), true);
  view.render(80);
  assert.equal(state.unread(done), true, "constructing and painting without focus cannot mark read");
  const dialog = { render: () => ["dialog"], invalidate() {} };
  tui.setFocus(view); tui.setFocus(dialog);
  view.render(80);
  assert.equal(state.unread(done), true, "foreign-dialog focus cannot mark read");
  view.dispose();
  const failed = harness(done);
  const unread = new HumanState();
  const ctx = {
    ui: {
      setWidget(_key: string, factory?: (tui: TUI, theme: Theme) => { dispose(): void }) {
        if (!factory) throw new Error("unset failed");
        factory(tui, theme);
        throw new Error("setWidget failed after factory");
      },
      async custom() { throw new Error("overlay failed"); },
      notify() {},
    },
  } as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext;
  await assert.rejects(attach(ctx, done.id, failed.actions, unread, {
    version: 1, focusEditor() {}, bindDown() { return () => {}; },
    mount() { return () => {}; },
  }));
  assert.equal(unread.unread(done), true);
  assert.equal(failed.listeners, 0);
});

test("Kitty space activates thread action buttons", () => {
  const h = harness();
  let closed = 0;
  const view = new InspectView(terminal(), theme, record().id, h.actions, () => closed++);
  view.handleInput("\t"); view.handleInput("\t");
  view.handleInput("\x1b[32u");
  assert.equal(closed, 1);
  view.dispose();
});

test("unknown custom editors restore their original focused component without an editor replacement", () => {
  const tui = terminal(), inputs: string[] = [], editor = { render: () => ["original"], invalidate() {}, focused: false, handleInput(data: string) { inputs.push(data); } };
  tui.setFocus(editor);
  const widget = new SubagentWidget(tui, theme, () => {}); widget.update([record()], false);
  widget.focusRoster(); widget.handleInput("z");
  assert.equal(editor.focused, true); assert.equal(inputs[0], "z");
});

test("restoring an existing latest-page reading position never adds the whole freshly loaded page", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "subagent-scroll-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "thread.jsonl");
  await writeFile(file, JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n") }] } }) + "\n");
  const run = { ...record(), sessionPath: file }, h = harness(run), state = new HumanState(); state.draft(run).scroll = 20;
  const view = new InspectView(terminal(), theme, run.id, h.actions, () => {}, state); t.after(() => view.dispose());
  await until(() => view.render(80).join("\n").includes("line 59"));
  assert.equal(state.draft(run).scroll, 20);
  for (let i = 0; i < 100; i++) view.handleInput("\x1b[5~");
  assert(state.draft(run).scroll < 100, "scrolling clamps at the actual top");
});

test("configured cursorDown pages the roster instead of bouncing back to the editor", t => {
  const previous = getKeybindings();
  setKeybindings(new KeybindingsManager({ "tui.editor.cursorDown": "ctrl+n" }));
  t.after(() => setKeybindings(previous));
  const returned: Array<string | undefined> = [];
  const runs = Array.from({ length: 12 }, (_, i) => record(`id-${i}`));
  const widget = new SubagentWidget(terminal(), theme, () => {}, new HumanState(), data => returned.push(data));
  widget.update(runs, false);
  widget.focusRoster(runs[0]!.id);
  widget.handleInput("\x0e");
  assert.equal(widget.state.selected, runs[1]!.id);
  assert.equal(returned.length, 0, "the handoff key must keep navigating the roster");
  widget.handleInput("\x1b[6~");
  assert.equal(widget.state.selected, runs[9]!.id);
});

test("thread header shows live tool activity; truncated action clicks hit the painted button", () => {
  const busy = { ...record(), currentTool: "bash" };
  const h = harness(busy);
  let closed = 0;
  const view = new InspectView(terminal(), theme, busy.id, h.actions, () => closed++);
  assert.match(view.render(80).join("\n"), /bash/);
  const lines = view.render(22);
  const actionsRow = lines.findIndex(line => line.includes("[Back]"));
  view.handleMouse({ type: "click", button: "left", x: 50, y: actionsRow, screenX: 50, screenY: actionsRow, width: 22, height: 24, shift: false, alt: false, ctrl: false, clickCount: 1 });
  assert.equal(closed, 0, "a click past the truncated actions row must not activate a clipped button");
  view.dispose();
});
