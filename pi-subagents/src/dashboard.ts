import type { RunRecord } from "./types.ts";

/** Optional display-only snapshot. No native sessions, credentials, or control authority leave the manager. */
export function backgroundTaskSnapshot(sessionId: string, records: readonly RunRecord[]) {
  // The display contract caps a source at 64 rows. Live/uncertain runs must not be
  // displaced by failed history when the manager's cumulative limit is larger.
  const live = records.filter(record => !["completed", "cancelled", "failed"].includes(record.state));
  const failed = records.filter(record => record.state === "failed")
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const visible = live.concat(failed.slice(0, Math.max(0, 64 - live.length)));
  return {
    version: 1 as const, source: "pi-subagents", sessionId,
    tasks: visible.slice(0, 64).map(record => ({
      id: record.id, label: `${record.agent}: ${record.task.replace(/\s+/g, " ").slice(0, 160)}`,
      kind: "subagent" as const, state: record.state === "waiting_for_agent" ? "waiting" : record.state,
      startedAt: Date.parse(record.startedAt), ...(record.pid ? { pid: record.pid } : {}),
      detail: `${record.model} · ${record.thinking}\n${record.currentTool ? `Tool: ${record.currentTool}\n` : ""}Native session: ${record.sessionId ?? "—"}\nPID is shared with the owning Pi process.\nInspect/control using /subagents ${record.id}.`,
    })),
  };
}
