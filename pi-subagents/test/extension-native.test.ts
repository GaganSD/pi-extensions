import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager, type ExtensionAPI, type ExtensionToolContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import register from "../index.ts";
import { OutputSchema } from "../src/tool.ts";
import type { RunRecord } from "../src/types.ts";
import { temp, until } from "./helpers.ts";

test("public tool: native launch/question/reply/completion stay compact while exact details retain evidence", async t => {
  const root = await temp(t), agentDir = path.join(root, "agent"), cwd = path.join(root, "repo");
  await mkdir(agentDir); await mkdir(cwd);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
  const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let calls = 0;
  runtime.registerProvider("fixture", {
    api: "openai-completions", baseUrl: "http://invalid.test", apiKey: "fake-only",
    models: [{ id: "test", name: "Fixture", reasoning: false, input: ["text"], cost, contextWindow: 64000, maxTokens: 2048 }],
    streamSimple(model, context) {
      const asking = ++calls === 1;
      if (!asking) assert(JSON.stringify(context.messages).includes("Use existing API"));
      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: asking ? [{ type: "toolCall", id: "ask", name: "contact_agent", arguments: { message: "Which API?" } }]
          : [{ type: "text", text: "Bounded report after the agent reply." }],
        usage: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 8, cost },
        stopReason: asking ? "toolUse" : "stop", timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: asking ? "toolUse" : "stop", message });
        stream.end();
      });
      return stream;
    },
  });
  const previousDir = process.env.PI_CODING_AGENT_DIR, create = ModelRuntime.create;
  const hooks = new Map<string, () => Promise<void>>(), notices: string[] = [];
  const snapshots: Array<{ sessionId: string; tasks: Array<{ id: string; state: string }> }> = [];
  const bus = new Map<string, (value: unknown) => void>();
  let tool!: ToolDefinition;
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    ModelRuntime.create = async () => runtime; // The host's only model calls use the isolated fake provider.
    register({
      registerTool: (value: ToolDefinition) => { tool = value; }, registerCommand() {},
      on: (name: string, handler: () => Promise<void>) => { hooks.set(name, handler); return () => {}; },
      getThinkingLevel: () => "off", appendEntry() {},
      sendMessage: (message: { content: string }) => { notices.push(message.content); },
      events: {
        on(name: string, handler: (value: unknown) => void) { bus.set(name, handler); return () => bus.delete(name); },
        emit(name: string, value: unknown) { if (name === "pi:background-tasks") snapshots.push(value as typeof snapshots[number]); },
      },
    } as unknown as ExtensionAPI);
    const ctx = { cwd, mode: "tui", isProjectTrusted: () => true, scopedModels: [],
      sessionManager: SessionManager.inMemory(cwd), ui: { setWidget() {} },
    } as unknown as ExtensionToolContext;
    const execute = (input: unknown) => tool.execute("public-call", input, undefined, undefined, ctx);
    const launch = await execute({ action: "run", tasks: [{ agent: "reviewer", task: "PRIVATE_TASK_BRIEF", model: "fixture/test" }] });
    assert(Check(OutputSchema, launch.structuredContent));
    const { runs: [receipt] } = launch.structuredContent as { runs: { id: string; cwd: string; workspace: string; model: string; thinking: string }[] };
    assert.deepEqual(Object.keys(receipt!).sort(), ["cwd", "id", "model", "thinking", "workspace"]);
    assert.equal(receipt!.model, "fixture/test");
    assert.equal(receipt!.thinking, "off");
    await until(() => notices.some(message => message.startsWith("Sub-agent question")));
    const waiting = await execute({ action: "status", id: receipt!.id });
    assert(Check(OutputSchema, waiting.structuredContent));
    assert(snapshots.some(snapshot => snapshot.sessionId === ctx.sessionManager.getSessionId() && snapshot.tasks.some(task => task.id === receipt!.id && task.state === "waiting")));
    const countBeforeRequest = snapshots.length;
    bus.get("pi:background-tasks:request")?.({ version: 1, sessionId: "foreign" });
    assert.equal(snapshots.length, countBeforeRequest, "foreign request does not leak owner snapshots");
    bus.get("pi:background-tasks:request")?.({ version: 1, sessionId: ctx.sessionManager.getSessionId() });
    assert.equal(snapshots.length, countBeforeRequest + 1);
    const question = (waiting.structuredContent as { question: { id: string } }).question;
    const reply = await execute({ action: "reply", id: receipt!.id, requestId: question.id, message: "Use existing API" });
    assert.deepEqual(reply.structuredContent, { ok: true });
    await until(() => notices.some(message => message.startsWith("Sub-agent finished")));
    const final = await execute({ action: "status", id: receipt!.id });
    const record = final.details as RunRecord;
    assert.equal(record.state, "completed");
    assert.deepEqual(snapshots.at(-1)!.tasks, [], "completed runs leave the background shelf");
    assert.equal(record.task, "PRIVATE_TASK_BRIEF");
    assert.equal(record.usage!.input, 10);
    assert.match(await readFile(record.reportPath!, "utf8"), /agent reply/);
    assert.deepEqual(JSON.parse(final.content[0]!.type === "text" ? final.content[0]!.text : ""), final.structuredContent);
    assert(!JSON.stringify(final.structuredContent).includes("PRIVATE_TASK_BRIEF"));
    const finished = notices.find(message => message.startsWith("Sub-agent finished"))!;
    const payload = JSON.parse(finished.slice(finished.indexOf("{")));
    assert(Check(OutputSchema, payload));
    assert.deepEqual(Object.keys(payload).sort(), ["agent", "id", "reportPath", "state", "taskPreview"]);
    assert.equal((payload as { agent: string }).agent, "reviewer");
    assert.equal(calls, 2);
  } finally {
    await hooks.get("session_shutdown")?.();
    assert.equal(bus.size, 0, "dashboard refresh listener is disposed");
    if (snapshots.length) assert.deepEqual(snapshots.at(-1)!.tasks, []);
    ModelRuntime.create = create;
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir;
  }
});
