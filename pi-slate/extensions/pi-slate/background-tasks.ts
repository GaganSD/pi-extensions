import { record, sidebarText } from "./sidebar-data.ts";

/** Optional inter-extension contract. Snapshots replace only their named source. */
export const BACKGROUND_TASKS_EVENT = "pi:background-tasks";
export const BACKGROUND_TASKS_REQUEST = "pi:background-tasks:request";
export type BackgroundTask = {
  id: string; source: string; label: string; kind: "shell" | "terminal" | "subagent";
  state: "starting" | "running" | "waiting" | "cancelling" | "failed" | "cleanup_unknown";
  startedAt: number; pid?: number; detail?: string;
};
const STATES = new Set(["starting", "running", "waiting", "cancelling", "failed", "cleanup_unknown"]);
const KINDS = new Set(["shell", "terminal", "subagent"]);
const MAX_SOURCES = 16;
const MAX_TASKS = 64;

export class BackgroundTasks {
  private sessionId = "";
  private sources = new Map<string, BackgroundTask[]>();
  private shellCalls = new Map<string, BackgroundTask>();
  reset(sessionId: string): void { this.sessionId = sessionId; this.sources.clear(); this.shellCalls.clear(); }
  accept(value: unknown): boolean {
    const raw = record(value);
    if (raw?.version !== 1 || raw.sessionId !== this.sessionId || typeof raw.source !== "string"
      || !/^[a-zA-Z0-9_-]{1,80}$/.test(raw.source) || !Array.isArray(raw.tasks) || raw.tasks.length > MAX_TASKS) return false;
    if (!this.sources.has(raw.source) && this.sources.size >= MAX_SOURCES) return false;
    const tasks: BackgroundTask[] = [];
    const ids = new Set<string>();
    for (const value of raw.tasks) {
      const task = record(value);
      if (!task || typeof task.id !== "string" || !task.id || task.id.length > 256 || ids.has(task.id)
        || typeof task.label !== "string" || typeof task.kind !== "string" || !KINDS.has(task.kind)
        || typeof task.state !== "string" || !STATES.has(task.state)
        || typeof task.startedAt !== "number" || !Number.isFinite(task.startedAt) || task.startedAt < 0) return false;
      ids.add(task.id);
      const pid = task.pid;
      tasks.push({ id: task.id, source: raw.source, label: sidebarText(task.label, 256),
        kind: task.kind as BackgroundTask["kind"], state: task.state as BackgroundTask["state"], startedAt: task.startedAt,
        ...(typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}),
        ...(typeof task.detail === "string" ? { detail: sidebarText(task.detail, 2000) } : {}),
      });
    }
    if (JSON.stringify(this.sources.get(raw.source) ?? []) === JSON.stringify(tasks)) return false;
    if (tasks.length) this.sources.set(raw.source, tasks);
    else this.sources.delete(raw.source);
    return true;
  }
  /** In-flight foreground shells are observable; detached jobs require their owner's snapshot. */
  shellStart(id: string, name: string, args: unknown, now: number): void {
    if (!["bash", "powershell", "terminal"].includes(name) || this.shellCalls.size >= MAX_TASKS) return;
    const command = record(args)?.command;
    this.shellCalls.set(id, { id, source: "tool", label: sidebarText(command, 256) || name,
      kind: name === "terminal" ? "terminal" : "shell", state: "running", startedAt: now,
      detail: "Agent-started tool call. No detached process or PID is inferred. Completion removes this row.",
    });
  }
  shellEnd(id: string): void { this.shellCalls.delete(id); }
  clearShells(): void { this.shellCalls.clear(); }
  snapshot(): BackgroundTask[] {
    return [...this.sources.values()].flat().concat([...this.shellCalls.values()])
      .sort((a, b) => Number(b.state === "cleanup_unknown") - Number(a.state === "cleanup_unknown")
        || Number(a.state === "failed") - Number(b.state === "failed")
        || a.startedAt - b.startedAt || a.id.localeCompare(b.id));
  }
}
