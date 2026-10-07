import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadProfiles, parseProfile } from "../src/agents.ts";
import { DEFAULT_CONFIG, parseConfig } from "../src/config.ts";
import { parseCommand, resolveRun } from "../src/inspect.ts";
import { formatEntry, readTranscript } from "../src/transcript.ts";
import { parseRequest, presentLaunch } from "../src/tool.ts";
import { formatElapsed, nextLive, plain, rows } from "../src/ui.ts";
import { temp } from "./helpers.ts";

test("requests reject invalid action/field combinations", () => {
  assert.deepEqual(parseRequest({ action: "run", tasks: [{ agent: "worker", task: "Implement" }] }), { action: "run", tasks: [{ agent: "worker", task: "Implement" }] });
  assert.deepEqual(parseRequest({ action: "run", tasks: [{ agent: "worker", task: "Implement", thinking: "low" }] }), { action: "run", tasks: [{ agent: "worker", task: "Implement", thinking: "low" }] });
  for (const input of [
    { agent: "worker", task: "Old direct syntax" }, { action: "run", workflow: true },
    { action: "run", tasks: [] }, { action: "run", tasks: Array(5).fill({ agent: "worker", task: "x" }) },
    { action: "resume", id: "x" }, { action: "run", tasks: [{ agent: "worker", task: "x", async: true }] },
    { action: "list", config: {} }, { action: "stop" }, { action: "steer", id: "x" },
    { action: "reply", id: "x", message: "answer" }, { action: "run", tasks: [{ agent: "", task: "x" }] },
    { action: "run", tasks: [{ agent: "worker", task: "x", model: "alias" }] },
    { action: "run", tasks: [{ agent: "worker", task: "x", thinking: "highest" }] },
    { action: "run", tasks: [{ agent: "worker", task: "\0" }] },
  ]) assert.throws(() => parseRequest(input));
  assert.deepEqual(parseRequest({ action: "list", cwd: "../target" }), { action: "list", cwd: "../target" });
  assert.throws(() => parseRequest({ action: "status", cwd: "../target" }));
  assert.deepEqual(parseRequest({ action: "status" }), { action: "status" });
  assert.deepEqual(parseRequest({ action: "reply", id: "a", requestId: "b", message: "yes" }), { action: "reply", id: "a", requestId: "b", message: "yes" });
});

test("config is bounded and rejects unknown or unsafe limits", () => {
  assert.deepEqual(parseConfig(undefined), DEFAULT_CONFIG);
  assert.equal(parseConfig({ maxConcurrent: 2 }).maxConcurrent, 2);
  assert.deepEqual(parseConfig({ historyLimit: 1 }), DEFAULT_CONFIG, "retired history settings do not evict exact run IDs");
  for (const value of [{ maxConcurrent: 5 }, { maxRuns: 0 }, { timeoutMs: Infinity }, { timeoutMs: 500 }, { historyLimit: -1 }, { maxRuns: 1.5 }, { asyncByDefault: true }, []]) assert.throws(() => parseConfig(value));
});

const profile = (name: string, body = "Role prompt") => `---\nname: ${name}\ndescription: A role\nmode: inspect\n---\n${body}\n`;
test("only worker/reviewer bundled; user and trusted project profiles override whole definitions", async t => {
  const root = await temp(t);
  const user = path.join(root, "user");
  const repo = path.join(root, "repo");
  await mkdir(path.join(user, "agents"), { recursive: true });
  await mkdir(path.join(repo, ".pi", "agents"), { recursive: true });
  const base = await loadProfiles(user, repo, false);
  assert.deepEqual([...base.keys()].sort(), ["reviewer", "worker"]);
  assert.equal(base.get("worker")!.mode, "edit");
  await writeFile(path.join(user, "agents", "reviewer.md"), profile("reviewer", "User role"));
  await writeFile(path.join(repo, ".pi", "agents", "reviewer.md"), profile("reviewer", "Project role"));
  assert.equal((await loadProfiles(user, repo, false)).get("reviewer")!.prompt, "User role");
  assert.equal((await loadProfiles(user, repo, true)).get("reviewer")!.prompt, "Project role");
});

test("profiles reject unknown fields, malformed/duplicate YAML, mismatches and oversized prompts", () => {
  assert.equal(parseProfile(profile("reviewer"), "/roles/reviewer.md").mode, "inspect");
  for (const text of [
    profile("worker"), profile("reviewer").replace("mode: inspect", "mode: inspect\ntools: bash"),
    profile("reviewer").replace("mode: inspect", "mode: invalid"),
    profile("reviewer").replace("mode: inspect", "mode: inspect\nmode: edit"),
    profile("reviewer").replace("mode: inspect", "mode: inspect\nmodel: alias"),
    profile("reviewer").replace("mode: inspect", "mode: inspect\nthinking: highest"),
    "No YAML", profile("reviewer", "x".repeat(33000)),
  ]) assert.throws(() => parseProfile(text, "/roles/reviewer.md"));
});

