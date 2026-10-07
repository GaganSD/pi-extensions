import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import type { ArtifactStore } from "../src/artifacts.ts";
import type { SubAgentResult, PreparedTask, RunContext, RunRecord } from "../src/types.ts";

export async function temp(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "minimal-subagents-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export async function until(condition: () => boolean, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Test condition timed out");
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}
export class MemoryStore implements ArtifactStore {
  records = new Map<string, RunRecord>();
  reports = new Map<string, string>();
  failCreate = false;
  failReport = false;
  failCompleted = false;
  directory(id: string) { return "/private-test-artifacts/" + id; }
  async create(record: RunRecord, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.failCreate) throw new Error("allocation failed");
    await this.save(record, signal);
  }
  async save(record: RunRecord, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.failCompleted && record.state === "completed") throw new Error("disk full");
    this.records.set(record.id, structuredClone(record));
  }
  async report(id: string, report: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.failReport || !report.trim()) throw new Error("report save failed");
    this.reports.set(id, report);
    return this.directory(id) + "/report.md";
  }
}
export function plan(prompt: (context: RunContext) => Promise<SubAgentResult> = async () => ({ report: "Evidence report", toolErrors: 0 }), overrides: Partial<PreparedTask> = {}): PreparedTask {
  return {
    agent: "reviewer", mode: "inspect", task: "Review", cwd: "/repo", workspace: "/repo", model: "fixture/test", thinking: "off",
    async start(context) {
      context.transcript(context.directory + "/transcript/test.jsonl");
      return { prompt: () => prompt(context), steer: async () => "queued", abort: async () => {}, dispose() {} };
    },
    ...overrides,
  };
}
export function waitForAbort(context: RunContext): Promise<SubAgentResult> {
  return new Promise((_resolve, reject) => {
    if (context.signal.aborted) reject(context.signal.reason);
    else context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
  });
}
