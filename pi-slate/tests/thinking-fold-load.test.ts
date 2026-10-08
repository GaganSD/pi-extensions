import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { discoverAndLoadExtensions, type ExtensionContext, type ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { WORKING_WORDS } from "../extensions/pi-slate/working-words.ts";

test("loaded Slate wires thinking timing only in TUI and never rewrites native thinking labels", { timeout: 30_000 }, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-slate-thinking-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
  t.after(() => t.mock.timers.reset());
  const entry = join(dirname(fileURLToPath(import.meta.url)), "../extensions/pi-slate/index.ts");
  const loaded = await discoverAndLoadExtensions([entry], cwd, join(cwd, "agent"));
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0]!;
  const labels: Array<string | undefined> = [];
  let staleUi = false;
  const noop = () => {};
  const ui = {
    theme: { italic: (text: string) => text },
    setWorkingMessage(label?: string) {
      if (staleUi) throw new Error("stale UI context");
      labels.push(label);
    },
    setHiddenThinkingLabel() { assert.fail("must not relabel native historical or streaming thoughts"); },
    setHeader: noop, setFooter: noop, setEditorComponent: noop, setWorkingIndicator: noop,
  };
  const ctx = { cwd, mode: "tui", ui } as unknown as ExtensionContext;
  const emit = async (type: ExtensionEvent["type"], extra: Record<string, unknown> = {}, context = ctx) => {
    for (const handler of extension.handlers.get(type) ?? []) {
      await handler({ type, ...extra } as ExtensionEvent, context);
    }
  };
  t.after(() => emit("session_shutdown", {}, { mode: "print" } as ExtensionContext));
  const message = { role: "assistant", timestamp: 0, content: [{ type: "thinking", thinking: "secret reasoning" }] };
  const update = (type: string) => emit("message_update", { message, assistantMessageEvent: { type, contentIndex: 0 } });
  await emit("agent_start");
  const word = labels.at(-1)!;
  assert.ok(WORKING_WORDS.some((item) => item === word));
  await emit("message_start", { message });
  await update("thinking_start");
  t.mock.timers.tick(7000);
  assert.match(labels.at(-1)!, new RegExp(`^${word} · 7s · ↑↓\\d+$`));
  await update("thinking_end");
  assert.equal(labels.at(-1), word);
  const stopped = labels.length;
  t.mock.timers.tick(3000);
  assert.equal(labels.length, stopped);

  for (const boundary of ["message_end", "agent_end"] as const) {
    await update("thinking_start");
    t.mock.timers.tick(1000);
    assert.match(labels.at(-1)!, / · 1s/);
    await emit(boundary, { message });
    assert.equal(labels.at(-1), word);
    const count = labels.length;
    t.mock.timers.tick(3000);
    assert.equal(labels.length, count);
  }

  for (const mode of ["print", "rpc", "json"] as const) {
    const context = { ...ctx, mode } as unknown as ExtensionContext;
    const count = labels.length;
    await emit("agent_start", {}, context);
    await emit("message_start", { message }, context);
    await emit("message_update", { message, assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } }, context);
    t.mock.timers.tick(2000);
    await emit("message_end", { message }, context);
    assert.equal(labels.length, count, `no UI changes in ${mode}`);
  }

  await emit("agent_start", {}, { ...ctx, ui: { ...ui, setWorkingMessage: undefined } } as unknown as ExtensionContext);
  await emit("message_update", { message, assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
    { ...ctx, ui: { ...ui, setWorkingMessage: undefined } } as unknown as ExtensionContext);
  assert.equal(message.content[0]!.thinking, "secret reasoning");
  await emit("agent_start");
  await update("thinking_start");
  staleUi = true;
  assert.doesNotThrow(() => t.mock.timers.tick(1000));
  staleUi = false;
  const staleCount = labels.length;
  t.mock.timers.tick(3000);
  assert.equal(labels.length, staleCount, "stale UI stops its timer");
  await emit("agent_start");
  await update("thinking_start");
  await emit("session_shutdown");
  const shutdownCount = labels.length;
  t.mock.timers.tick(3000);
  assert.equal(labels.length, shutdownCount);
  await emit("session_shutdown");
  await emit("agent_start");
  const nextWord = labels.at(-1)!;
  assert.ok(WORKING_WORDS.some((item) => item === nextWord));
  await emit("message_start", { message });
  await update("thinking_start");
  t.mock.timers.tick(1000);
  assert.match(labels.at(-1)!, new RegExp(`^${nextWord} · 1s`));
});
