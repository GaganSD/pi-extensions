import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, parseConfig } from "../src/config.ts";
import { RunManager, type ManagerOptions } from "../src/runs.ts";
import { isLive, type Child, type ChildResult, type RunRecord } from "../src/types.ts";
import { deferred, MemoryStore, plan, until, waitForAbort } from "./helpers.ts";

function setup(options: Partial<ManagerOptions> = {}) {
  const store = new MemoryStore();
  const notifications: { record: RunRecord; kind: string }[] = [];
  const manager = new RunManager({ owner: "test-parent", config: { ...DEFAULT_CONFIG }, store,
    notify: async (record, kind) => { notifications.push({ record, kind }); }, ...options });
  return { manager, store, notifications };
}

test("completion means saved output, with transcript/evidence and exactly one notification", async () => {
  const { manager, store, notifications } = setup();
  const [id] = await manager.launch([plan()]);
  await manager.settled(id!);
  const result = manager.status(id!);
  assert.equal(result.state, "completed");
  assert(!("validation" in result));
  assert(result.sessionPath?.endsWith("test.jsonl"));
  assert.equal(store.reports.get(id!), "Evidence report");
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]!.record.state, "completed");
  assert.equal(manager.activeCount, 0);
  result.state = "failed";
  assert.equal(manager.status(id!).state, "completed", "snapshots cannot mutate registry");
});

test("conflicting writers are rejected before any child starts", async () => {
  const { manager } = setup();
  let starts = 0;
  const worker = plan(async () => { starts++; return { report: "x", toolErrors: 0 }; }, { mode: "edit", agent: "worker" });
  await assert.rejects(manager.launch([worker, plan()]), /Conflicting/);
  assert.equal(starts, 0);
  assert.equal(manager.list().length, 0);
});

test("inspectors can overlap, writers in separate workspaces can overlap", async () => {
  const { manager } = setup();
  const first = await manager.launch([plan(waitForAbort), plan(waitForAbort)]);
  assert.equal(manager.activeCount, 2);
  await assert.rejects(manager.launch([plan(waitForAbort, { mode: "edit" })]), /Conflicting/);
  await manager.shutdown();
  assert(first.every(id => manager.status(id).state === "cancelled"));
  const other = setup().manager;
  const ids = await other.launch([plan(waitForAbort, { mode: "edit", workspace: "/repo-a" }), plan(waitForAbort, { mode: "edit", workspace: "/repo-b" })]);
  assert.equal(other.activeCount, 2);
  await other.shutdown();
  assert(ids.every(id => other.status(id).state === "cancelled"));
});

