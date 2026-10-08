import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { type ExtensionAPI, type ExtensionContext, type ExtensionEvent, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Editor, ScrollView, Text, TuiAltScreen, type Component, type EditorTheme, type Terminal, type TUI } from "@earendil-works/pi-tui";
import piSlate from "../extensions/pi-slate/index.ts";
import { GitStatusPoller } from "../extensions/pi-slate/git-status.ts";
import { FRESH_SURFACES, has, SURFACES, type Surface } from "../extensions/pi-slate/surfaces.ts";
import { InteractiveMode } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";

class NullTerminal implements Terminal {
  columns = 140; rows = 24; kittyProtocolActive = false;
  start() {} stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {}
  clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {}
}

const theme = { name: "dark", fg: (_color: string, text: string) => text, bold: (text: string) => text, italic: (text: string) => text } as Theme;
const editorTheme = { borderColor: (text: string) => text } as EditorTheme;

type Handler = (event: ExtensionEvent, ctx: ExtensionContext) => unknown;

async function fixture(t: TestContext, text: string | undefined, mode = "tui", compatible = true, conflict = false) {
  const cwd = await mkdtemp(join(tmpdir(), "slate-surfaces-"));
  const previous = { dir: process.env.PI_CODING_AGENT_DIR, offline: process.env.PI_OFFLINE };
  process.env.PI_CODING_AGENT_DIR = cwd;
  process.env.PI_OFFLINE = "1";
  t.after(async () => {
    if (previous.dir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous.dir;
    if (previous.offline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = previous.offline;
    await rm(cwd, { recursive: true, force: true });
  });
  const imagePath = join(cwd, "image.png");
  await writeFile(imagePath, "test image bytes");
  const path = join(cwd, "pi-slate.json");
  if (text !== undefined) await writeFile(path, text);
  const calls: string[] = [];
  const notices: string[] = [];
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
  const tools: ToolDefinition[] = [];
  const handlers = new Map<string, Handler[]>();
  t.mock.method(GitStatusPoller.prototype, "start", () => { calls.push("files-start"); });
  t.mock.method(GitStatusPoller.prototype, "refresh", async () => { calls.push("files-refresh"); });
  const pi = {
    on(event: string, handler: Handler) { handlers.set(event, [...handlers.get(event) ?? [], handler]); },
    registerCommand(name: string, command: typeof commands extends Map<string, infer V> ? V : never) { commands.set(name, command); },
    registerShortcut() {},
    registerTool(tool: ToolDefinition) { tools.push(tool); },
    getCommands: () => [],
    getAllTools: () => tools.map((tool) => ({ ...tool, sourceInfo: { path: conflict ? "/foreign/cards.ts" : new URL("../extensions/pi-slate/index.ts", import.meta.url).pathname } })),
    exec: async () => { calls.push("branch-git"); return { code: 0, stdout: "test-branch\n", stderr: "", killed: false }; },
    events: { on: () => { calls.push("async-subscribe"); return () => calls.push("async-dispose"); } },
  } as unknown as ExtensionAPI;
  const tui = compatible ? new TuiAltScreen(new NullTerminal()) : {
    requestRender() {}, terminal: { columns: 140, rows: 24 }, showOverlay() { assert.fail("no overlay fallback"); },
  } as unknown as TUI;
  const chat = new Container();
  for (let i = 0; i < 105; i++) chat.addChild(new Text(`message-${i}`, 0, 0));
  const root = new ScrollView(chat, { primary: true });
  if (compatible) (tui as TuiAltScreen).setLayoutRoot(root);
  const originalInsert = Editor.prototype.insertTextAtCursor;
  const originalPaste = Reflect.get(Editor.prototype, "handlePaste");
  const foreign = new Editor(tui, editorTheme);
  const foreignInsert = foreign.insertTextAtCursor;
  let editorFactory: unknown;
  let composer: Editor | undefined;
  const ui = {
    theme,
    notify: (message: string) => notices.push(message),
    setHeader: (factory: ((tui: TUI, theme: Theme) => Component) | undefined) => { assert.ok(factory); calls.push("header"); factory(tui, theme); },
    setFooter: (factory: (() => Component) | undefined) => { assert.ok(factory); calls.push("footer"); assert.deepEqual(factory().render(80), []); },
    setEditorComponent: (factory: ((tui: TUI, theme: EditorTheme, keys: KeybindingsManager) => Editor) | undefined) => {
      assert.ok(factory); calls.push("editor"); editorFactory = factory; composer = factory(tui, editorTheme, new KeybindingsManager());
    },
    getEditorComponent: () => editorFactory,
    setWidget: (key: string, factory: (tui: TUI, theme: Theme) => Component, options: { placement: string }) => {
      assert.equal(key, "pi-slate:surface-host"); assert.equal(options.placement, "belowEditor");
      calls.push("widget"); assert.deepEqual(factory(tui, theme).render(80), []);
    },
    setTitle() { assert.fail("Slate must not take the title"); },
    setTheme() { assert.fail("no automatic theme changes"); },
    setWorkingIndicator() { assert.fail("no global working-indicator takeover"); },
    setWorkingMessage: () => calls.push("working"),
  };
  const ctx = { cwd, mode, ui, sessionManager: { getBranch: () => [], buildContextEntries: () => [] }, getContextUsage: () => undefined } as unknown as ExtensionContext;
  piSlate(pi);
  const emit = async (type: string, extra: Record<string, unknown> = {}) => {
    let result: unknown;
    for (const handler of handlers.get(type) ?? []) result = await handler({ type, ...extra } as ExtensionEvent, ctx);
    return result;
  };
  t.after(() => emit("session_shutdown"));
  await emit("session_start");
  await Promise.resolve();
  assert.equal(Editor.prototype.insertTextAtCursor, originalInsert);
  assert.equal(Reflect.get(Editor.prototype, "handlePaste"), originalPaste);
  assert.equal(foreign.insertTextAtCursor, foreignInsert);
  return { calls, notices, commands, tools, emit, ctx, path, imagePath, chat, root, tui, composer, foreign, setForeignEditor: () => { editorFactory = () => foreign; } };
}

for (const surfaces of [[], ["editor"], [...FRESH_SURFACES], [...SURFACES], ["header"], ["tool-cards"], ["sidebar"], ["transcript"], ["footer"]] as Surface[][]) {
  test(`selected set controls all installers: ${surfaces.join("+") || "none"}`, async (t) => {
    const f = await fixture(t, JSON.stringify({ version: 1, surfaces, focused: true }));
    for (const slot of ["header", "footer", "editor"] as const) assert.equal(f.calls.includes(slot), has(surfaces, slot), slot);
    assert.equal(f.calls.includes("widget"), has(surfaces, "sidebar") || has(surfaces, "transcript"));
    assert.equal(f.calls.includes("files-start"), has(surfaces, "sidebar"));
    assert.equal(f.calls.includes("async-subscribe"), has(surfaces, "sidebar"));
    assert.equal(f.calls.includes("branch-git"), has(surfaces, "editor"));
    assert.deepEqual(f.tools.map((tool) => tool.name).sort(), has(surfaces, "tool-cards") ? ["edit", "read", "write"] : []);
    assert.equal(f.commands.has("exit"), true);
    assert.equal(f.commands.has("prompts"), has(surfaces, "editor"));
    assert.equal(f.chat.children.length, has(surfaces, "transcript") ? 100 : 105);
    const message = { role: "assistant", content: [{ type: "thinking", thinking: "reasoning" }] };
    await f.emit("agent_start");
    await f.emit("message_update", { message, assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } });
    assert.equal(f.calls.includes("working"), has(surfaces, "editor"));
    f.foreign.insertTextAtCursor(f.imagePath);
    assert.equal(f.foreign.getText(), f.imagePath, "foreign editor insertion is never rewritten");
    const input = await f.emit("input", { text: f.imagePath });
    if (has(surfaces, "editor")) {
      assert.deepEqual(input, { action: "transform", text: "[image-1]", images: [{ type: "image", data: Buffer.from("test image bytes").toString("base64"), mimeType: "image/png" }] });
      f.composer!.insertTextAtCursor(f.imagePath);
      assert.equal(f.composer!.getText(), "[image-1]", "only the Slate instance rewrites images");
    } else assert.equal(input, undefined, "unselected editor registers no image transform");
    const mounts = f.calls.filter((call) => ["header", "footer", "editor", "widget"].includes(call));
    f.setForeignEditor();
    assert.equal(await f.emit("input", { text: f.imagePath }), undefined, "successor editor input stays native");
    const workingCount = f.calls.filter((call) => call === "working").length;
    await f.emit("message_update", { message, assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } });
    assert.equal(f.calls.filter((call) => call === "working").length, workingCount, "foreign editor never receives Slate thinking status");
    await f.emit("session_shutdown");
    await f.emit("session_shutdown");
    assert.deepEqual(f.calls.filter((call) => ["header", "footer", "editor", "widget"].includes(call)), mounts, "cleanup does not clear unowned or successor slots");
    assert.equal(f.chat.children.length, 105);
  });
}

