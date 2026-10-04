import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";

// Benchmark instrumentation only. Registers no model-facing tools, injects no
// instructions, does not steer/launch/answer children, and never edits requests.
export default function recorder(pi: ExtensionAPI) {
  const output = process.env.PI_BENCH_EVENTS;
  if (!output) throw new Error("PI_BENCH_EVENTS is required");
  const expected = JSON.parse(process.env.PI_BENCH_MODEL ?? "{}");
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const log = (type: string, data: unknown) => appendFileSync(output,
    JSON.stringify({ type, timestamp: new Date().toISOString(), data }) + "\n", { mode: 0o600 });
  const identity = (ctx: ExtensionContext) => ({
    mode: ctx.mode, trusted: ctx.isProjectTrusted(),
    session_id: ctx.sessionManager.getSessionId(), session_file: ctx.sessionManager.getSessionFile(),
    model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
    thinking: pi.getThinkingLevel(),
  });
  const loadout = (ctx: ExtensionContext) => {
    const active = new Set(pi.getActiveTools());
    return {
      ...identity(ctx), system_prompt: ctx.getSystemPrompt(),
      tools: pi.getAllTools().filter(tool => active.has(tool.name)).map(tool => ({
        name: tool.name, description: tool.description, parameters: tool.parameters,
        exposure: tool.exposure, promptGuidelines: tool.promptGuidelines,
      })),
    };
  };
  pi.on("session_start", (_event, ctx) => {
    const state = loadout(ctx);
    log("startup", state);
    if (state.mode !== "tui" || !state.trusted || state.model !== expected.model || state.thinking !== expected.thinking) {
      log("preflight_error", { expected, observed: identity(ctx) });
      ctx.shutdown();
      return;
    }
    if (process.env.PI_BENCH_STARTUP_ONLY === "1") ctx.shutdown();
    else deadline = setTimeout(() => {
      log("episode_timeout", identity(ctx));
      ctx.shutdown();
    }, Number(process.env.PI_BENCH_TIMEOUT_SECONDS ?? "600") * 1000);
  });
  pi.on("context_with_system", (event, ctx) => {
    log("request_context", {
      ...identity(ctx), system_prompt: getCurrentSystemPrompt(event.messages),
      tools: getCurrentTools(event.messages), messages: event.messages,
    });
  });
  pi.on("before_provider_request", (event, ctx) => {
    // Payload only, never authentication headers. Useful for auditing the parent
    // estimate against what the provider actually received.
    log("provider_payload", { ...identity(ctx), payload: event.payload });
  });
  pi.on("tool_execution_start", event => log("tool_start", event));
  pi.on("tool_execution_end", event => log("tool_end", event));
  pi.on("message_end", event => log("message_end", event));
  pi.on("agent_settled", (_event, ctx) => {
    log("parent_settled", identity(ctx));
    const result = join(ctx.cwd, "result.json");
    if (!existsSync(result)) return; // Async children may still be working.
    try { log("result_claim", JSON.parse(readFileSync(result, "utf8"))); }
    catch (error) { log("invalid_result", { error: String(error) }); }
    ctx.shutdown();
  });
  pi.on("session_shutdown", (_event, ctx) => {
    clearTimeout(deadline);
    log("shutdown", identity(ctx));
  });
}
