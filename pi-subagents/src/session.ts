import path from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager,
  type AgentSession, type ModelRuntime, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { captureHead, diffTool } from "./diff.ts";
import { formatMessage } from "./transcript.ts";
import type { Child, PreparedTask, Profile, RunContext, Task, Thinking } from "./types.ts";

export const INSPECT_TOOLS = ["read", "grep", "find", "ls", "diff", "contact_supervisor"];
export const EDIT_TOOLS = [...INSPECT_TOOLS, "bash", "edit", "write"];
const QuestionParams = Type.Object({ message: Type.String({ minLength: 1, maxLength: 8192 }) }, { additionalProperties: false });
const BOUNDARY = `You are a leaf child, not the parent. Perform only your task. You cannot delegate or resume other agents.
Use contact_supervisor for missing decisions; do not improvise around missing required safety policy or tools.
Your tools run with the host's OS permissions, not in a sandbox. Stay in your assigned workspace and scope.
Return your report normally. The host saves it; do not write a report file yourself or send a completion question.
Do not claim checks passed without evidence. The parent, not you, decides acceptance.`;

export function supervisorTool(context: RunContext): ToolDefinition<typeof QuestionParams> {
  return {
    name: "contact_supervisor", label: "Ask parent",
    description: "Ask the owning parent one material question and wait for its reply. Not for routine progress or completion. Cancellation/deadline ends the wait.",
    parameters: QuestionParams,
    async execute(_id, args, signal) {
      return { content: [{ type: "text", text: await context.ask(args.message, signal) }], details: undefined };
    },
  };
}

export interface NativeOptions {
  agentDir: string;
  runtime: ModelRuntime;
  task: Task;
  profile: Profile;
  cwd: string;
  workspace: string;
  parentModel?: string;
  parentThinking: Thinking;
  scopedModels: readonly string[];
}

/** Model and policy resolution happens before the manager admits any batch member. */
export function prepareNative(options: NativeOptions): PreparedTask {
  const { runtime, task, profile } = options;
  const name = task.model ?? profile.model ?? options.parentModel;
  if (!name) throw new Error("No model selected; configure the parent or profile");
  const separator = name.indexOf("/");
  if (separator < 1) throw new Error(`Exact native model '${name}' is unavailable; no aliases, virtual models, or fallback`);
  const model = runtime.getPhysicalModel(name.slice(0, separator), name.slice(separator + 1));
  if (!model) throw new Error(`Exact native model '${name}' is unavailable; no aliases, virtual models, or fallback`);
  if (options.scopedModels.length && !options.scopedModels.includes(name)) throw new Error(`Model '${name}' is outside the parent's model scope`);
  if (!runtime.hasConfiguredAuth(model.provider)) throw new Error(`No configured authentication for ${model.provider}`);
  const thinking = task.thinking ?? profile.thinking ?? options.parentThinking;
  if (!getSupportedThinkingLevels(model).includes(thinking)) throw new Error(`Thinking level '${thinking}' is unsupported by ${name}; set an explicit supported level on the task or profile`);
  // No extension discovery is allowed; only trusted global/project instruction
  // files and ordinary Pi settings are inherited. This manager never writes them.
  const disk = SettingsManager.create(options.cwd, options.agentDir, { projectTrusted: true });
  const errors = disk.drainErrors();
  if (errors.length) throw new Error(`Cannot load Pi settings: ${errors.map(error => error.error.message).join("; ")}`);
  const settings = SettingsManager.inMemory({
    ...disk.getSettings(), packages: [], extensions: [], skills: [], prompts: [], themes: [],
    cacheWarming: "off", enableSkillCommands: false,
  }, { projectTrusted: true });
  return {
    ...task, cwd: options.cwd, workspace: options.workspace, model: name, thinking, mode: profile.mode,
    async start(context) {
      context.signal.throwIfAborted();
      const head = await captureHead(options.workspace, context.signal);
      const tools = profile.mode === "edit" ? EDIT_TOOLS : INSPECT_TOOLS;
      const loader = new DefaultResourceLoader({
        cwd: options.cwd, agentDir: options.agentDir, settingsManager: settings,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
        appendSystemPromptOverride: inherited => [...inherited, BOUNDARY, profile.prompt],
      });
      await loader.reload();
      context.signal.throwIfAborted();
      if (loader.getExtensions().extensions.length || loader.getExtensions().errors.length) throw new Error("Child unexpectedly loaded extensions or extension errors");
      const { session } = await createAgentSession({
        cwd: options.cwd, agentDir: options.agentDir, modelRuntime: runtime, model, thinkingLevel: thinking,
        settingsManager: settings, resourceLoader: loader, tools,
        customTools: [diffTool(options.workspace, head), supervisorTool(context)],
        sessionManager: SessionManager.create(options.cwd, path.join(context.directory, "transcript")),
      });
      const child = wrapSession(session, task.task, context);
      context.own(child);
      context.signal.throwIfAborted();
      // onError may fire outside the bindExtensions stack; record, then throw here.
      let bindError: Error | undefined;
      await session.bindExtensions({ mode: "print", onError: error => { bindError ??= new Error(`Child runtime error: ${error.error}`); } });
      if (bindError) throw bindError;
      context.signal.throwIfAborted();
      if (session.model?.provider !== model.provider || session.model.id !== model.id || session.thinkingLevel !== thinking) throw new Error("Child model/thinking changed during startup");
      const active = session.getActiveToolNames();
      if (active.length !== tools.length || tools.some(tool => !active.includes(tool))) throw new Error("Child tool set does not match the declared capability mode");
      const file = session.sessionManager.getSessionFile();
      if (!file) throw new Error("Child transcript file is unavailable");
      context.transcript(file);
      return child;
    },
  };
}

