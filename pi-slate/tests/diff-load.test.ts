import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import { discoverAndLoadExtensions, initTheme, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { ToolExecutionComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";

test("Slate loads through Pi's real extension loader and renders completed tools in the host shell", { timeout: 30_000 }, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-slate-load-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const entry = join(dirname(fileURLToPath(import.meta.url)), "../extensions/pi-slate/index.ts");
  const loaded = await discoverAndLoadExtensions([entry], cwd, join(cwd, "agent"));
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0];
  t.after(async () => {
    for (const handler of extension.handlers.get("session_shutdown") ?? []) {
      await handler({ type: "session_shutdown" }, { mode: "print" });
    }
  });
  assert.deepEqual([...extension.tools.keys()].sort(), ["edit", "read", "write"]);
  initTheme("dark", false);
  const ctx = { cwd, mode: "tui", tools: [], executeTool: async () => { throw new Error("unused"); } } as unknown as ExtensionToolContext;
  const ui = { requestRender() {} } as TUI;
  const args = {
    path: "demo.ts", content: "const port = 3000;\n",
    edits: [{ oldText: "3000", newText: "3001" }],
  };
  for (const name of ["write", "edit"] as const) {
    const tool = extension.tools.get(name)!.definition;
    const result = await tool.execute(name, args, undefined, undefined, ctx);
    const restored = JSON.parse(JSON.stringify(result));
    const host = new ToolExecutionComponent(name, name, args, undefined, tool, ui, cwd);
    host.setArgsComplete();
    host.markExecutionStarted();
    host.updateResult({ ...restored, isError: false });
    host.setExpanded(true);
    for (const width of [30, 80, 140]) {
      const lines = host.render(width);
      const text = lines.map(stripVTControlCharacters).join("\n");
      assert.match(text, /diff ·/);
      assert.doesNotMatch(text, /Pi-Diff/);
      assert.match(text, name === "edit" && width === 140 ? /split/ : /unified/);
      assert.match(text, name === "edit" ? /3001/ : /3000/);
      for (const line of lines) assert.ok(visibleWidth(line) <= width, `host overflow at ${width}`);
    }
  }
  const read = extension.tools.get("read")!.definition;
  for (const handler of extension.handlers.get("tool_call") ?? []) {
    await handler({ type: "tool_call", toolName: "read", toolCallId: "r1", input: { path: "a.ts" } }, ctx);
    await handler({ type: "tool_call", toolName: "read", toolCallId: "r2", input: { path: "b.ts" } }, ctx);
  }
  const lead = new ToolExecutionComponent("read", "r1", { path: "a.ts" }, undefined, read, ui, cwd);
  const follow = new ToolExecutionComponent("read", "r2", { path: "b.ts" }, undefined, read, ui, cwd);
  for (const host of [lead, follow]) {
    host.setArgsComplete();
    host.markExecutionStarted();
    host.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });
  }
  assert.match(lead.render(80).map(stripVTControlCharacters).join("\n"), /read 2 files/);
  assert.deepEqual(follow.render(80).map(stripVTControlCharacters), []);
  lead.setExpanded(true);
  assert.match(lead.render(80).map(stripVTControlCharacters).join("\n"), /a\.ts/);

  // Exercise the real native failure and host shell, not just a renderer mock.
  let failure = "";
  try {
    await read.execute("r2", { path: "missing.ts" }, undefined, undefined, ctx);
    assert.fail("missing read should throw");
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  assert.match(failure, /ENOENT|not found/);
  follow.updateResult({ content: [{ type: "text", text: failure }], isError: true });
  lead.updateResult({ content: [{ type: "text", text: failure }], isError: true });
  lead.setExpanded(true);
  const failedLead = lead.render(80).map(stripVTControlCharacters).join("\n");
  assert.match(failedLead, /read a\.ts/);
  assert.match(failedLead, /b\.ts/);
  assert.match(failedLead, /ENOENT|not found/);

  for (const expanded of [false, true]) {
    follow.setExpanded(expanded);
    const lines = follow.render(80);
    const text = lines.map(stripVTControlCharacters).join("\n");
    assert.match(text, /read b\.ts/);
    assert.match(text, /ENOENT|not found/);
    for (const line of lines) assert.ok(visibleWidth(line) <= 80);
  }
});