test("concurrent calls cannot oversubscribe; launch count never refunded", async () => {
  const { manager } = setup({ config: { ...DEFAULT_CONFIG, maxConcurrent: 1, maxRuns: 1 } });
  const results = await Promise.allSettled([manager.launch([plan(waitForAbort)]), manager.launch([plan(waitForAbort)])]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const id = manager.list()[0]!.id;
  await manager.stop(id);
  await assert.rejects(manager.launch([plan()]), /budget exhausted/);
});

test("supervisor replies require the exact owner/run/question; no fake completion", async () => {
  const { manager, notifications } = setup();
  const [id] = await manager.launch([plan(async context => {
    const answer = await context.ask("Which API?");
    assert.equal(answer, "existing");
    return { report: "Used the existing API", toolErrors: 0 };
  })]);
  await until(() => notifications.some(item => item.kind === "question"));
  assert.equal(manager.status(id!).state, "waiting_for_parent");
  const question = manager.status(id!).question!;
  await assert.rejects(manager.reply(id!, "wrong", "x"), /matching/);
  await assert.rejects(setup().manager.reply(id!, question.id, "x"), /Unknown run ID/);
  await assert.rejects(manager.steer(id!, "x"), /use reply/);
  await manager.reply(id!, question.id, "existing");
  await manager.settled(id!);
  await assert.rejects(manager.reply(id!, question.id, "again"), /matching/);
  assert.equal(manager.status(id!).state, "completed");
  assert.deepEqual(notifications.map(item => item.kind), ["question", "finished"]);
});

test("stop cancels a blocked supervisor wait; no indefinite pending request", async () => {
  const { manager } = setup();
  const [id] = await manager.launch([plan(async context => ({ report: await context.ask("Blocked"), toolErrors: 0 }))]);
  await until(() => manager.status(id!).state === "waiting_for_parent");
  await manager.stop(id!);
  assert.equal(manager.status(id!).state, "cancelled");
  assert.equal(manager.status(id!).question, undefined);
});

test("an early reply does not emit a stale empty question after persistence", async () => {
  const gate = deferred<void>();
  const store = new MemoryStore();
  const save = store.save.bind(store);
  store.save = async record => {
    if (record.state === "waiting_for_parent") await gate.promise;
    await save(record);
  };
  const { manager, notifications } = setup({ store });
  const [id] = await manager.launch([plan(async context => ({ report: await context.ask("Choose?"), toolErrors: 0 }))]);
  await until(() => manager.status(id!).state === "waiting_for_parent");
  const reply = manager.reply(id!, manager.status(id!).question!.id, "Chosen");
  gate.resolve();
  await reply; await manager.settled(id!);
  assert.equal(manager.status(id!).state, "completed");
  assert.deepEqual(notifications.map(item => item.kind), ["finished"]);
});

test("deadline includes running tools and supervisor waits", async () => {
  const { manager } = setup({ config: { ...DEFAULT_CONFIG, timeoutMs: 15 } });
  const [id] = await manager.launch([plan(async context => ({ report: await context.ask("No reply"), toolErrors: 0 }))]);
  await manager.settled(id!);
  assert.equal(manager.status(id!).state, "cancelled");
  assert.match(manager.status(id!).error!, /deadline|cancelled/i);
});

test("startup and report-save failures are failed runs, not empty success", async () => {
  const first = setup();
  const [id] = await first.manager.launch([plan(undefined, { start: async () => { throw new Error("startup exploded"); } })]);
  await first.manager.settled(id!);
  assert.equal(first.manager.status(id!).state, "failed");
  assert.match(first.manager.status(id!).error!, /startup exploded/);
  const second = setup(); second.store.failReport = true;
  const [other] = await second.manager.launch([plan()]);
  await second.manager.settled(other!);
  assert.equal(second.manager.status(other!).state, "failed");
  assert.equal(second.notifications[0]!.record.state, "failed");
});

test("terminal metadata write failure never announces completed", async () => {
  const { manager, store, notifications } = setup(); store.failCompleted = true;
  const [id] = await manager.launch([plan()]);
  await manager.settled(id!);
  assert.equal(manager.status(id!).state, "failed");
  assert.match(manager.status(id!).error!, /metadata/);
  assert.equal(notifications[0]!.record.state, "failed");
});

test("notification failure is visible without duplicating completed work", async () => {
  const { manager } = setup({ notify: async () => { throw new Error("parent delivery failed"); } });
  const [id] = await manager.launch([plan()]);
  await manager.settled(id!);
  assert.equal(manager.status(id!).state, "completed");
  assert.match(manager.status(id!).notificationError!, /delivery failed/);
});

test("allocation failure and an aborted admission launch zero children", async () => {
  const { manager, store } = setup(); store.failCreate = true;
  let starts = 0;
  await assert.rejects(manager.launch([plan(undefined, { start: async () => { starts++; throw new Error("unexpected"); } })]), /allocation failed/);
  assert.equal(starts, 0);
  assert.equal(manager.list().length, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(setup().manager.launch([plan()], controller.signal));
});

test("shutdown during allocation prevents any startup and suppresses late notification", async () => {
  const gate = deferred<void>();
  const store = new MemoryStore();
  let allocating = false;
  const create = store.create.bind(store);
  store.create = async record => { allocating = true; await gate.promise; await create(record); };
  const { manager, notifications } = setup({ store });
  const admission = manager.launch([plan()]);
  await until(() => allocating);
  await manager.shutdown(); // Allocation may stay blocked; shutdown must not.
  gate.resolve();
  await assert.rejects(admission, /shut down/);
  assert.equal(manager.list().length, 0);
  assert.equal(notifications.length, 0);
});

test("stop during slow startup disposes the late child without prompting it", async () => {
  const startup = deferred<Child>();
  let prompted = 0, disposed = 0;
  const { manager } = setup();
  const [id] = await manager.launch([plan(undefined, { start: () => startup.promise })]);
  const stop = manager.stop(id!);
  startup.resolve({ prompt: async () => { prompted++; return { report: "bad", toolErrors: 0 }; }, steer: async () => "queued", abort: async () => {}, dispose() { disposed++; } });
  await stop;
  assert.equal(prompted, 0);
  assert.equal(disposed, 1);
  assert.equal(manager.status(id!).state, "cancelled");
});

test("unknown cleanup keeps capacity and workspace reserved, and trips the process fence", async () => {
  let unsafe = 0;
  const finish = deferred<ChildResult>();
  let prompted = false;
  const { manager, notifications } = setup({ cleanupMs: 10, unsafeCleanup: () => { unsafe++; } });
  const [id] = await manager.launch([plan(() => { prompted = true; return finish.promise; }, { mode: "edit" })]);
  await until(() => prompted);
  await manager.stop(id!);
  assert.equal(manager.status(id!).state, "cleanup_unknown");
  assert.equal(manager.activeCount, 1);
  assert.equal(unsafe, 1);
  await assert.rejects(manager.launch([plan()]), /unknown cleanup/);
  finish.resolve({ report: "Too late", toolErrors: 0 });
  await manager.settled(id!);
  assert.equal(manager.status(id!).state, "cleanup_unknown");
  assert.equal(notifications.length, 1);
});

test("cleanup errors fail closed even after a valid report", async () => {
  const { manager } = setup();
  const [id] = await manager.launch([plan(undefined, { start: async () => ({
    prompt: async () => ({ report: "Valid report", toolErrors: 0 }), steer: async () => "queued",
    abort: async () => {}, dispose: () => { throw new Error("dispose failed"); },
  }) })]);
  await manager.settled(id!);
  assert.equal(manager.status(id!).state, "cleanup_unknown");
});

test("abort failure still attempts disposal and never releases uncertain capacity", async () => {
  let disposed = false;
  const { manager } = setup();
  const [id] = await manager.launch([plan(undefined, { start: async () => ({
    prompt: async () => ({ report: "Report", toolErrors: 0 }), steer: async () => "queued",
    abort: async () => { throw new Error("abort failed"); }, dispose: () => { disposed = true; },
  }) })]);
  await manager.settled(id!);
  assert(disposed);
  assert.equal(manager.status(id!).state, "cleanup_unknown");
  assert.equal(manager.activeCount, 1);
});

test("settled headers remain addressable, and shutdown cannot relaunch", async () => {
  const { manager } = setup({ config: parseConfig({ historyLimit: 1 }) });
  const [live] = await manager.launch([plan(waitForAbort)]);
  for (let i = 0; i < 3; i++) {
    const [id] = await manager.launch([plan()]);
    await manager.settled(id!);
  }
  assert.equal(manager.list().length, 4);
  assert.equal(manager.status(live!).state, "running");
  await manager.shutdown();
  await assert.rejects(manager.launch([plan()]), /closed/);
});

test("out-of-order and failed siblings keep ID-keyed results; success is not erased", async () => {
  const first = deferred<ChildResult>();
  const { manager, store, notifications } = setup();
  const [idA, idB] = await manager.launch([
    plan(() => first.promise, { cwd: "/wt-a", workspace: "/wt-a", task: "A" }),
    plan(async () => { throw new Error("worker B exploded"); }, { cwd: "/wt-b", workspace: "/wt-b", task: "B" }),
  ]);
  await manager.settled(idB!);
  assert.equal(manager.status(idB!).state, "failed");
  assert.match(manager.status(idB!).error!, /exploded/);
  assert.ok(isLive(manager.status(idA!).state));
  assert.equal(notifications[0]!.record.id, idB);
  first.resolve({ report: "A ok", toolErrors: 0 });
  await manager.settled(idA!);
  assert.equal(manager.status(idA!).state, "completed");
  assert.equal(store.reports.get(idA!), "A ok");
  assert.equal(store.reports.has(idB!), false);
  assert.deepEqual(notifications.map(item => item.record.id), [idB, idA]);
});

test("admitted runs stay inspectable after the caller drops the receipt", async () => {
  const { manager } = setup();
  await manager.launch([plan(undefined, { task: "Keep me" })]);
  const listed = manager.list();
  assert.equal(listed.length, 1);
  await manager.settled(listed[0]!.id);
  assert.equal(manager.status(listed[0]!.id).state, "completed");
  assert.equal(manager.status(listed[0]!.id).task, "Keep me");
});

test("launch returns before a slow child finishes; fast completion stays inspectable", async () => {
  const gate = deferred<ChildResult>();
  const { manager, notifications } = setup();
  const [slow] = await manager.launch([plan(() => gate.promise, { workspace: "/slow", cwd: "/slow" })]);
  assert.equal(notifications.length, 0);
  assert.ok(isLive(manager.status(slow!).state));
  const [fast] = await manager.launch([plan(undefined, { workspace: "/fast", cwd: "/fast", task: "Fast" })]);
  await manager.settled(fast!);
  assert.equal(manager.status(fast!).state, "completed");
  assert.equal(manager.status(slow!).state, "running");
  assert.equal(notifications[0]!.record.id, fast);
  gate.resolve({ report: "slow done", toolErrors: 0 });
  await manager.settled(slow!);
  assert.equal(manager.status(slow!).state, "completed");
});

test("cumulative admissions restored after reload cannot be reset by a new manager", async () => {
  let persisted = 0;
  const { manager } = setup({ admitted: 31, recordAdmissions: count => { persisted = count; } });
  const [id] = await manager.launch([plan()]); await manager.settled(id!);
  assert.equal(persisted, 32);
  await assert.rejects(setup({ admitted: persisted }).manager.launch([plan()]), /budget exhausted/);
});

test("cleanup poisoning during allocation prevents another child from starting", async () => {
  const store = new MemoryStore(), allocation = deferred<void>(), done = deferred<ChildResult>();
  const create = store.create.bind(store);
  let creates = 0, allocating = false, starts = 0;
  store.create = async (record, signal) => {
    if (++creates === 2) { allocating = true; await allocation.promise; }
    await create(record, signal);
  };
  const { manager } = setup({ store });
  const [first] = await manager.launch([plan(undefined, { start: async () => ({
    prompt: () => done.promise, steer: async () => "queued", abort: async () => {},
    dispose() { throw new Error("Unconfirmed disposal"); },
  }) })]);
  const admission = manager.launch([plan(undefined, { workspace: "/other", start: async () => { starts++; throw new Error("Must not start"); } })]);
  const rejected = assert.rejects(admission, /unknown cleanup/);
  await until(() => allocating);
  done.resolve({ report: "First output", toolErrors: 0 });
  await manager.settled(first!);
  allocation.resolve();
  await rejected;
  assert.equal(starts, 0);
  assert.equal(manager.list().length, 1);
});

test("process fence is checked after allocation, including other managers", async () => {
  let blocked = false;
  const store = new MemoryStore();
  const create = store.create.bind(store);
  store.create = async (record, signal) => { await create(record, signal); blocked = true; };
  const { manager } = setup({ store, assertLaunchable: () => { if (blocked) throw new Error("Process cleanup fence"); } });
  await assert.rejects(manager.launch([plan()]), /Process cleanup fence/);
  assert.equal(manager.list().length, 0);
});

test("startup transfers cleanup ownership before validation can fail", async () => {
  let unsafe = 0, disposed = 0;
  const { manager } = setup({ unsafeCleanup: () => { unsafe++; } });
  const [id] = await manager.launch([plan(undefined, { start: async context => {
    context.own({ prompt: async () => { throw new Error("Must not prompt"); }, steer: async () => "queued",
      abort: async () => { throw new Error("Startup abort failed"); }, dispose() { disposed++; },
    });
    throw new Error("Startup validation failed");
  } })]);
  await manager.settled(id!);
  assert.equal(manager.status(id!).state, "cleanup_unknown");
  assert.equal(manager.activeCount, 1);
  assert.equal(unsafe, 1);
  assert.equal(disposed, 1);
});

test("stop returns on its deadline despite blocked metadata I/O; late writes cannot publish success", async () => {
  const store = new MemoryStore(), gate = deferred<void>();
  const save = store.save.bind(store);
  let writing = false;
  store.save = async (record, signal) => {
    if (record.state === "running") { writing = true; await gate.promise; }
    await save(record, signal);
  };
  let unsafe = 0;
  const { manager, notifications } = setup({ store, cleanupMs: 10, unsafeCleanup: () => { unsafe++; } });
  const [id] = await manager.launch([plan()]);
  await until(() => writing);
  await Promise.race([manager.stop(id!), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Stop hung")), 200))]);
  assert.notEqual(manager.status(id!).state, "completed");
  assert.equal(manager.activeCount, 0, "known cleanup must not retain a workspace for failed publication");
  assert.equal(unsafe, 0);
  gate.resolve();
  await manager.settled(id!);
  await until(() => notifications.length === 1);
  assert.notEqual(store.records.get(id!)!.state, "completed");
  assert.notEqual(notifications[0]!.record.state, "completed");
});

test("out-of-order completion and stopping an older child retain exact IDs", async () => {
  const first = deferred<ChildResult>();
  const { manager } = setup({ config: parseConfig({ historyLimit: 1 }) });
  const [a] = await manager.launch([plan(() => first.promise)]);
  const [b] = await manager.launch([plan()]); await manager.settled(b!);
  first.resolve({ report: "Latest completion", toolErrors: 0 }); await manager.settled(a!);
  assert.equal(manager.status(a!).state, "completed");
  const [c] = await manager.launch([plan(waitForAbort)]);
  const [d] = await manager.launch([plan()]); await manager.settled(d!);
  await manager.stop(c!);
  assert.equal(manager.status(c!).state, "cancelled");
});

test("failed and cancelled children preserve available evidence before disposal", async () => {
  const usage = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.1 };
  const { manager } = setup();
  let disposed = false;
  const [id] = await manager.launch([plan(undefined, { start: async () => ({
    prompt: async () => { throw new Error("Failure after billable work"); }, steer: async () => "queued", abort: async () => {},
    evidence() { assert.equal(disposed, false); return { usage, toolErrors: 2 }; }, dispose() { disposed = true; },
  }) })]);
  await manager.settled(id!);
  assert.equal(manager.status(id!).state, "failed");
  assert.deepEqual(manager.status(id!).usage, usage);
  assert.equal(manager.status(id!).toolErrors, 2);
  assert.equal(disposed, true);
});
