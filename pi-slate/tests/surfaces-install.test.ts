import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext, type ExtensionEvent, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Editor, ScrollView, Text, TuiAltScreen, type Component, type EditorTheme, type Terminal, type TUI } from "@earendil-works/pi-tui";
import piSlate from "../extensions/pi-slate/index.ts";
import { Sidebar } from "../extensions/pi-slate/sidebar.ts";
import { GitStatusPoller } from "../extensions/pi-slate/git-status.ts";
import { FRESH_SURFACES, has, SURFACES, type Surface } from "../extensions/pi-slate/surfaces.ts";
import { InteractiveMode } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";

class NullTerminal implements Terminal {
  columns = 140; rows = 40; kittyProtocolActive = false;
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
  const bus = new Map<string, Set<(data: unknown) => void>>();
  const choices: string[] = [];
  const inspected: string[] = [];
  const extraCommands: Array<{ name: string; source: string; sourceInfo: { path: string; scope: string } }> = [];
  let draft = "existing draft";
  t.mock.method(GitStatusPoller.prototype, "start", () => { calls.push("files-start"); });
  t.mock.method(GitStatusPoller.prototype, "refresh", async () => { calls.push("files-refresh"); });
  const pi = {
    on(event: string, handler: Handler) { handlers.set(event, [...handlers.get(event) ?? [], handler]); },
    registerCommand(name: string, command: typeof commands extends Map<string, infer V> ? V : never) { commands.set(name, command); },
    registerShortcut() {},
    registerTool(tool: ToolDefinition) { tools.push(tool); },
    getCommands: () => extraCommands,
    getAllTools: () => tools.map((tool) => ({ ...tool, sourceInfo: { path: conflict ? "/foreign/cards.ts" : new URL("../extensions/pi-slate/index.ts", import.meta.url).pathname } })),
    exec: async () => { calls.push("branch-git"); return { code: 0, stdout: "test-branch\n", stderr: "", killed: false }; },
    events: {
      on(name: string, handler: (value: unknown) => void) {
        calls.push("async-subscribe");
        const listeners = bus.get(name) ?? new Set(); listeners.add(handler); bus.set(name, listeners);
        return () => { calls.push("async-dispose"); listeners.delete(handler); };
      },
      emit(name: string, value: unknown) { for (const listener of bus.get(name) ?? []) listener(value); },
    },
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
  let header: Component | undefined;
  const ui = {
    theme,
    notify: (message: string) => notices.push(message),
    setHeader: (factory: ((tui: TUI, theme: Theme) => Component) | undefined) => { assert.ok(factory); calls.push("header"); header = factory(tui, theme); },
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
    pasteToEditor: (text: string) => { draft += text; calls.push("paste-command"); },
    select: async (_title: string, options: string[]) => { const choice = choices.shift(); assert(choice === undefined || options.includes(choice), `unexpected selection ${choice}`); return choice; },
    custom: async (factory: (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (value?: string) => void) => Component) => {
      let result: string | undefined;
      const component = factory(tui, theme, new KeybindingsManager(), value => { result = value; });
      const rows = () => component.render(100);
      if (!rows().join("\n").includes("Enter selects")) { inspected.push(rows().join("\n")); return; }
      const labels: string[] = [];
      for (let i = 0; i < 1100; i++) {
        const label = rows().find(row => row.trim().startsWith("› "))!.trim().slice(2);
        if (labels.at(-1) === label) break;
        labels.push(label); component.handleInput?.("\x1b[B");
      }
      const choice = await ui.select("Sidebar picker", labels);
      component.handleInput?.("\x1b[H");
      if (choice === undefined) component.handleInput?.("\x1b");
      else { for (let i = 0; i < labels.indexOf(choice); i++) component.handleInput?.("\x1b[B"); component.handleInput?.("\r"); }
      return result;
    },
  };
  const manager = SessionManager.inMemory(cwd);
  const ctx = { cwd, mode, ui, sessionManager: manager, getContextUsage: () => undefined, isIdle: () => true, isProjectTrusted: () => false } as unknown as ExtensionContext;
  piSlate(pi);
  const emit = async (type: string, extra: Record<string, unknown> = {}, context = ctx) => {
    let result: unknown;
    for (const handler of handlers.get(type) ?? []) result = await handler({ type, ...extra } as ExtensionEvent, context);
    return result;
  };
  t.after(() => emit("session_shutdown"));
  await emit("session_start");
  await Promise.resolve();
  assert.equal(Editor.prototype.insertTextAtCursor, originalInsert);
  assert.equal(Reflect.get(Editor.prototype, "handlePaste"), originalPaste);
  assert.equal(foreign.insertTextAtCursor, foreignInsert);
  return { calls, notices, commands, tools, emit, ctx, path, imagePath, chat, root, tui, composer, foreign, choices, inspected, extraCommands, bus, manager, draft: () => draft, eventBus: pi.events, header: () => header, setForeignEditor: () => { editorFactory = () => foreign; } };
}

for (const surfaces of [[], ["editor"], [...FRESH_SURFACES], [...SURFACES], ["header"], ["tool-cards"], ["sidebar"], ["transcript"], ["footer"]] as Surface[][]) {
  test(`selected set controls all installers: ${surfaces.join("+") || "none"}`, async (t) => {
    const f = await fixture(t, JSON.stringify({ version: 1, surfaces, focused: true }));
    for (const slot of ["header", "footer", "editor"] as const) assert.equal(f.calls.includes(slot), has(surfaces, slot), slot);
    assert.equal(f.calls.includes("widget"), has(surfaces, "sidebar") || has(surfaces, "transcript"));
    assert.equal(f.calls.includes("files-start"), false, "retired file dashboard has no git-status watcher");
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

const unstyled = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

test("Tokyo Night is an explicit default choice and preserves unrelated native settings", async t => {
  const f = await fixture(t, JSON.stringify({ surfaces: ["sidebar"] }));
  const settingsPath = join(dirname(f.path), "settings.json");
  await writeFile(settingsPath, JSON.stringify({ theme: "existing-theme", quietStartup: true, packages: ["keep-this-package"] }));
  const themes: string[] = [];
  t.mock.method(f.ctx.ui, "setTheme", (name: string) => { themes.push(name); return { success: true }; });
  await f.commands.get("slate")!.handler("theme default", f.ctx);
  assert.deepEqual(themes, ["tokyo-night"]);
  const saved = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.equal(saved.theme, "tokyo-night"); assert.equal(saved.quietStartup, true);
  assert.deepEqual(saved.packages, ["keep-this-package"]);
});

test("rail omits the command catalog; /slate session still inserts without disturbing a pinned preview", async t => {
  const f = await fixture(t, JSON.stringify({ surfaces: ["sidebar"], focused: false }));
  f.extraCommands.push({ name: "hello", source: "extension", sourceInfo: { path: "hello.ts", scope: "user" } });
  await f.emit("agent_settled");
  const sidebar = railOf(f);
  sidebar.setView({ id: "image:pinned", title: "pinned.png", invalidate() {}, render: () => ["preview"] });
  sidebar.pinImage();
  assert(!sidebar.render(40).map(unstyled).some(row => row.includes("Commands")));
  f.choices.push("/hello · extension");
  await f.commands.get("slate")!.handler("session commands", f.ctx);
  assert.equal(f.draft(), "existing draft/hello ");
  assert.equal(sidebar.currentViewId(), "image:pinned"); assert.equal(sidebar.isImagePinned(), true);
  assert(!f.calls.includes("branch-git"), "catalog must not execute commands");
});

test("dashboard uses live branch facts and session-scoped tasks; commands preserve existing drafts", async t => {
  const f = await fixture(t, JSON.stringify({ surfaces: ["sidebar"], focused: false, sidebarPercent: 30 }));
  const tui = f.tui; assert(tui instanceof TuiAltScreen);
  const rail = () => unstyled((Reflect.get(tui, "layoutRoot") as Component).render(140).join("\n"));
  f.manager.appendSessionInfo("Dashboard test");
  f.manager.appendMessage({ role: "user", content: "hi", timestamp: 0 });
  f.manager.appendMessage({ role: "assistant", api: "anthropic-messages", provider: "anthropic", model: "fixture", timestamp: 1, stopReason: "stop", content: [{ type: "text", text: "done" }], usage: { input: 100, output: 20, cacheRead: 300, cacheWrite: 50, totalTokens: 470, cost: { input: .1, output: .2, cacheRead: .03, cacheWrite: .02, total: .35 } } });
  await f.emit("session_info_changed");
  assert.match(rail(), /Dashboard test/); assert.match(rail(), /pid/); assert.match(rail(), /Input\s+450/); assert.match(rail(), /\$0.35/);
  assert(!/Summary|Activity Preview|Context\s*\n/.test(rail()));
  f.extraCommands.push({ name: "skill:review", source: "skill", sourceInfo: { path: "/skills/review/SKILL.md", scope: "user" } });
  await f.emit("message_end", { message: { role: "toolResult", toolName: "codemode", toolCallId: "outer", content: [], isError: false, nestedCalls: { calls: [{ id: "nested-read", name: "read", arguments: { path: "/skills/review/SKILL.md" }, status: "ok" }], complete: true } } });
  assert.match(rail(), /Skills · 1 loaded/, "nested successful reads update the live rail, not only restoration");
  const payload = { version: 1, source: "fixture", sessionId: f.manager.getSessionId(), tasks: [{ id: "native-1", label: "review", kind: "subagent", state: "waiting", startedAt: Date.now() }] };
  f.eventBus.emit("pi:background-tasks", payload); assert.match(rail(), /Tasks\s+1 live/);
  await f.emit("tool_execution_start", { toolCallId: "shell", toolName: "bash", args: { command: "npm run dev" } });
  assert.match(rail(), /Tasks\s+2 live/);
  await f.emit("tool_execution_end", { toolCallId: "shell", toolName: "bash", args: {}, content: [], isError: false });
  assert.match(rail(), /Tasks\s+1 live/);
  f.choices.push("1. review · waiting"); await f.commands.get("slate")!.handler("session tasks", f.ctx);
  assert.match(f.inspected.join("\n"), /native-1/);
  f.extraCommands.push({ name: "hello", source: "extension", sourceInfo: { path: "hello.ts", scope: "user" } });
  f.choices.push("/hello · extension"); await f.commands.get("slate")!.handler("session commands", f.ctx);
  assert.equal(f.draft(), "existing draft/hello "); assert.equal(f.calls.filter(x => x === "paste-command").length, 1);
  const next = { ...f.ctx, sessionManager: SessionManager.inMemory(f.ctx.cwd) };
  await f.emit("session_start", {}, next); assert.doesNotMatch(rail(), /Tasks\s+\d/);
  f.eventBus.emit("pi:background-tasks", payload); assert.doesNotMatch(rail(), /Tasks\s+\d/, "late old-owner snapshot stays invisible");
  await f.emit("session_shutdown", {}, next); assert.equal(f.bus.get("pi:background-tasks")!.size, 0);
});

test("fold saves merge current preferences and preserve externally corrupted settings", async t => {
  const f = await fixture(t, JSON.stringify({ surfaces: ["sidebar"] }));
  await writeFile(f.path, JSON.stringify({ version: 1, surfaces: ["sidebar", "editor"], focused: false, showPid: true, customPreference: "keep" }));
  f.choices.push("Expand sidebar section"); await f.commands.get("slate")!.handler("session mcp", f.ctx);
  const saved = JSON.parse(await readFile(f.path, "utf8"));
  assert.deepEqual(saved.surfaces, ["sidebar", "editor"]); assert.equal(saved.focused, false); assert.equal(saved.showPid, true); assert.equal(saved.customPreference, "keep");
  assert.deepEqual(saved.sidebarSections, { mcp: true });
  await writeFile(f.path, "{broken external edit");
  for (let i = 0; i < 2; i++) { f.choices.push("Collapse sidebar section"); await f.commands.get("slate")!.handler("session mcp", f.ctx); }
  assert.equal(await readFile(f.path, "utf8"), "{broken external edit"); assert.match(f.notices.join("\n"), /Settings file preserved/);
});

test("an MCP menu inspects the displayed snapshot, not a later refreshed resource at the same index", async t => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1000 }); t.after(() => t.mock.timers.reset());
  const f = await fixture(t, JSON.stringify({ surfaces: ["sidebar"] }));
  const path = join(dirname(f.path), "mcp.json"); await writeFile(path, '{"mcpServers":{"a":{"command":"a"}}}');
  let answer!: (choice: string) => void; const pending = new Promise<string>(resolve => { answer = resolve; });
  f.ctx.ui.select = async (_title, options) => { const choice = await pending; return options.find(value => value === choice); };
  const menu = f.commands.get("slate")!.handler("session mcp", f.ctx);
  await writeFile(path, '{"mcpServers":{"b":{"command":"new-b"}}}'); t.mock.timers.tick(5000);
  answer("1. a"); await menu;
  assert.equal(unstyled(f.inspected.at(-1)!).split("\n")[0]!.trim(), "a");
});

test("a stale command menu cannot insert into a new session; disposed clock cannot repaint", async t => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1000 }); t.after(() => t.mock.timers.reset());
  const f = await fixture(t, JSON.stringify({ surfaces: ["sidebar"], focused: false }));
  t.mock.method(f.tui, "requestRender", () => f.calls.push("render-request"));
  f.extraCommands.push({ name: "hello", source: "extension", sourceInfo: { path: "hello.ts", scope: "user" } });
  let answer!: (choice: string) => void; const pending = new Promise<string>(resolve => { answer = resolve; });
  f.ctx.ui.select = async (_title, options) => { const choice = await pending; return options.find(value => value === choice); };
  const menu = f.commands.get("slate")!.handler("session commands", f.ctx);
  const next = { ...f.ctx, sessionManager: SessionManager.inMemory(f.ctx.cwd) };
  await f.emit("session_start", {}, next); answer("/hello · extension"); await menu;
  assert.equal(f.draft(), "existing draft");
  await f.emit("session_shutdown", {}, next);
  const before = f.calls.length; t.mock.timers.tick(10000); assert.equal(f.calls.length, before);
});