test("surface saves require reload; focus/width never enable an unselected sidebar", async (t) => {
  const f = await fixture(t, JSON.stringify({ version: 1, surfaces: ["tool-cards"], focused: true, footer: "minimal" }));
  const command = f.commands.get("slate")!;
  await command.handler("focused off", f.ctx);
  await command.handler("width wide", f.ctx);
  assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")).surfaces, ["tool-cards"]);
  await command.handler("surfaces set header tool-cards", f.ctx);
  assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")).surfaces, ["header", "tool-cards"]);
  assert.ok(f.notices.some((notice) => /reload required/.test(notice)));
  assert.equal(f.calls.includes("header"), false, "no hot swap");
  await command.handler("surfaces full", f.ctx);
  const saved = JSON.parse(await readFile(f.path, "utf8"));
  assert.deepEqual(saved.surfaces, SURFACES);
  assert.equal(saved.composerMetadata, "minimal");
  assert.equal(saved.footer, "minimal");
  await command.handler("surfaces none", f.ctx);
  assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")).surfaces, []);
});

test("invalid files activate nothing, warn, and survive even a settings command", async (t) => {
  const text = '{"version":999,"surfaces":["editor"]}';
  const f = await fixture(t, text);
  assert.equal(f.calls.length, 0);
  assert.equal(f.tools.length, 0);
  assert.match(f.notices.join("\n"), /preserved/);
  await f.commands.get("slate")!.handler("surfaces full", f.ctx);
  assert.equal(await readFile(f.path, "utf8"), text);
});

