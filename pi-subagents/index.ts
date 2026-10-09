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
import { Text } from "@earendil-works/pi-tui";
import { BoundaryEditor } from "./src/navigation.ts";
import { HumanState, stateLabel } from "./src/presentation.ts";
import { plain, syncWidget, type WidgetSlot, type NavigationHost } from "./src/ui.ts";
import { canonicalDirectory, workspaceRoot } from "./src/workspace.ts";
import { backgroundTaskSnapshot } from "./src/dashboard.ts";

/** Match the stable Pi 1.x peer range; minor/patch upgrades are not host changes. */
export function assertSupportedPiHost(version: string, bun = "Bun" in globalThis): void {
  if (!/^1\.(0|[1-9]\d*)\.(0|[1-9]\d*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/.test(version) || bun) {
    throw new Error(`Unsupported Pi host ${version}; use local npm Pi 1.x on Node (>=1.0.0, <2.0.0; no prereleases)`);
  }
}

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
  let host: { owner: string; ctx: ExtensionContext; manager: RunManager; widget: WidgetSlot; unsubInput?: () => void; inspecting?: boolean; closeThread?: () => void } | undefined;
  let closing: Promise<void> | undefined;
  let runtime: Promise<ModelRuntime> | undefined;
  let refresh: ReturnType<typeof setTimeout> | undefined;
  let clock: ReturnType<typeof setInterval> | undefined;
  const inspectors = new Set<() => void>();
  const agentDir = getAgentDir();
  let dashboardKey = "";
  let unsubDashboard: (() => void) | undefined;
  function publishDashboard(force = false): void {
    if (!host || typeof pi.events?.emit !== "function") return;
    const snapshot = backgroundTaskSnapshot(host.owner, host.manager.list());
    const key = JSON.stringify(snapshot);
    if (!force && key === dashboardKey) return;
    dashboardKey = key;
    try { pi.events.emit("pi:background-tasks", snapshot); } catch { /* Display consumers never determine run authority. */ }
  }
  let plainEditor: BoundaryEditor | undefined;
  let plainFactory: Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0];
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || typeof ctx.ui.getEditorComponent !== "function" || ctx.ui.getEditorComponent()) return;
    plainFactory = (tui, theme, keys) => {
      plainEditor = new BoundaryEditor(tui, theme, keys);
      plainEditor.onDownBoundary = () => { if (!host?.inspecting) host?.widget.instance?.focusRoster(); };
      return plainEditor;
    };
    ctx.ui.setEditorComponent(plainFactory);
  });

  pi.registerMessageRenderer?.("minimal-subagent", (message, { expanded }, theme) => {
    const details = message.details as { title?: string; state?: string; kind?: string } | undefined;
    const title = details?.title ?? "Sub-agent";
    const status = details?.kind === "question" ? "Needs reply" : details?.state ?? "Finished · report saved (unverified)";
    return new Text(`${theme.fg("accent", plain(title, 180))} · ${plain(status)}${expanded ? `\n${plain(typeof message.content === "string" ? message.content : JSON.stringify(message.content), 4096)}` : ""}`, 0, 0);
  });

  function draw(): void {
    if (!host) return;
    bindKeys(host.ctx);
    const live = host.manager.live();
    publishDashboard();
    try { syncWidget(host.ctx, host.manager.list(), Boolean(health[HEALTH]), id => { void openThread(host!.ctx, id); }, host.widget); } catch { /* Terminal availability is not run evidence. */ }
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
    assertSupportedPiHost(VERSION);
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
        host.widget.state!.remember(manager.list());
        pi.sendMessage({ customType: "minimal-subagent", content, display: true, details: { id: record.id, kind, title: host.widget.state!.title(record), state: stateLabel(record) } }, { triggerTurn: true, deliverAs: "followUp" });
      },
    });
    host = { owner, ctx, manager, widget: { state: new HumanState() } };
    dashboardKey = "";
    unsubDashboard = pi.events?.on?.("pi:background-tasks:request", data => {
      const request = data as { version?: unknown; sessionId?: unknown } | null;
      if (request?.version === 1 && request.sessionId === host?.owner) publishDashboard(true);
    });
    publishDashboard(true);
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
    if (!host || ctx.mode !== "tui") return;
    if (host.widget.navigation?.isActive?.() === false) { host.unsubInput?.(); host.widget.navigation = undefined; }
    if (host.widget.navigation) return;
    const state = host;
    pi.events?.emit("subagent:ui-host-request", { version: 1, owner: state.owner, accept: (navigation: NavigationHost) => {
      if (host !== state || navigation.version !== 1) return;
      state.widget.navigation = navigation;
      state.unsubInput = navigation.bindDown(() => { if (!state.inspecting) state.widget.instance?.focusRoster(); });
    } });
    if (!state.widget.navigation && plainEditor && ctx.ui.getEditorComponent?.() === plainFactory) {
      const editor = plainEditor;
      state.widget.navigation = {
        version: 1,
        isActive: () => ctx.ui.getEditorComponent?.() === plainFactory && plainEditor === editor,
        focusEditor(data?: string) {
          // Use the editor-owned TUI through the roster callback, not a raw global key listener.
          state.widget.instance?.focusMain(editor, data);
        },
        bindDown(handler) { editor.onDownBoundary = handler; return () => { if (editor.onDownBoundary === handler) editor.onDownBoundary = undefined; }; },
      };
    }
  }
  async function openThread(ctx: ExtensionContext, id: string): Promise<void> {
    if (!host || host.inspecting) return;
    const state = host;
    state.inspecting = true;
    state.widget.state!.remember(state.manager.list());
    state.widget.state!.selected = id;
    try { await attach(ctx, id, actions(state.manager), state.widget.state, state.widget.navigation, close => { state.closeThread = close; }); }
    catch (error) { try { ctx.ui.notify(plain(errorText(error)), "error"); } catch { /* UI never determines execution success. */ } }
    finally {
      state.closeThread = undefined;
      if (host === state) {
        state.inspecting = false;
        const returnFocus = state.widget.navigation?.isActive?.() !== false && state.widget.navigation?.canFocusRoster?.() !== false;
        if (returnFocus) state.widget.state!.selected = id;
        draw();
        if (returnFocus) {
          if (state.widget.instance) state.widget.instance.focusRoster(id);
          else state.widget.navigation?.focusEditor();
        }
      }
    }
  }

  async function shutdown(): Promise<void> {
    if (closing) return closing; // Serialize: concurrent shutdowns share one teardown.
    const previous = host;
    try { unsubDashboard?.(); } catch { /* Runtime may already be disposed. */ }
    unsubDashboard = undefined; dashboardKey = "";
    if (previous && typeof pi.events?.emit === "function") {
      try { pi.events.emit("pi:background-tasks", backgroundTaskSnapshot(previous.owner, [])); } catch { /* Display-only cleanup. */ }
    }
    host = undefined; // notify() already no-ops once host.manager is no longer this manager.
    clearTimeout(refresh); refresh = undefined;
    clearInterval(clock); clock = undefined;
    runtime = undefined;
    try { previous?.closeThread?.(); previous?.unsubInput?.(); previous?.ctx.ui.setWidget("minimal-subagents", undefined); } catch { /* UI may already be disposed. */ }
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
    renderCall(input, theme) {
      const request = input as { action?: string; tasks?: { agent: string }[] };
      return new Text(theme.fg("accent", `Sub-agents · ${plain(request.action ?? "action")} ${request.tasks ? `(${request.tasks.length})` : ""}`), 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, renderContext) {
      if (isPartial) return new Text(theme.fg("dim", "Sub-agent action in progress…"), 0, 0);
      if (renderContext?.isError) return new Text(theme.fg("error", plain(result.content.filter(block => block.type === "text").map(block => block.text).join(" "), 600)), 0, 0);
      if (expanded) return new Text(plain(JSON.stringify(result.details), 8192), 0, 0);
      const data = result.details as { runs?: { id: string }[]; id?: string; name?: string } | { name: string }[] | undefined;
      const refs = Array.isArray(data) ? [] : data?.runs ?? (data?.id ? [{ id: data.id }] : []);
      const labels = refs.map(ref => {
        try { const record = host!.manager.status(ref.id); return `${host!.widget.state!.title(record)} · ${stateLabel(record)}`; }
        catch { return "Sub-agent · saved evidence (open expanded details for exact IDs)"; }
      });
      return new Text(theme.fg("accent", labels.join("\n") || (Array.isArray(data) ? data.map(profile => plain(profile.name)).join(" · ") : "Sub-agent action acknowledged")), 0, 0);
    },
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
          state.widget.state!.remember(runs);
          draw();
          const onlyLive = runs.every(run => isLive(run.state));
          if (onlyLive && state.widget.navigation && state.widget.instance) { state.widget.instance.focusRoster(); return; }
          const labels = runs.map(run => `${state.widget.state!.title(run)} · ${stateLabel(run)}`);
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