function railOf(f: Awaited<ReturnType<typeof fixture>>): Sidebar {
  return (Reflect.get(Reflect.get(f.tui, "layoutRoot"), "entries") as Array<{ component: Sidebar }>)[1]!.component;
}

test("fold save preserves external sibling state, unknown section keys and unknown nested settings", async t => {
  const f = await fixture(t, JSON.stringify({ surfaces: ["sidebar"] }));
  await writeFile(f.path, JSON.stringify({ surfaces: ["sidebar"], sidebarSections: { skills: true, future: "keep" }, modelDisplay: { providerSuffix: true, future: "keep" }, unrelated: { nested: true } }));
  f.choices.push("Expand sidebar section"); await f.commands.get("slate")!.handler("session mcp", f.ctx);
  const saved = JSON.parse(await readFile(f.path, "utf8"));
  assert.deepEqual(saved.sidebarSections, { skills: true, future: "keep", mcp: true });
  assert.deepEqual(saved.modelDisplay, { providerSuffix: true, future: "keep" }); assert.deepEqual(saved.unrelated, { nested: true });
  assert.deepEqual(railOf(f).getFolds(), { skills: true, mcp: true });
});

test("pending Expand and Pin menu choices remain idempotent after mouse actions", async t => {
  const f = await fixture(t, JSON.stringify({ surfaces: ["sidebar"], focused: false })); const sidebar = railOf(f);
  const click = (label: string) => {
    const rows = sidebar.render(40).map(unstyled), y = rows.findIndex(row => row.includes(label)); assert(y >= 0);
    const x = label.startsWith("[") ? rows[y]!.indexOf(label) + 1 : 5;
    sidebar.handleMouse({ type: "click", button: "left", x, y, width: 40, height: 24, screenX: x, screenY: y, shift: false, alt: false, ctrl: false });
  };
  let answer!: (value: string) => void;
  f.ctx.ui.select = async () => new Promise(resolve => { answer = resolve; });
  const foldMenu = f.commands.get("slate")!.handler("session mcp", f.ctx);
  click("MCP"); assert.equal(sidebar.getFolds().mcp, true);
  answer("Expand sidebar section"); await foldMenu; assert.equal(sidebar.getFolds().mcp, true);
  sidebar.setView({ id: "image:fixture", filePath: f.imagePath, title: "Image", invalidate() {}, render: () => ["image"] });
  const imageMenu = f.commands.get("slate")!.handler("session image", f.ctx);
  sidebar.pinImage(); assert.equal(sidebar.isImagePinned(), true);
  answer("Pin"); await imageMenu; assert.equal(sidebar.isImagePinned(), true);
});

