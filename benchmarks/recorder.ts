import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCurrentSystemPrompt, getCurrentTools, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { modelFingerprint } from "./runtime.mjs";

// No model-facing tools or instructions. Observation only during the scenario.
// The external host approves normal exit only AFTER checking native/OS quiescence.
// Abort/stop calls are teardown, logged as intervention, never scenario help.
export default function recorder(pi: ExtensionAPI) {
  const output = process.env.PI_BENCH_EVENTS;
  if (!output) throw new Error("PI_BENCH_EVENTS is required");
  const expected = JSON.parse(process.env.PI_BENCH_MODEL ?? "{}");
  const controlPath = process.env.PI_BENCH_CONTROL;
  const asyncIds = new Set<string>();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let controls: ReturnType<typeof setInterval> | undefined;
  let exiting = false;
  let finishNotified = false;
  const runtimeRoot = process.env.PI_BENCH_CONTROL ? join(process.env.PI_BENCH_CONTROL, "..") : undefined;
  const log = (type: string, data: unknown) => appendFileSync(output,
    JSON.stringify({ type, timestamp: new Date().toISOString(), data }) + "\n", { mode: 0o600 });
  const identity = (ctx: ExtensionContext) => ({
    pid: process.pid, mode: ctx.mode, trusted: ctx.isProjectTrusted(),
    session_id: ctx.sessionManager.getSessionId(), session_file: ctx.sessionManager.getSessionFile(),
    model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
    thinking: pi.getThinkingLevel(), pi_version: VERSION,
    node_version: process.version, node_executable: process.execPath, pi_entrypoint: process.argv[1],
    route: ctx.model ? modelFingerprint(ctx.model, getSupportedThinkingLevels(ctx.model)) : null,
  });
  const rpc = (method: string, params: unknown): Promise<any> => new Promise(resolve => {
    const requestId = randomUUID();
    const event = `subagents:rpc:v1:reply:${requestId}`;
    const unsubscribe = pi.events.on(event, reply => { clearTimeout(timer); unsubscribe(); resolve(reply); });
    const timer = setTimeout(() => { unsubscribe(); resolve({ success: false, error: "teardown RPC deadline" }); }, 2000);
    pi.events.emit("subagents:rpc:v1:request", { version: 1, requestId, method, params });
  });
  async function exit(ctx: ExtensionContext, reason: string, abort: boolean) {
    if (exiting) return;
    exiting = true;
    clearTimeout(deadline); clearInterval(controls);
    log("host_teardown", { reason, abort, ...identity(ctx) });
    if (abort) {
      ctx.abort(); // shutdown() alone waits for the parent stream to go idle.
      if (process.env.PI_BENCH_VARIANT === "upstream") {
        const status = await rpc("status", { view: "fleet" });
        log("teardown_status", status);
        // The owned file ledger also includes workflow-launched children; a
        // dispatch receipt and bounded RPC snapshot are not exhaustive inventories.
        if (controlPath && existsSync(controlPath)) {
          const host = JSON.parse(readFileSync(controlPath, "utf8"));
          for (const id of host.run_ids ?? []) asyncIds.add(id);
        }
        log("native_interrupt_receipt", await rpc("interrupt", {}));
        const results = await Promise.all([...asyncIds].map(async id => ({ id, result: await rpc("stop", { id }) })));
        log("native_stop_receipts", results); // Receipts are NOT terminal proof.
      }
    }
    ctx.shutdown(); // Ours stops its session-bound native children here.
  }
  pi.on("session_start", (_event, ctx) => {
    const active = new Set(pi.getActiveTools());
    const state = { ...identity(ctx), system_prompt: ctx.getSystemPrompt(),
      tools: pi.getAllTools().filter(tool => active.has(tool.name)).map(tool => ({
        name: tool.name, description: tool.description, parameters: tool.parameters,
        exposure: tool.exposure, promptGuidelines: tool.promptGuidelines,
      })) };
    log("startup", state);
    const runtimeMatches = !expected.pi_version || (VERSION === expected.pi_version && process.version === expected.node_version
      && process.execPath === expected.node_executable && process.argv[1] === expected.pi_entrypoint);
    const routeMatches = !expected.route || JSON.stringify(state.route) === JSON.stringify(expected.route);
    if (state.mode !== "tui" || !state.trusted || state.model !== expected.model || state.thinking !== expected.thinking || !runtimeMatches || !routeMatches) {
      log("preflight_error", { expected, observed: identity(ctx) });
      void exit(ctx, "startup attestation failed", true);
      return;
    }
    if (process.env.PI_BENCH_STARTUP_ONLY === "1") { void exit(ctx, "startup-only probe", false); return; }
    deadline = setTimeout(() => {
      log("episode_timeout", identity(ctx)); void exit(ctx, "episode deadline", true);
    }, Number(process.env.PI_BENCH_TIMEOUT_SECONDS ?? "600") * 1000);
    if (controlPath) controls = setInterval(() => {
      if (!existsSync(controlPath)) return;
      try {
        const control = JSON.parse(readFileSync(controlPath, "utf8"));
        if (control.action === "abort") void exit(ctx, control.reason, true);
        else if (control.action === "finish") void exit(ctx, control.reason, false);
      } catch (error) { log("control_error", { error: String(error) }); void exit(ctx, "invalid host control", true); }
    }, 100);
  });
  pi.on("context_with_system", (event, ctx) => log("request_context", {
    ...identity(ctx), system_prompt: getCurrentSystemPrompt(event.messages), tools: getCurrentTools(event.messages), messages: event.messages,
  }));
  pi.on("before_provider_request", (event, ctx) => {
    if (exiting) { log("request_blocked_during_teardown", identity(ctx)); throw new Error("Benchmark teardown: no further parent provider requests"); }
    log("provider_payload", { ...identity(ctx), payload: event.payload });
  });
  pi.on("tool_execution_start", event => log("tool_start", event));
  pi.on("tool_execution_update", event => {
    const id = event.partialResult?.details?.asyncId;
    if (id) asyncIds.add(id);
    log("tool_update", event);
  });
  pi.on("tool_execution_end", event => {
    const id = event.result?.details?.asyncId;
    if (id) asyncIds.add(id);
    log("tool_end", event);
  });
  pi.on("message_end", event => log("message_end", event));
  pi.on("agent_settled", async (_event, ctx) => {
    log("parent_settled", identity(ctx));
    const result = join(ctx.cwd, "result.json");
    if (finishNotified || !existsSync(result) || exiting) return;
    finishNotified = true;
    try { log("result_claim", JSON.parse(readFileSync(result, "utf8"))); }
    catch (error) { log("invalid_result", { error: String(error) }); }
    if (process.env.PI_BENCH_VARIANT === "upstream" && runtimeRoot) {
      const snapshot = await rpc("status", { view: "fleet" });
      log("finish_native_snapshot", snapshot);
      // view:fleet reconciles current disk status + live/retained foreground
      // controls. fleet/asyncSnapshot are cached projections and can lag after
      // bg_wait already observed completion; retain, but do not use as proof.
      const quiet = snapshot?.success === true && typeof snapshot.data?.text === "string"
        && snapshot.data.text.includes("No active subagent fleet.");
      writeFileSync(join(runtimeRoot, "native-status.json"), JSON.stringify({ quiescent: quiet,
        authority: "full fleet view plus native file ledger and external owned-process proof; cached projections are not terminal authority", snapshot }) + "\n");
    }
    log("finish_requested", identity(ctx)); // External host must approve, never trust the claim as a join.
  });
  pi.on("session_shutdown", (_event, ctx) => {
    clearTimeout(deadline); clearInterval(controls); log("shutdown", identity(ctx));
  });
}
