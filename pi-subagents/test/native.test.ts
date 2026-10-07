import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools,
  type AssistantMessageEventStream, type AssistantMessage, type Model, type Api, type TranscriptContext,
} from "@earendil-works/pi-ai";
import { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { FileArtifacts } from "../src/artifacts.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { loadProfiles } from "../src/agents.ts";
import { captureHead } from "../src/diff.ts";
import { RunManager } from "../src/runs.ts";
import { EDIT_TOOLS, INSPECT_TOOLS, prepareNative, type NativeOptions } from "../src/session.ts";
import type { Telemetry } from "../src/types.ts";
import { git } from "../src/workspace.ts";
import { temp, until } from "./helpers.ts";

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
function response(model: Model<Api>, content: AssistantMessage["content"], stopReason: Exclude<AssistantMessage["stopReason"], "pending"> = "stop", errorMessage = "fixture failure"): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content, usage: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 8, cost: { ...zero } },
    stopReason, timestamp: Date.now(), ...(stopReason === "error" ? { errorMessage } : {}),
  };
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    if (stopReason === "error" || stopReason === "aborted") stream.push({ type: "error", reason: stopReason, error: message });
    else stream.push({ type: "done", reason: stopReason, message });
    stream.end();
  });
  return stream;
}
async function fixture(t: Parameters<typeof temp>[0], handler?: (model: Model<Api>, context: TranscriptContext) => AssistantMessageEventStream) {
  const root = await temp(t), cwd = path.join(root, "repo"), agentDir = path.join(root, "agent");
  await mkdir(cwd); await mkdir(agentDir);
  // All credentials/settings are isolated fake data. No real model calls or network.
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
  const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: path.join(agentDir, "catalog.json"), refreshOnCreate: false });
  runtime.registerProvider("fixture", {
    api: "openai-completions", baseUrl: "http://invalid.test", apiKey: "fixture-not-a-secret",
    models: [{ id: "test", name: "Fixture", reasoning: false, input: ["text"], cost: zero, contextWindow: 64000, maxTokens: 2048 }],
    streamSimple: handler ?? ((model) => response(model, [{ type: "text", text: "An evidence-backed report." }])),
  });
  const profiles = await loadProfiles(agentDir, cwd, true);
  const options: NativeOptions = {
    agentDir, cwd, workspace: cwd, runtime, task: { agent: "reviewer", task: "Review fixture" },
    profile: profiles.get("reviewer")!, agentModel: "fixture/test", agentThinking: "off", scopedModels: [],
  };
  const store = new FileArtifacts(path.join(root, "runs"));
  const manager = new RunManager({ owner: "fixture-owner", config: { ...DEFAULT_CONFIG }, store });
  t.after(() => manager.shutdown());
  return { root, cwd, agentDir, runtime, options, manager, store, profiles };
}