test("root yield stops dashboard clock/subscriptions and retained panes cannot repaint", async t => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1000 }); t.after(() => t.mock.timers.reset());
  const f = await fixture(t, JSON.stringify({ surfaces: ["sidebar"], focused: false })); const sidebar = railOf(f);
  t.mock.method(f.tui, "requestRender", () => f.calls.push("render-request"));
  const successor = new Text("successor", 0, 0); (f.tui as TuiAltScreen).setLayoutRoot(successor);
  assert.equal(sidebar.splitActive, false); assert.equal(f.bus.get("pi:background-tasks")!.size, 0);
  const before = f.calls.length;
  t.mock.timers.tick(10000); f.eventBus.emit("pi:background-tasks", { version: 1, source: "fixture", sessionId: f.manager.getSessionId(), tasks: [] });
  sidebar.tick(); sidebar.setTasks([]); sidebar.setHidden(true);
  await f.emit("agent_settled"); assert.equal(f.calls.length, before);
  await f.emit("session_shutdown"); assert.equal(Reflect.get(f.tui, "layoutRoot"), successor);
});

test("retained header and composer remain render-safe while later shutdown handlers await", async t => {
  const f = await fixture(t, JSON.stringify({ surfaces: ["header", "editor", "sidebar"], focused: false }));
  const retained = f.composer!, header = f.header()!;
  await f.emit("session_shutdown");
  assert.doesNotThrow(() => retained.render(100)); assert.deepEqual(header.render(100), []);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.doesNotThrow(() => retained.render(100)); assert.deepEqual(header.render(100), []);
  const next = { ...f.ctx, sessionManager: SessionManager.inMemory(f.ctx.cwd) }; await f.emit("session_start", {}, next);
  assert.doesNotThrow(() => retained.render(100));
});

test("receiver and 24-row renderer show current work before historical failures", async t => {
  const f = await fixture(t, JSON.stringify({ surfaces: ["sidebar"], focused: false }));
  f.eventBus.emit("pi:background-tasks", { version: 1, source: "subagents", sessionId: f.manager.getSessionId(), tasks: [
    { id: "failed-1", label: "historical failure 1", state: "failed", kind: "subagent", startedAt: Date.now() - 1000 },
    { id: "failed-2", label: "historical failure 2", state: "failed", kind: "subagent", startedAt: Date.now() - 500 },
    { id: "live", label: "currently running", state: "running", kind: "subagent", startedAt: Date.now() },
  ] });
  assert.match(unstyled(railOf(f).render(40).join("\n")), /currently running/);
});
