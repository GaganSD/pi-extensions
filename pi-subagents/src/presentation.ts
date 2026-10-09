import { isLive, type RunRecord } from "./types.ts";

export function safeText(value: string, max = 180): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e-\u200f\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, max);
}
export function taskTitle(task: string): string {
  return safeText(task.split(/\r?\n/)[0] ?? task, 72).replace(/\s+/g, " ").trim();
}
export function stateLabel(run: RunRecord): string {
  if (run.question) return "Needs reply";
  if (run.state === "completed" && run.notificationError) return "Finished · report saved · delivery warning";
  return ({ starting: "Starting", running: "Running", waiting_for_agent: "Needs reply", cancelling: "Stopping",
    cleanup_unknown: "Cleanup unknown", completed: "Finished · report saved", failed: "Failed", cancelled: "Cancelled" })[run.state];
}
export interface Draft { text: string; questionId?: string; scroll: number; expanded: boolean; pageEnd?: number }
/** Presentation only: exact UUIDs still route every action through the manager. */
export class HumanState {
  private readonly ordinals = new Map<string, number>();
  private readonly read = new Map<string, string>();
  readonly drafts = new Map<string, Draft>();
  selected?: string;
  open?: string;
  remember(runs: RunRecord[]): void {
    for (const run of runs) if (!this.ordinals.has(run.id)) this.ordinals.set(run.id, this.ordinals.size + 1);
  }
  name(run: RunRecord): string {
    this.remember([run]);
    const role = safeText(run.agent, 32);
    return `${role.charAt(0).toUpperCase()}${role.slice(1)} ${this.ordinals.get(run.id)}`;
  }
  title(run: RunRecord): string { return `${this.name(run)} · ${taskTitle(run.task)}`; }
  markRead(run: RunRecord): void { this.read.set(run.id, this.revision(run)); }
  unread(run: RunRecord): boolean { return this.read.get(run.id) !== this.revision(run); }
  visible(runs: RunRecord[]): RunRecord[] {
    this.remember(runs);
    return runs.filter(run => isLive(run.state));
  }
  recent(runs: RunRecord[]): RunRecord[] {
    return runs.filter(run => !isLive(run.state) && !this.unread(run) && run.id !== this.selected && run.id !== this.open).slice(-6).reverse();
  }
  draft(run: RunRecord): Draft {
    let draft = this.drafts.get(run.id);
    if (!draft) { draft = { text: "", questionId: run.question?.id, scroll: 0, expanded: false }; this.drafts.set(run.id, draft); }
    return draft;
  }
  private revision(run: RunRecord): string { return `${run.state}:${run.question?.id ?? ""}:${run.endedAt ?? ""}:${run.error ?? ""}:${run.notificationError ?? ""}`; }
}
