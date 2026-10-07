import test from "node:test";
import assert from "node:assert/strict";
import type { AgentSession, AgentSessionEventListener, ContextUsage, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { RunManager } from "../src/runs.ts";
import { contextEstimate, wrapSession } from "../src/session.ts";
import { formatContext, nextLive, rowText, SubagentWidget, syncWidget } from "../src/ui.ts";
import type { RunContext, RunRecord, Telemetry } from "../src/types.ts";
import { deferred, MemoryStore, plan, until } from "./helpers.ts";

const record = (id = "run-a"): RunRecord => ({
  id, owner: "owner", agent: "worker", mode: "inspect", task: "private task",
  cwd: "/repo", workspace: "/repo", model: "fixture/test", thinking: "off", state: "running",
  startedAt: "t", elapsedMs: 5000, metadataPath: "/run.json", pid: 12345,
  sessionId: "01a11744-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  contextUsage: { tokens: 32640, contextWindow: 272000, percent: 12 },
});
const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;
const tui = { requestRender() {} } as unknown as TUI;

test("context estimates preserve zero, unknown, invalid inputs, and overflow independently of billed usage", () => {
  const usage = (tokens: number | null, percent: number | null, contextWindow = 272000): ContextUsage => ({ tokens, percent, contextWindow });
  for (const invalid of [undefined, usage(null, null), usage(NaN, 12), usage(-1, 12), usage(5, Infinity), usage(5, -1), usage(5, null)]) {
    const estimate = contextEstimate(invalid, 272000);
    assert.equal(estimate.tokens, null);
    assert.equal(estimate.percent, null);
    assert.equal(formatContext({ ...record(), contextUsage: estimate }), "?%/272K");
  }
  for (const window of [0, -1, NaN, Infinity]) {
    assert.deepEqual(contextEstimate(usage(5, 1, window)), { tokens: null, contextWindow: null, percent: null });
    assert.equal(formatContext({ ...record(), contextUsage: usage(5, 1, window) }), "?%/?");
  }
  assert.equal(formatContext({ ...record(), contextUsage: contextEstimate(usage(0, 0)) }), "0%/272K");
  assert.equal(formatContext({ ...record(), contextUsage: contextEstimate(usage(300000, 110.3)) }), "110.3%/272K");
  assert.equal(formatContext({ ...record(), contextUsage: contextEstimate(usage(272001, 100.0001)) }), "100.1%/272K");
  assert.equal(formatContext({ ...record(), contextUsage: usage(0, 0, 1500000) }), "0%/1.5M");
  assert.equal(formatContext({ ...record(), contextUsage: undefined }), "?%/?");
});

test("native wrapper caches finalized estimates, ignores deltas, clears compaction unknown, and unsubscribes", async () => {
  let listener!: AgentSessionEventListener, scans = 0, stats = 0, unsubscribed = 0;
  let usage: ContextUsage | undefined = { tokens: 0, contextWindow: 272000, percent: 0 };
  const snapshots: Telemetry[] = [];
  const session = {
    sessionId: "native-session-not-run", model: { contextWindow: 272000 },
    subscribe: (fn: AgentSessionEventListener) => { listener = fn; return () => { unsubscribed++; }; },
    getContextUsage: () => { scans++; return usage; },
    getSessionStats: () => { stats++; throw new Error("not on telemetry path"); },
    abort: async () => {}, dispose() {},
  } as unknown as AgentSession;
  const context: RunContext = {
    signal: new AbortController().signal, directory: "/unused", own() {}, progress() {}, preview() {}, transcript() {}, ask: async () => "yes",
    telemetry: snapshot => snapshots.push(snapshot),
  };
  const subAgent = wrapSession(session, "private task", context);
  assert.equal(snapshots[0]!.sessionId, "native-session-not-run");
  assert.equal(snapshots[0]!.pid, process.pid);
  assert.equal(snapshots[0]!.contextUsage.percent, null, "empty startup is not misleading zero occupancy");
  for (let i = 0; i < 1000; i++) listener({ type: "message_update" } as Parameters<AgentSessionEventListener>[0]);
  await Promise.resolve();
  assert.equal(scans, 0);
  // SDK message_end precedes synchronous persistence: the scheduled scan must see the NEW value.
  listener({ type: "message_end", message: { role: "user", content: "task", timestamp: 0 } });
  usage = { tokens: 32640, contextWindow: 272000, percent: 12 };
  await Promise.resolve();
  assert.equal(snapshots.at(-1)!.contextUsage.percent, 12);
  listener({ type: "compaction_end", reason: "threshold", result: undefined, aborted: false, willRetry: false });
  usage = { tokens: null, contextWindow: 272000, percent: null };
  await Promise.resolve();
  assert.equal(snapshots.at(-1)!.contextUsage.percent, null);
  usage = { tokens: 0, contextWindow: 64000, percent: 0 };
  listener({ type: "turn_start" });
  listener({ type: "turn_end" } as Parameters<AgentSessionEventListener>[0]);
  await Promise.resolve();
  assert.deepEqual(snapshots.at(-1)!.contextUsage, usage);
  assert.equal(scans, 3, "same-stack boundary events coalesce");
  const widget = new SubagentWidget(tui, theme, () => {});
  widget.update([{ ...record(), ...snapshots.at(-1)! }], false);
  for (let i = 0; i < 100; i++) widget.render(40);
  assert.equal(scans, 3, "paint never queries the native session");
  listener({ type: "agent_settled" });
  await subAgent.dispose();
  await Promise.resolve();
  assert.equal(scans, 3, "queued callbacks do not retain disposed session activity");
  assert.equal(stats, 0);
  assert.equal(unsubscribed, 1);
});

test("deferred estimator and initial/scheduled observer failures stay display-only and recover", async () => {
  for (const observerThrows of [false, true]) {
    const store = new MemoryStore(), finish = deferred<void>();
    let listener!: AgentSessionEventListener, scans = 0, stats = 0, writes = 0, publications = 0, unsubscribed = 0;
    let estimatorThrows = false;
    const usage = { tokens: 640, contextWindow: 64000, percent: 1 };
    const save = store.save.bind(store);
    store.save = async value => { writes++; await save(value); };
    const session = {
      sessionId: "native-failure-fixture", model: { contextWindow: 64000 },
      messages: [{ role: "assistant", stopReason: "stop" }],
      subscribe: (fn: AgentSessionEventListener) => { listener = fn; return () => { unsubscribed++; }; },
      getContextUsage: () => { scans++; if (estimatorThrows) throw new Error("estimate failed"); return usage; },
      getSessionStats: () => { stats++; return { tokens: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0 }, cost: 0 }; },
      async prompt() { await finish.promise; listener({ type: "agent_settled" }); },
      getLastAssistantText: () => "Evidence report", abort: async () => {}, dispose() {},
    } as unknown as AgentSession;
    const manager = new RunManager({ owner: "owner", config: { ...DEFAULT_CONFIG }, store });
    const [id] = await manager.launch([plan(undefined, { start: async ctx => {
      const subAgent = wrapSession(session, "task", { ...ctx, telemetry: snapshot => {
        publications++;
        ctx.telemetry!(snapshot);
        if (observerThrows) throw new Error("display observer failed");
      } });
      ctx.own(subAgent);
      return subAgent;
    } })]);
    await until(() => manager.status(id!).state === "running");
    const before = writes;
    assert.equal(publications, 1, "initial observer failure does not abort startup");
    assert.deepEqual(manager.status(id!).contextUsage, { tokens: null, percent: null, contextWindow: 64000 });
    listener({ type: "turn_start" });
    await Promise.resolve();
    assert.deepEqual(manager.status(id!).contextUsage, usage);
    estimatorThrows = true;
    listener({ type: "turn_start" });
    await Promise.resolve();
    assert.deepEqual(manager.status(id!).contextUsage, { tokens: null, percent: null, contextWindow: 64000 }, "failure clears stale confident usage");
    estimatorThrows = false;
    listener({ type: "turn_start" });
    await Promise.resolve();
    assert.deepEqual(manager.status(id!).contextUsage, usage, "later finalized events recover");
    assert.equal(scans, 3);
    assert.equal(publications, 4, "scheduled observer errors do not disable future publications");
    assert.equal(stats, 0, "display never queries billed evidence");
    assert.equal(writes, before, "display does not write metadata");
    finish.resolve();
    await manager.settled(id!);
    assert.equal(manager.status(id!).state, "completed", manager.status(id!).error);
    assert.equal(store.reports.get(id!), "Evidence report");
    assert.equal(stats, 1, "evidence is collected only by final cleanup");
    assert.equal(writes, before + 1, "only final lifecycle metadata is added");
    assert.equal(unsubscribed, 1);
    const queries = scans;
    listener({ type: "turn_start" });
    await Promise.resolve();
    assert.equal(scans, queries, "disposed wrappers never query again");
    await manager.shutdown();
  }
});