test("real SDK: fresh read-only session, inherited instructions, no ambient tools/extensions/skills", async t => {
  let observed: TranscriptContext | undefined;
  const envBefore = { cwd: process.cwd(), subAgent: process.env.PI_SUBAGENT_SUB_AGENT };
  const f = await fixture(t, (model, context) => { observed = context; return response(model, [{ type: "text", text: "Review complete with evidence." }]); });
  await writeFile(path.join(f.agentDir, "AGENTS.md"), "GLOBAL_INSTRUCTIONS_FIXTURE");
  await writeFile(path.join(f.cwd, "AGENTS.md"), "PROJECT_INSTRUCTIONS_FIXTURE");
  await mkdir(path.join(f.agentDir, "extensions"));
  await writeFile(path.join(f.agentDir, "extensions", "forbidden.ts"), 'throw new Error("AMBIENT_EXTENSION_WAS_LOADED");');
  await mkdir(path.join(f.cwd, ".pi", "extensions"), { recursive: true });
  await writeFile(path.join(f.cwd, ".pi", "extensions", "forbidden.ts"), 'throw new Error("PROJECT_EXTENSION_WAS_LOADED");');
  await mkdir(path.join(f.agentDir, "skills", "forbidden"), { recursive: true });
  await writeFile(path.join(f.agentDir, "skills", "forbidden", "SKILL.md"), "---\nname: forbidden\ndescription: NEVER_LOAD_SKILL\n---\nsecret fixture");
  const [id] = await f.manager.launch([prepareNative(f.options)]);
  await f.manager.settled(id!);
  const result = f.manager.status(id!);
  assert.equal(result.state, "completed", result.error ?? "no error");
  assert(observed);
  assert.deepEqual(getCurrentTools(observed.messages).map(tool => tool.name).sort(), [...INSPECT_TOOLS].sort());
  const prompt = getCurrentSystemPrompt(observed.messages);
  assert.match(prompt, /GLOBAL_INSTRUCTIONS_FIXTURE/);
  assert.match(prompt, /PROJECT_INSTRUCTIONS_FIXTURE/);
  assert.match(prompt, /sub-agent/);
  assert(!prompt.includes("NEVER_LOAD_SKILL"));
  assert.equal(observed.messages.filter(message => message.role === "user").length, 1);
  assert.equal(result.usage?.input, 5);
  const header = JSON.parse((await readFile(result.sessionPath!, "utf8")).split("\n")[0]!);
  assert.equal(result.sessionId, header.id, "native session identity comes from Pi, not the run manager");
  assert.notEqual(result.sessionId, id);
  assert.equal(result.pid, process.pid, "native sub-agents share the owning process");
  assert.equal(result.contextUsage?.contextWindow, 64000);
  assert.equal(result.contextUsage?.tokens, 8, "latest response context, not cumulative billing");
  assert.equal(result.contextUsage?.percent, 8 / 64000 * 100);
  const saved = JSON.parse(await readFile(result.metadataPath, "utf8"));
  assert.equal(saved.sessionId, header.id);
  assert.deepEqual(saved.contextUsage, result.contextUsage);
  assert.match(await readFile(result.reportPath!, "utf8"), /Review complete/);
  assert.match(await readFile(result.sessionPath!, "utf8"), /Review complete/);
  assert(f.manager.preview(id!).some(line => line.startsWith("you")));
  assert(f.manager.preview(id!).some(line => line.includes("Review complete")));
  assert.deepEqual({ cwd: process.cwd(), subAgent: process.env.PI_SUBAGENT_SUB_AGENT }, envBefore);
});

test("real SDK: worker tools differ, no model/scoped/thinking fallback", async t => {
  let names: string[] = [];
  const f = await fixture(t, (model, context) => { names = getCurrentTools(context.messages).map(tool => tool.name); return response(model, [{ type: "text", text: "Worker evidence" }]); });
  const options = { ...f.options, task: { agent: "worker", task: "Implement fixture" }, profile: f.profiles.get("worker")! };
  const [id] = await f.manager.launch([prepareNative(options)]);
  await f.manager.settled(id!);
  assert.equal(f.manager.status(id!).state, "completed", f.manager.status(id!).error ?? "no error");
  assert.deepEqual(names.sort(), [...EDIT_TOOLS].sort());
  assert.throws(() => prepareNative({ ...options, task: { ...options.task, model: "fixture/missing" } }), /unavailable/);
  assert.throws(() => prepareNative({ ...options, scopedModels: ["different/provider"] }), /scope/);
  assert.throws(() => prepareNative({ ...options, agentThinking: "high" }), /unsupported/);
  assert.throws(() => prepareNative({ ...options, agentThinking: "off", task: { ...options.task, thinking: "high" } }), /unsupported/);
  assert.equal(prepareNative({ ...options, agentThinking: "off", task: { ...options.task, thinking: "off" } }).thinking, "off");
});

test("real SDK: two inspectors have isolated cwd and task context", async t => {
  const prompts: string[] = [];
  const f = await fixture(t, (model, context) => { prompts.push(JSON.stringify(context.messages)); return response(model, [{ type: "text", text: "Isolated report" }]); });
  const otherCwd = path.join(f.root, "other"); await mkdir(otherCwd);
  await writeFile(path.join(f.cwd, "AGENTS.md"), "ONLY_WORKSPACE_A");
  await writeFile(path.join(otherCwd, "AGENTS.md"), "ONLY_WORKSPACE_B");
  const ids = await f.manager.launch([
    prepareNative({ ...f.options, task: { agent: "reviewer", task: "ONLY_TASK_A" } }),
    prepareNative({ ...f.options, cwd: otherCwd, workspace: otherCwd, task: { agent: "reviewer", task: "ONLY_TASK_B" } }),
  ]);
  await Promise.all(ids.map(id => f.manager.settled(id)));
  assert(ids.every(id => f.manager.status(id).state === "completed"), JSON.stringify(f.manager.list()));
  const records = ids.map(id => f.manager.status(id));
  assert.equal(new Set(records.map(run => run.sessionId)).size, 2);
  assert(records.every(run => run.sessionId && run.sessionId !== run.id && run.pid === process.pid));
  assert.equal(prompts.length, 2);
  const a = prompts.find(prompt => prompt.includes("ONLY_TASK_A"))!;
  const b = prompts.find(prompt => prompt.includes("ONLY_TASK_B"))!;
  assert(a.includes("ONLY_WORKSPACE_A") && !a.includes("ONLY_WORKSPACE_B") && !a.includes("ONLY_TASK_B"));
  assert(b.includes("ONLY_WORKSPACE_B") && !b.includes("ONLY_WORKSPACE_A") && !b.includes("ONLY_TASK_A"));
});

