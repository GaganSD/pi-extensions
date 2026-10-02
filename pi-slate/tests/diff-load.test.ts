import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import { discoverAndLoadExtensions, initTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
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
  assert.deepEqual([...extension.tools.keys()].sort(), ["edit", "write"]);
  initTheme("dark", false);
  const ctx = { cwd, mode: "tui" } as ExtensionContext;
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
});
