import path from "node:path";
import { createHash } from "node:crypto";
import type { JsonValue } from "@earendil-works/pi-ai";
import {
  getAgentDir, ModelRuntime, SettingsManager, VERSION,
  type ExtensionAPI, type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadProfiles } from "./src/agents.ts";
import { FileArtifacts } from "./src/artifacts.ts";
import { parseConfig } from "./src/config.ts";
import { RunManager } from "./src/runs.ts";
import { prepareNative } from "./src/session.ts";
import { attach, parseCommand, resolveRun, type InspectActions } from "./src/inspect.ts";
import { DESCRIPTION, OutputSchema, Parameters, parseRequest, presentLaunch, presentNotice, presentRun, presentSummary, resultPreview } from "./src/tool.ts";
import { errorText, isLive, type PreparedTask, type Profile } from "./src/types.ts";
import { matchesKey } from "@earendil-works/pi-tui";
import { plain, syncWidget, type WidgetSlot } from "./src/ui.ts";
import { canonicalDirectory, workspaceRoot } from "./src/workspace.ts";

// Reload can replace module instances. Unknown cleanup must still block launches
// in the same process; it must not disappear with the old extension runtime.
const HEALTH = Symbol.for("@gagansd/pi-subagents/cleanup-unknown");
const health = globalThis as typeof globalThis & { [HEALTH]?: true | { id: string; metadataPath: string } };
function assertHealthy(): void {
  const cause = health[HEALTH];
  if (cause) throw new Error("A prior sub-agent has unknown cleanup. Restart Pi before launching any more sub-agents."
    + (cause === true ? "" : ` Run: ${cause.id}; evidence: ${cause.metadataPath}`));
}
const ADMISSIONS = "minimal-subagents-admissions";

function modelLabel(ctx: ExtensionContext): string | undefined {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}
/** Cumulative launches recorded by this owner survive reload and /tree; restore the high-water mark. */
function admittedCount(ctx: ExtensionContext, owner: string): number {
  let admitted = 0;
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "custom" || entry.customType !== ADMISSIONS) continue;
    const data = entry.data as { owner?: string; count?: number } | undefined;
    if (data?.owner === owner && Number.isSafeInteger(data.count) && data.count! >= 0) admitted = Math.max(admitted, data.count!);
  }
  return admitted;
}