test("real SDK: contact_agent round trip and run-owned reply", async t => {
  let calls = 0;
  const f = await fixture(t, (model, context) => {
    if (++calls === 1) return response(model, [{ type: "toolCall", id: "ask-1", name: "contact_agent", arguments: { message: "Which implementation?" } }], "toolUse");
    assert(JSON.stringify(context.messages).includes("Use the existing API"));
    return response(model, [{ type: "text", text: "Report after agent answer" }]);
  });
  const [id] = await f.manager.launch([prepareNative(f.options)]);
  await until(() => f.manager.status(id!).state === "waiting_for_agent");
  await until(() => f.manager.status(id!).contextUsage?.tokens != null);
  assert.equal(f.manager.status(id!).contextUsage!.contextWindow, 64000);
  await f.manager.reply(id!, f.manager.status(id!).question!.id, "Use the existing API");
  await f.manager.settled(id!);
  assert.equal(f.manager.status(id!).state, "completed", f.manager.status(id!).error ?? "no error");
  assert.equal(calls, 2);
  assert.equal(f.manager.status(id!).usage!.input, 10, "billing stays cumulative");
  assert.equal(f.manager.status(id!).contextUsage!.tokens, 8, "occupancy uses latest response only");
});

test("real SDK: provider errors and empty output cannot succeed", async t => {
  for (const fail of [true, false]) {
    const f = await fixture(t, model => response(model, fail ? [{ type: "text", text: "" }] : [], fail ? "error" : "stop"));
    const [id] = await f.manager.launch([prepareNative(f.options)]);
    await f.manager.settled(id!);
    assert.equal(f.manager.status(id!).state, "failed", JSON.stringify(f.manager.status(id!)));
  }
});

test("real SDK: disabled shell calls cannot mutate a review workspace", async t => {
  let calls = 0;
  const f = await fixture(t, model => ++calls === 1
    ? response(model, [{ type: "toolCall", id: "bad-shell", name: "bash", arguments: { command: "touch FORBIDDEN" } }], "toolUse")
    : response(model, [{ type: "text", text: "The shell tool was unavailable; report inspection limitations." }]));
  const [id] = await f.manager.launch([prepareNative(f.options)]);
  await f.manager.settled(id!);
  assert.equal(f.manager.status(id!).state, "completed", f.manager.status(id!).error ?? "no error");
  assert.equal(f.manager.status(id!).toolErrors, 1);
  await assert.rejects(readFile(path.join(f.cwd, "FORBIDDEN")));
});

test("real SDK: intermediate agent_end during retry is not final completion", async t => {
  let calls = 0;
  const f = await fixture(t, model => ++calls === 1
    ? response(model, [], "error", "429 Too Many Requests")
    : response(model, [{ type: "text", text: "Recovered with the same model." }]));
  await writeFile(path.join(f.agentDir, "settings.json"), JSON.stringify({
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 10 },
    compaction: { enabled: false },
  }));
  const [id] = await f.manager.launch([prepareNative(f.options)]);
  await f.manager.settled(id!);
  assert.equal(calls, 2);
  assert.equal(f.manager.status(id!).state, "completed", f.manager.status(id!).error ?? "no error");
  assert.match(await readFile(f.manager.status(id!).reportPath!, "utf8"), /same model/);
});