test("disposing before a throwing queued estimate prevents the query entirely", async () => {
  let listener!: AgentSessionEventListener, scans = 0, publications = 0, unsubscribed = 0;
  const session = {
    sessionId: "disposed-fixture", model: { contextWindow: 64000 },
    subscribe: (fn: AgentSessionEventListener) => { listener = fn; return () => { unsubscribed++; }; },
    getContextUsage: () => { scans++; throw new Error("must not query"); },
    abort: async () => {}, dispose() {},
  } as unknown as AgentSession;
  const subAgent = wrapSession(session, "task", {
    signal: new AbortController().signal, directory: "/unused", own() {}, progress() {}, preview() {}, transcript() {}, ask: async () => "yes",
    telemetry: () => { publications++; throw new Error("optional observer"); },
  });
  listener({ type: "turn_start" });
  await subAgent.dispose();
  await Promise.resolve();
  assert.equal(scans, 0);
  assert.equal(publications, 1);
  assert.equal(unsubscribed, 1);
});

test("manager propagates latest copied snapshots without telemetry writes, retains final evidence, ignores late callbacks", async () => {
  const store = new MemoryStore(), finish = deferred<void>();
  let writes = 0, changes = 0, context!: RunContext;
  const save = store.save.bind(store);
  store.save = async value => { writes++; await save(value); };
  const manager = new RunManager({ owner: "owner", config: { ...DEFAULT_CONFIG }, store, changed: () => { changes++; } });
  const [id] = await manager.launch([plan(async ctx => { context = ctx; await finish.promise; return { report: "report", toolErrors: 0 }; })]);
  await until(() => !!context);
  const before = writes, changeBefore = changes;
  const snapshot: Telemetry = { pid: process.pid, sessionId: "native-full-id", contextUsage: { tokens: 1, percent: 1, contextWindow: 100 } };
  context.telemetry!(snapshot);
  context.telemetry!(snapshot);
  snapshot.contextUsage.tokens = 2;
  assert.equal(manager.status(id!).contextUsage!.tokens, 1, "cached data is copied");
  context.telemetry!({ ...snapshot, contextUsage: { tokens: 0, percent: 0, contextWindow: 200 } });
  assert.equal(writes, before);
  assert.equal(changes, changeBefore + 2, "identical snapshots do not refresh UI");
  finish.resolve();
  await manager.settled(id!);
  const final = manager.status(id!);
  assert.equal(final.sessionId, "native-full-id");
  assert.equal(final.pid, process.pid);
  assert.deepEqual(final.contextUsage, { tokens: 0, percent: 0, contextWindow: 200 });
  assert.deepEqual(store.records.get(id!)!.contextUsage, final.contextUsage);
  context.telemetry!({ ...snapshot, sessionId: "late-fake" });
  assert.deepEqual(manager.status(id!), final);
  await manager.shutdown();
});