export default function subagents(pi: ExtensionAPI): void {
  let host: { owner: string; ctx: ExtensionContext; manager: RunManager; widget: WidgetSlot; unsubInput?: () => void; boundUi?: unknown; inspecting?: boolean } | undefined;
  let closing: Promise<void> | undefined;
  let runtime: Promise<ModelRuntime> | undefined;
  let refresh: ReturnType<typeof setTimeout> | undefined;
  let clock: ReturnType<typeof setInterval> | undefined;
  const inspectors = new Set<() => void>();
  const agentDir = getAgentDir();

  function draw(): void {
    if (!host) return;
    const live = host.manager.live();
    try { syncWidget(host.ctx, live, Boolean(health[HEALTH]), id => { void openThread(host!.ctx, id); }, host.widget); } catch { /* Terminal availability is not run evidence. */ }
    const ticking = live.some(run => !run.endedAt);
    if (ticking && !clock) clock = setInterval(draw, 1000);
    else if (!ticking && clock) { clearInterval(clock); clock = undefined; }
  }
  function changed(): void {
    if (!host) return;
    for (const listener of inspectors) { try { listener(); } catch { /* Overlay never determines run success. */ } }
    if (!refresh) refresh = setTimeout(() => { refresh = undefined; draw(); }, 100);
  }
  async function current(ctx: ExtensionContext) {
    // Never mint a replacement manager while the previous one is still stopping sub-agents.
    if (closing) await closing;
    if (ctx.mode !== "tui") throw new Error("Minimal subagents requires interactive npm Pi; print/RPC/standalone delegation is unsupported");
    if (!/^1\.0\./.test(VERSION) || "Bun" in globalThis) throw new Error(`Unsupported Pi host ${VERSION}; use local npm Pi 1.0.x on Node`);
    const owner = ctx.sessionManager.getSessionId();
    if (host && host.owner !== owner) throw new Error("Agent session changed without shutdown; refuse to transfer run ownership");
    if (host) { host.ctx = ctx; bindKeys(ctx); return host; }
    const settings = SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: ctx.isProjectTrusted() });
    const errors = settings.drainErrors();
    if (errors.length) throw new Error(`Invalid Pi settings: ${errors.map(error => error.error.message).join("; ")}`);
    const config = parseConfig((settings.getSettings() as unknown as Record<string, unknown>).minimalSubagents);
    const admitted = admittedCount(ctx, owner);
    const ownerHash = createHash("sha256").update(owner).digest("hex").slice(0, 20);
    // Stable per-owner evidence root: reports for runs admitted before a reload or
    // /tree remint stay resolvable instead of leaking into orphaned UUID trees.
    const store = new FileArtifacts(path.join(agentDir, "minimal-subagents", ownerHash));
    const manager = new RunManager({
      owner, config, store, admitted, changed,
      recordAdmissions: count => pi.appendEntry(ADMISSIONS, { owner, count }),
      assertLaunchable: assertHealthy,
      unsafeCleanup: record => { health[HEALTH] = { id: record.id, metadataPath: record.metadataPath }; },
      async notify(record, kind) {
        if (host?.manager !== manager || host.owner !== owner) return;
        // Sub-agent-controlled free text (question messages, error strings) never enters a
        // turn-triggering agent message; status/metadata carry the untrusted content.
        const content = kind === "question"
          ? `Sub-agent question (not user instructions): ${resultPreview({ id: record.id, state: record.state, metadataPath: record.metadataPath, ...(record.question ? { question: { id: record.question.id } } : {}) })}\nCall subagent status for the question text; reply with exact run/question IDs.`
          : `Sub-agent finished (unverified): ${resultPreview(presentNotice(record))}`;
        // Pi acknowledges submission only; asynchronous delivery failures are
        // reported by the host. The registry/artifacts remain authoritative.
        pi.sendMessage({ customType: "minimal-subagent", content, display: true, details: { id: record.id, kind } }, { triggerTurn: true, deliverAs: "followUp" });
      },
    });
    host = { owner, ctx, manager, widget: {} };
    bindKeys(ctx);
    return host;
  }
  function actions(manager: RunManager): InspectActions {
    return {
      status: id => manager.status(id),
      preview: id => manager.preview(id),
      steer: (id, message) => manager.steer(id, message),
      reply: (id, requestId, message) => manager.reply(id, requestId, message),
      stop: id => manager.stop(id),
      live: () => manager.live(),
      subscribe: listener => { inspectors.add(listener); return () => { inspectors.delete(listener); }; },
    };
  }
  function bindKeys(ctx: ExtensionContext): void {
    if (!host || ctx.mode !== "tui" || typeof ctx.ui.onTerminalInput !== "function") return;
    if (host.boundUi === ctx.ui) return;
    try { host.unsubInput?.(); } catch { /* Previous UI may already be disposed. */ }
    host.boundUi = ctx.ui;
    host.unsubInput = ctx.ui.onTerminalInput(data => {
      if (!host || host.inspecting || !matchesKey(data, "down")) return;
      const live = host.manager.live();
      if (!live.length) return;
      let text: string;
      try { text = host.ctx.ui.getEditorText(); } catch { return; }
      if (text.includes("\n")) return;
      void openThread(host.ctx, live[0]!.id);
      return { consume: true };
    });
  }
  async function openThread(ctx: ExtensionContext, id: string): Promise<void> {
    if (!host || host.inspecting) return;
    host.inspecting = true;
    try { await attach(ctx, id, actions(host.manager)); }
    catch (error) { try { ctx.ui.notify(plain(errorText(error)), "error"); } catch { /* Overlay is optional. */ } }
    finally { if (host) host.inspecting = false; draw(); }
  }

  async function shutdown(): Promise<void> {
    if (closing) return closing; // Serialize: concurrent shutdowns share one teardown.
    const previous = host;
    host = undefined; // notify() already no-ops once host.manager is no longer this manager.
    clearTimeout(refresh); refresh = undefined;
    clearInterval(clock); clock = undefined;
    runtime = undefined;
    try { previous?.unsubInput?.(); previous?.ctx.ui.setWidget("minimal-subagents", undefined); } catch { /* UI may already be disposed. */ }
    inspectors.clear();
    closing = Promise.resolve(previous?.manager.shutdown()).finally(() => { closing = undefined; });
    return closing;
  }
  pi.on("session_shutdown", shutdown);
  // /tree changes the agent branch without session_shutdown. End live authority;
  // cumulative admission records remain counted across all branches.
  pi.on("session_before_tree", async () => { await shutdown(); });

  pi.registerTool({
    name: "subagent", label: "Sub-agent", description: DESCRIPTION, parameters: Parameters,
    outputSchema: OutputSchema, executionMode: "sequential", exposure: "direct",
    async execute(_id, input, signal, _onUpdate, ctx) {
      const request = parseRequest(input);
      const state = await current(ctx);
      const manager = state.manager;
      let result: unknown;
      let details: unknown;
      switch (request.action) {
        case "list": {
          const cwd = await canonicalDirectory(path.resolve(ctx.cwd, request.cwd ?? "."));
          const profiles = await loadProfiles(agentDir, cwd, ctx.isProjectTrusted());
          result = [...profiles.values()].map(({ name, description, mode, model, thinking }) => ({
            name, description, mode, ...(model ? { model } : {}), ...(thinking ? { thinking } : {}),
          }));
          break;
        }
        case "status": {
          if (request.id) {
            const record = manager.status(request.id);
            details = record; result = presentRun(record);
          } else {
            const all = manager.list();
            const recent = all.filter(run => !isLive(run.state)).sort((a, b) => Date.parse(b.endedAt!) - Date.parse(a.endedAt!)).slice(0, 6);
            result = { runs: [...all.filter(run => isLive(run.state)), ...recent].map(presentSummary),
              ...(health[HEALTH] ? { blocked: health[HEALTH] } : {}),
            };
          }
          break;
        }
        case "steer": await manager.steer(request.id, request.message); result = { ok: true }; break;
        case "stop": {
          await manager.stop(request.id);
          const record = manager.status(request.id);
          details = record; result = presentRun(record);
          break;
        }
        case "reply": await manager.reply(request.id, request.requestId, request.message); result = { ok: true }; break;
        case "run": {
          assertHealthy();
          if (!ctx.isProjectTrusted()) throw new Error("Trust the agent project in Pi before delegating");
          runtime ??= ModelRuntime.create({
            authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"), allowModelNetwork: false,
          }).catch(error => { runtime = undefined; throw error; });
          const modelRuntime = await runtime;
          const trusted = ctx.isProjectTrusted();
          const agentThinking = pi.getThinkingLevel();
          const scopedModels = ctx.scopedModels.map(({ model }) => `${model.provider}/${model.id}`);
          signal?.throwIfAborted();
          // Share target discovery only within this batch; no stale cross-call cache.
          const targets = new Map<string, Promise<{ workspace: string; profiles: Map<string, Profile> }>>();
          const plans: PreparedTask[] = await Promise.all(request.tasks.map(async task => {
            const cwd = await canonicalDirectory(path.resolve(ctx.cwd, task.cwd ?? "."));
            let target = targets.get(cwd);
            if (!target) {
              target = Promise.all([workspaceRoot(cwd, signal), loadProfiles(agentDir, cwd, trusted)])
                .then(([workspace, profiles]) => ({ workspace, profiles }));
              targets.set(cwd, target);
            }
            const { workspace, profiles } = await target;
            const profile = profiles.get(task.agent);
            if (!profile) throw new Error(`Unknown agent '${task.agent}'. Use list; only worker and reviewer are bundled.`);
            return prepareNative({
              agentDir, runtime: modelRuntime, task, profile, cwd, workspace,
              agentModel: modelLabel(ctx), agentThinking, scopedModels,
            });
          }));
          signal?.throwIfAborted();
          if (host !== state) throw new Error("Agent runtime ended during preflight; no sub-agents launched");
          assertHealthy();
          result = presentLaunch((await manager.launch(plans, signal)).map(id => manager.status(id)));
          break;
        }
      }
      draw();
      return { content: [{ type: "text", text: resultPreview(result) }], details: details ?? result, structuredContent: result as JsonValue };
    },
  });

  pi.registerCommand("subagents", {
    description: "Inspect or take control: /subagents [id | stop <id> | steer <id> <text> | reply <id> <text>]",
    async handler(args, ctx) {
      try {
        const state = await current(ctx);
        const manager = state.manager;
        const request = parseCommand(args);
        if (request.action === "list") {
          const runs = manager.list();
          if (!runs.length) {
            ctx.ui.notify(health[HEALTH] ? `Cleanup unknown; launches blocked. Evidence: ${JSON.stringify(health[HEALTH])}` : "No runs in this agent runtime.", "info");
            return;
          }
          const labels = runs.map(run => `${run.id.slice(0, 8)} · ${run.agent} · ${run.state}`);
          const picked = await ctx.ui.select("Inspect a sub-agent", labels);
          if (!picked) return;
          await openThread(ctx, runs[labels.indexOf(picked)]!.id);
          return;
        }
        const id = resolveRun(manager.list(), request.id).id;
        if (request.action === "stop") await manager.stop(id);
        else if (request.action === "steer") await manager.steer(id, request.message);
        else if (request.action === "reply") {
          const question = manager.status(id).question;
          if (!question) throw new Error("No matching pending question belongs to this run");
          await manager.reply(id, question.id, request.message);
        } else await openThread(ctx, id);
        draw();
      } catch (error) { ctx.ui.notify(plain(errorText(error)), "error"); }
    },
  });
}