/** The prompt promise includes retries. A final SDK settlement is required too. */
export function wrapSession(session: AgentSession, task: string, context: RunContext): Child {
  let settled = false;
  let toolErrors = 0;
  const tools = new Map<string, string>();
  const unsubscribe = session.subscribe(event => {
    if (event.type === "message_end") {
      const line = formatMessage(event.message);
      if (line) context.preview(line);
      return;
    }
    if (event.type === "agent_settled") { settled = true; return; }
    if (event.type === "tool_execution_start") tools.set(event.toolCallId, event.toolName);
    else if (event.type === "tool_execution_end") { tools.delete(event.toolCallId); if (event.isError) toolErrors++; }
    else return;
    context.progress([...tools.values()].at(-1));
  });
  const abort = () => { void session.abort().catch(() => { /* Manager independently awaits and checks abort. */ }); };
  if (context.signal.aborted) abort(); // An already-aborted signal never fires a listener.
  else context.signal.addEventListener("abort", abort, { once: true });
  const evidence = () => {
    const { tokens, cost } = session.getSessionStats();
    return { toolErrors, usage: { input: tokens.input, output: tokens.output, cacheRead: tokens.cacheRead, cacheWrite: tokens.cacheWrite, cost } };
  };
  return {
    evidence,
    async prompt() {
      context.signal.throwIfAborted();
      settled = false; // Settlement is this turn's contract, not process lifetime.
      // Bypass prompt-template expansion/extension commands for a literal brief.
      await session.prompt(task, { expandPromptTemplates: false });
      context.signal.throwIfAborted();
      const last = session.messages.filter(message => message.role === "assistant").at(-1);
      if (!settled) throw new Error("SDK prompt returned without final settlement evidence");
      if (!last || last.stopReason === "error" || last.stopReason === "aborted") throw new Error(last?.errorMessage || "Child failed without a final assistant response");
      const report = session.getLastAssistantText();
      if (!report?.trim()) throw new Error("Child settled without a nonempty report");
      return { report, toolErrors }; // Usage is collected once, during final cleanup.
    },
    steer: message => session.steer(message),
    abort: () => session.abort(),
    dispose() {
      context.signal.removeEventListener("abort", abort);
      unsubscribe();
      return session.dispose(); // The manager awaits teardown before confirming cleanup.
    },
  };
}
