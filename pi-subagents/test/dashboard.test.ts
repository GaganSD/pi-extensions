import test from "node:test";
import assert from "node:assert/strict";
import { backgroundTaskSnapshot } from "../src/dashboard.ts";
import type { RunRecord } from "../src/types.ts";

function run(state: RunRecord["state"]): RunRecord {
  return { id: state, owner: "owner", agent: "reviewer", mode: "inspect", task: "Review the changes", cwd: "/repo", workspace: "/repo", model: "fixture/test", thinking: "off", state, startedAt: "2026-10-09T12:00:00.000Z", elapsedMs: 1000, metadataPath: "/private/run.json", pid: 42, sessionId: "native-session", question: { id: "q", message: "PRIVATE QUESTION" } };
}

test("display snapshots preserve exact owner/id and state without exporting authority or private questions", () => {
  const snapshot = backgroundTaskSnapshot("owner", [run("running"), run("waiting_for_agent"), run("completed"), run("cancelled"), run("failed"), run("cleanup_unknown")]);
  assert.equal(snapshot.version, 1); assert.equal(snapshot.source, "pi-subagents"); assert.equal(snapshot.sessionId, "owner");
  assert.deepEqual(snapshot.tasks.map(task => task.state), ["running", "waiting", "cleanup_unknown", "failed"]);
  assert.equal(snapshot.tasks[0]!.id, "running"); assert.equal(snapshot.tasks[0]!.pid, 42);
  assert.equal(snapshot.tasks[0]!.startedAt, Date.parse("2026-10-09T12:00:00.000Z"));
  assert.match(snapshot.tasks[0]!.detail, /PID is shared/);
  const json = JSON.stringify(snapshot);
  for (const privateText of ["PRIVATE QUESTION", "metadataPath", "/private/run.json", "question", '"owner":', "workspace"]) assert(!json.includes(privateText));
});

test("task labels are bounded, a blank snapshot clears only this owner's source", () => {
  const snapshot = backgroundTaskSnapshot("owner", [{ ...run("starting"), task: "x ".repeat(10000) }]);
  assert(snapshot.tasks[0]!.label.length < 200);
  assert.deepEqual(backgroundTaskSnapshot("owner", []), { version: 1, source: "pi-subagents", sessionId: "owner", tasks: [] });
});

test("a large failed history cannot displace live or uncertain runs or exceed the receiver's bound", () => {
  const history = Array.from({ length: 100 }, (_, i) => ({ ...run("failed"), id: `failed-${i}`, startedAt: new Date(1000 * i).toISOString() }));
  const records = [...history, run("running"), run("waiting_for_agent"), run("cleanup_unknown")];
  const tasks = backgroundTaskSnapshot("owner", records).tasks;
  assert.equal(tasks.length, 64);
  for (const id of ["running", "waiting_for_agent", "cleanup_unknown", "failed-99"]) assert(tasks.some(task => task.id === id));
  assert(!tasks.some(task => task.id === "failed-0")); assert.equal(records[0]!.id, "failed-0", "manager records are not mutated");
});