test("cancelled startup never manufactures native identity; failed startup keeps already observed identity", async () => {
  for (const cancel of [true, false]) {
    const store = new MemoryStore(), startup = deferred<void>();
    let context!: RunContext;
    const manager = new RunManager({ owner: "owner", config: { ...DEFAULT_CONFIG }, store });
    const [id] = await manager.launch([plan(undefined, { start: async ctx => {
      context = ctx;
      if (cancel) await startup.promise;
      ctx.telemetry!({ pid: process.pid, sessionId: "observed-session", contextUsage: { tokens: null, percent: null, contextWindow: 64000 } });
      throw new Error("startup failed");
    } })]);
    await until(() => !!context);
    if (cancel) { const stop = manager.stop(id!); startup.resolve(); await stop; }
    await manager.settled(id!);
    const final = manager.status(id!);
    assert.equal(final.state, cancel ? "cancelled" : "failed");
    assert.equal(final.sessionId, cancel ? undefined : "observed-session");
    assert.equal(final.pid, process.pid);
    assert.equal(store.records.get(id!)!.sessionId, final.sessionId);
    await manager.shutdown();
  }
});

test("widget formats native IDs, shortens colliding prefixes, sanitizes, keeps context at narrow widths and routes exact runs", () => {
  const a = record(), b = { ...record("run-b"), sessionId: "01a11744-bbbb-bbbb-bbbb-bbbbbbbbbbbb" };
  assert.equal(rowText(a), "worker · PID-12345 01a11744… · 12%/272K");
  assert.equal(rowText({ ...a, sessionId: undefined, state: "starting", contextUsage: { tokens: null, percent: null, contextWindow: 272000 } }), "worker · PID-12345 starting · ?%/272K");
  assert.match(rowText(a, Infinity, [a, b]), /01a11744-a…/);
  assert.match(rowText(b, Infinity, [a, b]), /01a11744-b…/);
  const unsafe = { ...a, agent: "界".repeat(32) + "\u001b\n\u202e", sessionId: "native\u001b\n\u202e", question: { id: "q", message: "ask" } };
  for (const width of [1, 4, 10, 20, 30, 40, 80, 120]) {
    const text = rowText(unsafe, width);
    assert(visibleWidth(text) <= width);
    assert(!/[\u001b\n\u202e]/.test(stripTerminalSequences(text)));
    if (width >= 20) assert(text.includes("12%/272K") && text.includes("ask"));
  }
  const clicks: string[] = [];
  const widget = new SubagentWidget(tui, theme, id => clicks.push(id));
  widget.update([a, b], false);
  assert.equal(widget.render(80)[0], "↓  2");
  for (let i = 0; i < 50; i++) assert(widget.render(30).every(line => visibleWidth(line) <= 30));
  const mouse = { type: "click" as const, button: "left" as const, x: 0, screenX: 0, screenY: 0, width: 80, height: 3, shift: false, alt: false, ctrl: false };
  for (const y of [0, 1, 2, 3]) widget.handleMouse({ ...mouse, y });
  assert.deepEqual(clicks, ["run-a", "run-b"]);
  assert.equal(nextLive([a, b], a.id), b.id);
  widget.update([a], false, id => clicks.push("updated:" + id));
  widget.handleMouse({ ...mouse, y: 0 });
  assert.equal(clicks.at(-1), "updated:run-a");
});

test("settled widgets unmount, render is snapshot-only and never reads native telemetry", () => {
  let mounts = 0, clears = 0;
  const ctx = { mode: "tui", ui: { setWidget: (_key: string, factory?: (tui: TUI, theme: Theme) => SubagentWidget) => {
    if (factory) { mounts++; factory(tui, theme); } else clears++;
  } } } as unknown as ExtensionContext;
  const slot: { instance?: SubagentWidget } = {};
  const a = record();
  syncWidget(ctx, [a], false, () => {}, slot);
  for (let i = 0; i < 100; i++) slot.instance!.render(80);
  syncWidget(ctx, [{ ...a, state: "completed" }], false, () => {}, slot);
  assert.equal(mounts, 1);
  assert.equal(clears, 1);
  assert.equal(slot.instance, undefined);
});