test("launch receipts map each requested task to an exact run identity", () => {
  const receipt = presentLaunch([
    {
      id: "run-a", owner: "p", agent: "worker", mode: "edit", task: "A",
      cwd: "/wt-a", workspace: "/repo-a", model: "fixture/test", thinking: "off", state: "starting",
      startedAt: "t", elapsedMs: 0, metadataPath: "/a.json",
    },
    {
      id: "run-b", owner: "p", agent: "worker", mode: "edit", task: "B",
      cwd: "/wt-b", workspace: "/repo-b", model: "fixture/test", thinking: "off", state: "starting",
      startedAt: "t", elapsedMs: 0, metadataPath: "/b.json",
    },
  ]);
  assert.deepEqual(receipt.runs, [
    { id: "run-a", cwd: "/wt-a", workspace: "/repo-a", model: "fixture/test", thinking: "off" },
    { id: "run-b", cwd: "/wt-b", workspace: "/repo-b", model: "fixture/test", thinking: "off" },
  ]);
});

test("UI sanitizes terminal controls and bidi content", () => {
  assert(!plain("\u001b]title\n\u202efake").includes("\u001b"));
  assert(!plain("\u202efake").includes("\u202e"));
  assert.equal(rows([]).length, 0);
});

test("elapsed time is natural and down cycles live threads then agent", () => {
  assert.equal(formatElapsed(0), "0s");
  assert.equal(formatElapsed(12_000), "12s");
  assert.equal(formatElapsed(59_000), "59s");
  assert.equal(formatElapsed(60_000), "1m");
  assert.equal(formatElapsed(65_000), "1m 5s");
  assert.equal(formatElapsed(3_600_000), "1h");
  assert.equal(formatElapsed(3_723_000), "1h 2m");
  const live = ["aaaaaaaa-1", "bbbbbbbb-2"].map(id => ({
    id, owner: "p", agent: "worker", mode: "edit" as const, task: id, cwd: "/", workspace: "/",
    model: "fixture/test", thinking: "off" as const, state: "running" as const, startedAt: "t", elapsedMs: 65_000, metadataPath: "/m",
  }));
  assert.equal(nextLive(live, live[0]!.id), live[1]!.id);
  assert.equal(nextLive(live, live[1]!.id), undefined);
  assert.match(rows(live)[0]!, /^↓ {2}2$/);
  assert.equal(rows([live[0]!])[0], "↓  worker · PID-? starting · ?%/?");
});

test("human command parse and unique prefix attach", () => {
  assert.deepEqual(parseCommand(""), { action: "list" });
  assert.deepEqual(parseCommand("400163b5"), { action: "attach", id: "400163b5" });
  assert.deepEqual(parseCommand("stop 400163b5-6198-4959-83d3-952535a67ce3"), { action: "stop", id: "400163b5-6198-4959-83d3-952535a67ce3" });
  assert.deepEqual(parseCommand("steer 400163b5 focus on the hero"), { action: "steer", id: "400163b5", message: "focus on the hero" });
  assert.deepEqual(parseCommand("reply 400163b5 use the existing API"), { action: "reply", id: "400163b5", message: "use the existing API" });
  // The id may be a substring of the head word; the message must still start after the id token.
  assert.deepEqual(parseCommand("steer ee focus the hero"), { action: "steer", id: "ee", message: "focus the hero" });
  assert.throws(() => parseCommand("resume x"), /Usage/);
  const runs = ["aaaaaaaa-1111", "bbbbbbbb-2222"].map(id => ({
    id, owner: "p", agent: "worker", mode: "edit" as const, task: id, cwd: "/", workspace: "/",
    model: "fixture/test", thinking: "off" as const, state: "running" as const, startedAt: "t", elapsedMs: 1, metadataPath: "/m",
  }));
  assert.equal(resolveRun(runs, "aaaa").id, "aaaaaaaa-1111");
  assert.throws(() => resolveRun(runs, "zzz"), /Unknown/);
});

test("transcript extract skips session headers and keeps user/sub-agent/tool lines", async t => {
  const root = await temp(t);
  const file = path.join(root, "session.jsonl");
  await writeFile(file, [
    JSON.stringify({ type: "session", id: "s" }),
    JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "Build cat.html" }] } }),
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "write" }] } }),
    JSON.stringify({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "wrote cat.html" }] } }),
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } }),
  ].join("\n") + "\n");
  assert.deepEqual(await readTranscript(file), [
    "you   Build cat.html",
    "sub-agent tool write",
    "out   wrote cat.html",
    "sub-agent Done",
  ]);
  assert.equal(formatEntry({ type: "session" }), undefined);
  assert.deepEqual(await readTranscript(undefined), ["(no transcript yet)"]);
});

test("widget lists every live run and clears when the batch has settled", () => {
  const stub = (id: string, state: "running" | "completed"): import("../src/types.ts").RunRecord => ({
    id, owner: "p", agent: "worker", mode: "edit", task: id, cwd: "/" + id, workspace: "/" + id,
    model: "fixture/test", thinking: "off", state, startedAt: "t", elapsedMs: 1, metadataPath: "/" + id,
  });
  const live = [stub("aaaaaaaa-1", "running"), stub("bbbbbbbb-2", "running"), stub("cccccccc-3", "running")];
  assert.equal(rows(live).length, 4);
  assert.equal(rows(live.map(run => ({ ...run, state: "completed" }))).length, 0);
  assert.equal(rows([live[0]!, { ...live[1]!, state: "completed" }, { ...live[2]!, state: "completed" }]).length, 1);
});