test("fresh config does not write preferences on load", async (t) => {
  const f = await fixture(t, undefined);
  assert.equal(f.calls.includes("editor"), true);
  assert.equal(f.calls.includes("header"), false);
  assert.equal(f.calls.includes("footer"), false);
  await assert.rejects(readFile(f.path), { code: "ENOENT" });
});

for (const mode of ["print", "rpc", "json"]) {
  test(`${mode} keeps native tools and never installs UI patches`, async (t) => {
    const f = await fixture(t, JSON.stringify({ surfaces: SURFACES }), mode);
    await f.emit("agent_start");
    await f.emit("message_update", { message: { role: "assistant", content: [] } });
    assert.equal(await f.emit("input", { text: f.imagePath }), undefined);
    assert.equal(f.calls.length, 0);
    assert.equal(f.chat.children.length, 105);
  });
}

test("incompatible hosts report unavailable without fullscreen or overlay writes", async (t) => {
  const f = await fixture(t, JSON.stringify({ surfaces: ["sidebar", "transcript"], focused: false }), "tui", false);
  assert.match(f.notices.join("\n"), /sidebar unavailable/);
  assert.match(f.notices.join("\n"), /transcript unavailable/);
  assert.equal(f.chat.children.length, 105);
});

test("hidden sidebar stays quiet on an incompatible host", async (t) => {
  const f = await fixture(t, JSON.stringify({ surfaces: ["sidebar"], focused: true }), "tui", false);
  assert.equal(f.notices.some((notice) => /sidebar unavailable/.test(notice)), false);
});

test("tool-cards reports first-registration losses without conflict repair", async (t) => {
  const f = await fixture(t, JSON.stringify({ surfaces: ["tool-cards"] }), "tui", true, true);
  assert.match(f.notices.join("\n"), /tool-cards unavailable.*first registration wins/);
});

test("real host below-editor widget renderer adds no rows for the TUI handle", () => {
  const render = Reflect.get(InteractiveMode.prototype, "renderWidgetContainer") as (container: Container, widgets: Map<string, Component>, empty: boolean, leading: boolean) => void;
  const container = new Container();
  render.call({}, container, new Map(), false, false);
  const before = container.render(80);
  render.call({}, container, new Map([["pi-slate:surface-host", { render: () => [], invalidate() {} }]]), false, false);
  assert.deepEqual(container.render(80), before);
  const other = new Text("another extension's widget", 0, 0);
  render.call({}, container, new Map<string, Component>([["foreign", other], ["pi-slate:surface-host", { render: () => [], invalidate() {} }]]), false, false);
  assert.deepEqual(container.render(80), other.render(80));
});