test("real SDK: stopping bash cancels its process tree before releasing workspace", { skip: process.platform === "win32" }, async t => {
  let calls = 0;
  const f = await fixture(t, model => {
    if (++calls === 1) return response(model, [{ type: "toolCall", id: "bash-1", name: "bash", arguments: { command: "sleep 30 & echo $! > child.pid; wait" } }], "toolUse");
    return response(model, [{ type: "text", text: "Should not continue after stop" }]);
  });
  const [id] = await f.manager.launch([prepareNative({ ...f.options, task: { agent: "worker", task: "Fixture cancellation" }, profile: f.profiles.get("worker")! })]);
  await until(() => f.manager.status(id!).currentTool === "bash");
  let pid: number | undefined;
  for (let i = 0; i < 100; i++) {
    try { pid = Number((await readFile(path.join(f.cwd, "child.pid"), "utf8")).trim()); if (pid) break; } catch { /* Shell has not written its PID yet. */ }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert(pid && pid > 1);
  await f.manager.stop(id!);
  assert.equal(f.manager.status(id!).state, "cancelled", f.manager.status(id!).error ?? "no error");
  await until(() => { try { process.kill(pid!, 0); return false; } catch { return true; } });
  assert.equal(f.manager.activeCount, 0);
  assert((f.manager.status(id!).usage?.input ?? 0) >= 5, "cancellation retains usage before disposal");
  const final = f.manager.status(id!);
  assert(final.sessionId && final.sessionId !== final.id);
  assert.equal(final.pid, process.pid);
  assert.equal(final.contextUsage?.contextWindow, 64000);
  assert.equal(JSON.parse(await readFile(final.metadataPath, "utf8")).sessionId, final.sessionId);
});

test("real SDK: committed-range review reads a supplied artifact; live diff is launch HEAD", async t => {
  let calls = 0, artifact = "", sawEmptyWorkingTree = false, sawArtifact = false;
  const f = await fixture(t, (model, context) => {
    const n = ++calls;
    if (n === 1) return response(model, [{ type: "toolCall", id: "d1", name: "diff", arguments: {} }], "toolUse");
    if (n === 2) {
      sawEmptyWorkingTree = JSON.stringify(context.messages).includes("No working-tree changes");
      return response(model, [{ type: "toolCall", id: "r1", name: "read", arguments: { path: artifact } }], "toolUse");
    }
    sawArtifact = JSON.stringify(context.messages).includes("+after");
    return response(model, [{ type: "text", text: "Reviewed the supplied diff artifact. Working-tree diff against launch HEAD was empty." }]);
  });
  await git(f.cwd, ["init", "-q"]);
  await writeFile(path.join(f.cwd, "tracked.txt"), "before\n");
  await git(f.cwd, ["add", "tracked.txt"]);
  await git(f.cwd, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"]);
  const baseline = await captureHead(f.cwd);
  await writeFile(path.join(f.cwd, "tracked.txt"), "after\n");
  await git(f.cwd, ["add", "tracked.txt"]);
  await git(f.cwd, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "change"]);
  artifact = path.join(f.root, "review.diff");
  await writeFile(artifact, await git(f.cwd, ["diff", baseline!, "HEAD"]));
  const [id] = await f.manager.launch([prepareNative({ ...f.options, task: { agent: "reviewer", task: `Review ${artifact}` } })]);
  await f.manager.settled(id!);
  assert.equal(f.manager.status(id!).state, "completed", f.manager.status(id!).error ?? "no error");
  assert.equal(calls, 3);
  assert(sawEmptyWorkingTree);
  assert(sawArtifact);
});

test("real SDK: append instructions are inherited with Pi's project precedence", async t => {
  let prompt = "";
  const f = await fixture(t, (model, context) => {
    prompt = getCurrentSystemPrompt(context.messages);
    return response(model, [{ type: "text", text: "Report with inherited append policy" }]);
  });
  await writeFile(path.join(f.agentDir, "APPEND_SYSTEM.md"), "GLOBAL_APPEND_POLICY");
  const [global] = await f.manager.launch([prepareNative(f.options)]);
  await f.manager.settled(global!);
  assert.match(prompt, /GLOBAL_APPEND_POLICY/);
  assert.match(prompt, /sub-agent/);
  await mkdir(path.join(f.cwd, ".pi"));
  await writeFile(path.join(f.cwd, ".pi", "APPEND_SYSTEM.md"), "PROJECT_APPEND_POLICY");
  const [project] = await f.manager.launch([prepareNative(f.options)]);
  await f.manager.settled(project!);
  assert.match(prompt, /PROJECT_APPEND_POLICY/);
  assert(!prompt.includes("GLOBAL_APPEND_POLICY"));
  assert.match(prompt, /sub-agent/);
});

test("real SDK: startup cleanup failure fences the manager instead of releasing its workspace", async t => {
  const f = await fixture(t);
  const { bindExtensions, abort, dispose } = AgentSession.prototype;
  try {
    AgentSession.prototype.bindExtensions = async () => { throw new Error("Startup binding failed"); };
    AgentSession.prototype.abort = async () => { throw new Error("Startup abort unconfirmed"); };
    AgentSession.prototype.dispose = function () { dispose.call(this); throw new Error("Startup disposal unconfirmed"); };
    const [id] = await f.manager.launch([prepareNative(f.options)]);
    await f.manager.settled(id!);
    const failedStart = f.manager.status(id!);
    assert.equal(failedStart.state, "cleanup_unknown");
    assert(failedStart.sessionId && failedStart.sessionId !== id);
    assert.equal(failedStart.pid, process.pid);
    assert.equal(JSON.parse(await readFile(failedStart.metadataPath, "utf8")).sessionId, failedStart.sessionId);
    assert.equal(f.manager.activeCount, 1);
    await assert.rejects(f.manager.launch([prepareNative(f.options)]), /unknown cleanup/);
  } finally {
    AgentSession.prototype.bindExtensions = bindExtensions;
    AgentSession.prototype.abort = abort;
    AgentSession.prototype.dispose = dispose;
  }
});

test("real SDK: failed runs retain reported usage without undeclared token totals", async t => {
  const f = await fixture(t, model => response(model, [], "error"));
  const [id] = await f.manager.launch([prepareNative(f.options)]);
  await f.manager.settled(id!);
  const record = f.manager.status(id!);
  assert.equal(record.state, "failed");
  assert.deepEqual(record.usage, { input: 5, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0 });
});

test("real SDK: throwing initial and scheduled telemetry observers do not fail startup or prompt", async t => {
  const f = await fixture(t);
  const snapshots: Telemetry[] = [];
  let subAgent: Awaited<ReturnType<ReturnType<typeof prepareNative>["start"]>> | undefined;
  try {
    subAgent = await prepareNative(f.options).start({
      signal: new AbortController().signal, directory: path.join(f.root, "observer-run"),
      own() {}, progress() {}, preview() {}, transcript() {}, ask: async () => "answer",
      telemetry: snapshot => { snapshots.push(snapshot); throw new Error("optional display failed"); },
    });
    assert.equal(snapshots[0]!.sessionId, undefined, "selected model limit is published before SDK startup");
    assert.deepEqual(snapshots[0]!.contextUsage, { tokens: null, percent: null, contextWindow: 64000 });
    assert(snapshots.some(snapshot => snapshot.sessionId), "native identity publication survives observer failure");
    assert.match((await subAgent.prompt()).report, /evidence-backed/);
    assert.equal(snapshots.at(-1)!.contextUsage.tokens, 8);
  } finally { await subAgent?.dispose(); }
});

test("real SDK: compaction event publishes unknown occupancy until a post-compaction response", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.agentDir, "settings.json"), JSON.stringify({
    retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 0 },
  }));
  let native!: AgentSession;
  const observe = (session: AgentSession) => { native = session; };
  const original = AgentSession.prototype.bindExtensions;
  const snapshots: Telemetry[] = [];
  let subAgent: Awaited<ReturnType<ReturnType<typeof prepareNative>["start"]>> | undefined;
  try {
    AgentSession.prototype.bindExtensions = function (bindings) { observe(this); return original.call(this, bindings); };
    subAgent = await prepareNative(f.options).start({
      signal: new AbortController().signal, directory: path.join(f.root, "compaction-run"),
      own() {}, progress() {}, preview() {}, transcript() {}, ask: async () => "answer",
      telemetry: snapshot => snapshots.push(snapshot),
    });
  } finally { AgentSession.prototype.bindExtensions = original; }
  try {
    await subAgent!.prompt();
    assert.equal(snapshots.at(-1)!.contextUsage.tokens, 8);
    await native.compact();
    await Promise.resolve();
    assert.equal(snapshots.at(-1)!.contextUsage.tokens, null);
    assert.equal(snapshots.at(-1)!.contextUsage.percent, null);
    assert.equal(snapshots.at(-1)!.contextUsage.contextWindow, 64000);
    await subAgent!.prompt();
    assert.equal(snapshots.at(-1)!.contextUsage.tokens, 8);
    assert.equal(snapshots.at(-1)!.sessionId, native.sessionManager.getSessionId());
  } finally { await subAgent?.dispose(); }
});
