import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionToolContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import register from "../index.ts";
import { Check } from "typebox/value";
import { DESCRIPTION, OutputSchema, Parameters, presentFinished, presentLaunch, presentRun, presentSummary, resultPreview } from "../src/tool.ts";
import type { RunRecord } from "../src/types.ts";
import { temp } from "./helpers.ts";

test("extension registers one tool/command; rejects unknown/headless/untrusted/foreign actions; unloads cleanly", async t => {
  const root = await temp(t);
  const before = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  t.after(() => { if (before === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = before; });
  await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  await writeFile(path.join(process.env.PI_CODING_AGENT_DIR, "settings.json"), "{}");
  const tools: ToolDefinition[] = [];
  const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
  const hooks = new Map<string, () => Promise<void>>();
  const notifications: string[] = [];
  const api = {
    registerTool: (tool: ToolDefinition) => tools.push(tool),
    registerCommand: (name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) => commands.set(name, command),
    on: (event: string, handler: () => Promise<void>) => { hooks.set(event, handler); return () => {}; },
    getThinkingLevel: () => "off", appendEntry: () => {}, sendMessage: () => {},
  } as unknown as ExtensionAPI;
  register(api);
  assert.deepEqual(tools.map(tool => tool.name), ["subagent"]);
  assert.equal(tools[0]!.exposure, "direct");
  assert.equal(tools[0]!.outputSchema, OutputSchema);
  assert.equal(tools[0]!.parameters, Parameters);
  assert.equal(JSON.parse(JSON.stringify(tools[0]!.parameters)).type, "object");
  assert.deepEqual([...commands.keys()], ["subagents"]);
  const ctx = {
    mode: "tui", hasUI: true, cwd: root,
    sessionManager: SessionManager.create(root, path.join(root, "sessions")),
    isProjectTrusted: () => true, scopedModels: [],
    ui: { setWidget() {}, notify: (message: string) => notifications.push(message) },
  } as unknown as ExtensionToolContext;
  const run = (params: unknown, context = ctx) => tools[0]!.execute("test-call", params, undefined, undefined, context);
  await assert.rejects(run({ action: "run", workflow: true }), /unsupported field/);
  await assert.rejects(run({ action: "list" }, { ...ctx, mode: "print" }), /interactive npm Pi/);
  await assert.rejects(run({ action: "list" }, { ...ctx, mode: "rpc" }), /interactive npm Pi/);
  const result = await run({ action: "list" });
  assert.deepEqual((result.details as { name: string }[]).map(profile => profile.name), ["reviewer", "worker"]);
  assert.deepEqual(result.structuredContent, result.details);
  assert(Check(OutputSchema, result.structuredContent));
  const target = path.join(root, "target");
  await mkdir(path.join(target, ".pi", "agents"), { recursive: true });
  await writeFile(path.join(target, ".pi", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: Target-specific role\nmode: edit\n---\nTarget role\n");
  const targetList = await run({ action: "list", cwd: target });
  assert.equal((targetList.structuredContent as { name: string; mode: string }[]).find(role => role.name === "reviewer")!.mode, "edit");
  await assert.rejects(run({ action: "run", tasks: [{ agent: "worker", task: "Do work" }] }, { ...ctx, isProjectTrusted: () => false }), /Trust the agent/);
  await assert.rejects(run({ action: "status", id: "foreign-id" }), /Unknown run ID/);
  await assert.rejects(run({ action: "list" }, { ...ctx, sessionManager: SessionManager.create(root) }), /ownership/);
  await hooks.get("session_shutdown")!();
  const status = await run({ action: "status" });
  assert.deepEqual(status.details, { runs: [] });
  await hooks.get("session_before_tree")!();
  assert.deepEqual(notifications, []);
  await commands.get("subagents")!.handler("", ctx as unknown as ExtensionCommandContext);
  assert.deepEqual(notifications, ["No runs in this agent runtime."]);
  await commands.get("subagents")!.handler("", { ...ctx, mode: "rpc" } as unknown as ExtensionCommandContext);
  assert.match(notifications[1]!, /interactive npm Pi/);
  await hooks.get("session_shutdown")!();
  const key = Symbol.for("@gagansd/pi-subagents/cleanup-unknown");
  const processHealth = globalThis as typeof globalThis & { [key]?: unknown };
  const beforeHealth = processHealth[key];
  try {
    const cause = { id: "old-run", metadataPath: "/private/old-run/run.json" };
    processHealth[key] = cause;
    register(api); // New extension instance, not restored execution authority.
    const reloaded = await tools[1]!.execute("test-reload", { action: "status" }, undefined, undefined, ctx);
    assert.deepEqual(reloaded.structuredContent, { runs: [], blocked: cause });
    assert(Check(OutputSchema, reloaded.structuredContent));
    await assert.rejects(tools[1]!.execute("test-block", { action: "run", tasks: [{ agent: "worker", task: "Must not start" }] }, undefined, undefined, ctx), /old-run\/run.json/);
    await hooks.get("session_shutdown")!();
  } finally {
    if (beforeHealth === undefined) delete processHealth[key]; else processHealth[key] = beforeHealth;
  }
});

const record: RunRecord = {
  id: "id", owner: "p", agent: "worker", mode: "edit", task: "Add feature A",
  cwd: "/wt-a", workspace: "/wt-a", model: "fixture/test", thinking: "off", state: "starting",
  startedAt: "t", elapsedMs: 0, metadataPath: "/run.json",
};

test("action views are allowlisted and match the closed output schema", () => {
  const enriched = { ...record, futureInternalField: "Must not leak", usage: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0, cost: 1 } };
  const receipt = presentLaunch([enriched]);
  assert.deepEqual(receipt, { runs: [{ id: "id", cwd: "/wt-a", workspace: "/wt-a", model: "fixture/test", thinking: "off" }] });
  assert.deepEqual(presentRun(enriched), { id: "id", state: "starting", metadataPath: "/run.json", model: "fixture/test", thinking: "off" });
  const finished = presentFinished({ ...enriched, state: "completed", reportPath: "/report.md" });
  assert.deepEqual(finished, { id: "id", state: "completed", agent: "worker", taskPreview: "Add feature A", reportPath: "/report.md" });
  for (const result of [receipt, presentRun(enriched), finished, { runs: [presentSummary(record)] }, { ok: true }]) {
    assert(Check(OutputSchema, result));
    assert(!resultPreview(result).includes("futureInternalField"));
    assert(resultPreview(result).length < 300);
  }
  assert(!Check(OutputSchema, { ...finished, owner: "p" }));
  assert(DESCRIPTION.length < 1200);
  assert(JSON.stringify(OutputSchema).length < 3000);
});

test("large fields disclose truncation without corrupting JSON or losing run IDs", () => {
  const output = resultPreview({ output: "x".repeat(100000) });
  assert(output.length < 24000);
  assert.equal(JSON.parse(output).truncated, true);
  assert.match(output, /structuredContent/);
  const view = presentRun({ ...record, question: { id: "question", message: "x".repeat(8192) }, error: "x".repeat(4000) });
  assert(view.truncated);
  assert.equal(view.metadataPath, "/run.json");
  assert(JSON.stringify(view).length < 3000);
  const receipt = presentLaunch(Array.from({ length: 4 }, (_, i) => ({ ...record, id: "run-" + i, cwd: "x".repeat(4096), workspace: "y".repeat(4096) })));
  const preview = JSON.parse(resultPreview(receipt));
  assert.equal(preview.truncated, true);
  assert.deepEqual(preview.runs.map((run: { id: string }) => run.id), receipt.runs.map(run => run.id));
  assert.equal(receipt.runs[0]!.cwd.length, 4096, "structured result is not mutated or shortened");
  const unsafe = presentRun({ ...record, question: { id: "q", message: "\u202e\u0085Which API?" } });
  const encoded = resultPreview(unsafe);
  assert(!encoded.includes("\u202e") && !encoded.includes("\u0085"));
  assert.deepEqual(JSON.parse(encoded), unsafe, "display escaping must preserve exact string values");
});

test("draw rebinds Down after the host editor remounts", async t => {
  const root = await temp(t);
  const before = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  t.after(() => { if (before === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = before; });
  await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  await writeFile(path.join(process.env.PI_CODING_AGENT_DIR, "settings.json"), "{}");
  const tools: ToolDefinition[] = [];
  let active = true, binds = 0;
  register({
    registerTool: (tool: ToolDefinition) => tools.push(tool),
    registerCommand() {},
    on() { return () => {}; },
    getThinkingLevel: () => "off", appendEntry() {}, sendMessage() {},
    events: {
      emit(name: string, request: { version: number; accept: (host: unknown) => void }) {
        if (name !== "subagent:ui-host-request") return;
        request.accept({
          version: 1,
          isActive: () => active,
          focusEditor() {},
          bindDown() { binds++; return () => {}; },
        });
      },
    },
  } as unknown as ExtensionAPI);
  const ctx = {
    mode: "tui", cwd: root, isProjectTrusted: () => true, scopedModels: [],
    sessionManager: SessionManager.create(root, path.join(root, "sessions")),
    ui: { setWidget() {}, notify() {} },
  } as unknown as ExtensionToolContext;
  await tools[0]!.execute("rebind-1", { action: "list" }, undefined, undefined, ctx);
  assert.equal(binds, 1);
  active = false;
  await tools[0]!.execute("rebind-2", { action: "list" }, undefined, undefined, ctx);
  assert.ok(binds >= 2, "draw must rebind after the previous host goes inactive");
});
