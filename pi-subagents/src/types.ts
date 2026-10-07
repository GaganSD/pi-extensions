export type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly Thinking[];
export type Mode = "inspect" | "edit";
export interface Profile {
  name: string;
  description: string;
  mode: Mode;
  model?: string;
  thinking?: Thinking;
  prompt: string;
  source: string;
}
export interface Task { agent: string; task: string; cwd?: string; model?: string; thinking?: Thinking }
export interface Config { maxConcurrent: number; maxRuns: number; timeoutMs: number }
export type State = "starting" | "running" | "waiting_for_agent" | "cancelling"
  | "completed" | "failed" | "cancelled" | "cleanup_unknown";
export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }
export interface Question { id: string; message: string }
export interface RunRecord {
  id: string;
  owner: string;
  agent: string;
  mode: Mode;
  task: string;
  cwd: string;
  workspace: string;
  model: string;
  thinking: Thinking;
  state: State;
  startedAt: string;
  endedAt?: string;
  elapsedMs: number;
  currentTool?: string;
  question?: Question;
  reportPath?: string;
  sessionPath?: string;
  metadataPath: string;
  error?: string;
  notificationError?: string;
  usage?: Usage;
  toolErrors?: number;
}
export interface SubAgentResult { report: string; usage?: Usage; toolErrors: number }
export interface SubAgent {
  prompt(): Promise<SubAgentResult>;
  steer(message: string): Promise<string>;
  abort(): Promise<void>;
  evidence?(): Pick<SubAgentResult, "usage" | "toolErrors">;
  dispose(): void | Promise<void>;
}
export const PREVIEW_LINES = 24;
export interface RunContext {
  signal: AbortSignal;
  directory: string;
  /** Transfer cleanup ownership before startup validation can fail. */
  own(subAgent: SubAgent): void;
  progress(tool?: string): void;
  preview(line: string): void;
  transcript(path: string): void;
  ask(message: string, signal?: AbortSignal): Promise<string>;
}
export interface PreparedTask extends Task {
  mode: Mode;
  cwd: string;
  workspace: string;
  model: string;
  thinking: Thinking;
  start(context: RunContext): Promise<SubAgent>;
}
export function errorText(error: unknown): string {
  return describe(error, 0);
}
function describe(error: unknown, depth: number): string {
  if (error instanceof Error) {
    const cause = error.cause !== undefined && depth < 3 ? `; cause: ${describe(error.cause, depth + 1)}` : "";
    return `${error.message}${cause}`.slice(0, 4000);
  }
  if (typeof error === "string") return error.slice(0, 4000);
  if (error && typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message.slice(0, 4000);
  }
  try { return (JSON.stringify(error) ?? String(error)).slice(0, 4000); }
  catch { return String(error).slice(0, 4000); }
}
/** True while the run still occupies concurrency and workspace capacity.
 *  cleanup_unknown stays live: cleanup was not confirmed, so the slot is never released. */
export function isLive(state: State): boolean {
  return !["completed", "failed", "cancelled"].includes(state);
}
