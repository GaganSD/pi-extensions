import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { applyPatch } from "diff";
import {
  createEditToolDefinition, createWriteToolDefinition, withFileMutationQueue,
  type ExtensionAPI, type ExtensionContext, type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { DIFF_MAX_BYTES, readDiffConfig } from "../extensions/pi-slate/diff-config.ts";
import { DiffHighlighter } from "../extensions/pi-slate/diff-highlight.ts";
import { DiffView } from "../extensions/pi-slate/diff-renderer.ts";
import { createDiffTools, installDiff } from "../extensions/pi-slate/diff.ts";

const config = readDiffConfig({});
const bounded = { timeout: 10_000 };
const plain = (component: Component) => component.render(120).map((line) => stripVTControlCharacters(line).trimEnd()).join("\n");
const unused = (): never => { throw new Error("Unexpected use of a session service in a tool test"); };

// Real tools need only cwd/mode; fail loudly if they begin using session services.
function context(cwd: string, mode: ExtensionContext["mode"] = "tui"): ExtensionContext {
  return {
    cwd, mode, hasUI: mode === "tui" || mode === "rpc", model: undefined, scopedModels: [], signal: undefined,
    get ui() { return unused(); },
    get sessionManager() { return unused(); },
    get modelRegistry() { return unused(); },
    isIdle: unused, isProjectTrusted: unused, abort: unused, hasPendingMessages: unused,
    shutdown: unused, getContextUsage: unused, compact: unused, getSystemPrompt: unused,
  };
}

type NativeRenderContext = Parameters<NonNullable<ReturnType<typeof createEditToolDefinition>["renderResult"]>>[3];
type RenderContext<TArgs> = Omit<NativeRenderContext, "args"> & { args: TArgs };

function renderContext<TArgs>(cwd: string, args: TArgs, overrides: Partial<RenderContext<TArgs>> = {}): RenderContext<TArgs> {
  return {
    cwd, args, toolCallId: "render", invalidate() {}, lastComponent: undefined, state: {},
    executionStarted: true, argsComplete: true, isPartial: false, expanded: false,
    showImages: false, isError: false, ...overrides,
  };
}

// The renderers use just these two Theme methods; no theme loader or user settings are needed.
const themeMethods: Pick<Theme, "fg" | "bold"> = { fg: (_color, text) => text, bold: (text) => text };
const theme = themeMethods as Theme;

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "slate-diff-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "wrapped");
  const nativeCwd = join(root, "native");
  await Promise.all([mkdir(cwd), mkdir(nativeCwd)]);
  assert.notEqual(cwd, process.cwd());
  const highlighter = new DiffHighlighter();
  t.after(() => highlighter.dispose());
  return {
    cwd, nativeCwd, ctx: context(cwd), nativeCtx: context(nativeCwd),
    tools: createDiffTools(config, highlighter),
    native: { edit: createEditToolDefinition(process.cwd()), write: createWriteToolDefinition(process.cwd()) },
  };
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

test("diff definitions preserve native schemas, model prompts, and argument preparation", bounded, async (t) => {
  const { tools, native } = await fixture(t);
  for (const name of ["edit", "write"] as const) {
    for (const key of ["name", "label", "description", "promptSnippet", "promptGuidelines", "constrainedSampling", "executionMode"] as const) {
      assert.deepEqual(tools[name][key], native[name][key], `${name}.${key}`);
    }
    assert.equal(tools[name].parameters, native[name].parameters);
    assert.equal(tools[name].prepareArguments, native[name].prepareArguments);
    assert.equal(tools[name].renderShell, "default");
    assert.notEqual(tools[name].renderCall, native[name].renderCall);
    assert.notEqual(tools[name].renderResult, native[name].renderResult);
  }
});

test("TUI write executes creation, overwrite, content deletion, empty files, and CRLF/BOM writes", bounded, async (t) => {
  const f = await fixture(t);
  const cases: Array<{ name: string; before?: string; after: string }> = [
    { name: "creation", after: "new\n" },
    { name: "overwrite", before: "old\nkept\n", after: "new\nkept\n" },
    { name: "deletion", before: "remove me", after: "" },
    { name: "empty-creation", after: "" },
    { name: "empty-overwrite", before: "", after: "" },
    { name: "crlf-bom", before: "\uFEFFold\r\n", after: "\uFEFFnew\r\n" },
    { name: "terminal-newline", before: "line", after: "line\n" },
  ];
  for (const { name, before, after } of cases) {
    await t.test(name, async () => {
      const path = `nested/${name}.txt`;
      if (before !== undefined) {
        for (const cwd of [f.cwd, f.nativeCwd]) {
          await mkdir(join(cwd, "nested"), { recursive: true });
          await writeFile(join(cwd, path), before);
        }
      }
      const args = { path, content: after };
      const result = await f.tools.write.execute(name, args, undefined, undefined, f.ctx);
      const native = await f.native.write.execute(name, args, undefined, undefined, f.nativeCtx);
      assert.deepEqual(result.content, native.content);
      assert.equal(native.details, undefined);
      const patch = result.details?.slateDiff.patch;
      assert.equal(typeof patch, "string");
      assert.equal(applyPatch(before ?? "", patch!), after);
      assert.equal(result.details?.slateDiff.note, undefined);
      assert.deepEqual(await readFile(join(f.cwd, path)), Buffer.from(after));
      assert.equal((await stat(join(f.cwd, path))).isFile(), true, "empty writes must not unlink the file");
    });
  }
});

test("TUI writes still succeed when bounded or binary snapshots cannot be displayed", bounded, async (t) => {
  const f = await fixture(t);
  const large = "x".repeat(DIFF_MAX_BYTES + 1);
  for (const [name, before, after, note] of [
    ["large-before", large, "new", /previous content.*larger/],
    ["binary-before", "old\0binary", "new", /previous content.*binary/],
    ["large-after", "old", large, /exceeds 256 KiB/],
    ["binary-after", "old", "new\0binary", /binary content/],
  ] as const) {
    await t.test(name, async () => {
      const args = { path: `${name}.txt`, content: after };
      await writeFile(join(f.cwd, args.path), before);
      await writeFile(join(f.nativeCwd, args.path), before);
      const result = await f.tools.write.execute(name, args, undefined, undefined, f.ctx);
      const native = await f.native.write.execute(name, args, undefined, undefined, f.nativeCtx);
      assert.deepEqual(result.content, native.content);
      assert.equal(result.details?.slateDiff.patch, undefined);
      assert.match(result.details?.slateDiff.note ?? "", note);
      assert.equal((await readFile(join(f.cwd, args.path))).equals(Buffer.from(after)), true);
      const rendered = f.tools.write.renderResult!(result, { expanded: false, isPartial: false }, theme, renderContext(f.cwd, args));
      assert.ok(rendered instanceof Text);
      assert.match(plain(rendered), /Successfully wrote/);
      assert.match(plain(rendered), /Diff preview/);
    });
  }
});

test("invalid UTF-8 previous content is treated as unreadable, not as replacement characters", bounded, async (t) => {
  const f = await fixture(t);
  const args = { path: "invalid-utf8.bin", content: "new\n" };
  await writeFile(join(f.cwd, args.path), Buffer.from([0x61, 0xff, 0x62]));
  const result = await f.tools.write.execute("write", args, undefined, undefined, f.ctx);
  assert.equal(result.details?.slateDiff.patch, undefined);
  assert.match(result.details?.slateDiff.note ?? "", /previous content/);
  assert.doesNotMatch(result.details?.slateDiff.note ?? "", /\uFFFD/);
  assert.equal(await readFile(join(f.cwd, args.path), "utf8"), args.content);
});

test("same-file TUI snapshots are ordered inside the native mutation queue", bounded, async (t) => {
  const f = await fixture(t);
  const path = "queued.txt";
  const entered = gate();
  const release = gate();
  t.after(release.release);
  await writeFile(join(f.cwd, path), "initial\n");
  const native = createWriteToolDefinition(f.cwd, { operations: {
    mkdir: async (dir) => { await mkdir(dir, { recursive: true }); },
    writeFile: async (absolutePath, content) => {
      entered.release();
      await release.promise;
      await writeFile(absolutePath, content);
    },
  } });
  const first = native.execute("native", { path, content: "native\n" }, undefined, undefined, f.ctx);
  await entered.promise;
  const contents = ["first\n", "second\n", "third\n"];
  const writes = contents.map((content, i) => f.tools.write.execute(`wrapped-${i}`, { path, content }, undefined, undefined, f.ctx));
  release.release();
  const [, ...results] = await Promise.all([first, ...writes]);
  let before = "native\n";
  for (const [i, result] of results.entries()) {
    const patch = result.details?.slateDiff.patch;
    assert.equal(typeof patch, "string");
    assert.equal(applyPatch(before, patch!), contents[i], `snapshot ${i} must include the preceding queued write`);
    before = contents[i];
  }
  assert.equal(await readFile(join(f.cwd, path), "utf8"), contents.at(-1));
});

test("multi-edit preserves native original-file matching, model content, and patch details", bounded, async (t) => {
  const f = await fixture(t);
  const before = "alpha\nkept\nomega\n";
  const args = { path: "multi.txt", edits: [{ oldText: "alpha", newText: "omega" }, { oldText: "omega", newText: "alpha" }] };
  for (const cwd of [f.cwd, f.nativeCwd]) await writeFile(join(cwd, args.path), before);
  const result = await f.tools.edit.execute("edit", args, undefined, undefined, f.ctx);
  const native = await f.native.edit.execute("edit", args, undefined, undefined, f.nativeCtx);
  assert.deepEqual(result, native);
  assert.ok(result.details?.patch);
  assert.equal(applyPatch(before, result.details.patch), "omega\nkept\nalpha\n");
  assert.equal(await readFile(join(f.cwd, args.path), "utf8"), "omega\nkept\nalpha\n");
});

test("legacy and model-shaped edit arguments normalize exactly like native before execution", bounded, async (t) => {
  const f = await fixture(t);
  const edit = { oldText: "alpha", newText: "ALPHA" };
  const cases = [
    { name: "legacy", input: edit, after: "ALPHA\nbeta\n" },
    { name: "single-object", input: { edits: edit }, after: "ALPHA\nbeta\n" },
    { name: "json-array", input: { edits: JSON.stringify([edit]) }, after: "ALPHA\nbeta\n" },
    { name: "json-object", input: { edits: JSON.stringify(edit) }, after: "ALPHA\nbeta\n" },
    { name: "mixed-legacy", input: { ...edit, edits: [{ oldText: "beta", newText: "BETA" }] }, after: "ALPHA\nBETA\n" },
  ];
  for (const { name, input, after } of cases) {
    await t.test(name, async () => {
      const path = `${name}.txt`;
      for (const cwd of [f.cwd, f.nativeCwd]) await writeFile(join(cwd, path), "alpha\nbeta\n");
      const raw = { path, ...input };
      const args = f.tools.edit.prepareArguments!(structuredClone(raw));
      const nativeArgs = f.native.edit.prepareArguments!(structuredClone(raw));
      assert.deepEqual(args, nativeArgs);
      assert.ok(Array.isArray(args.edits));
      assert.equal(Object.hasOwn(args, "oldText"), false);
      const result = await f.tools.edit.execute(name, args, undefined, undefined, f.ctx);
      const native = await f.native.edit.execute(name, nativeArgs, undefined, undefined, f.nativeCtx);
      assert.deepEqual(result, native);
      assert.equal(await readFile(join(f.cwd, path), "utf8"), after);
    });
  }
});

test("edit retains native CRLF/BOM bytes and renders the native normalized patch", bounded, async (t) => {
  const f = await fixture(t);
  const before = "\uFEFFalpha\r\nkept\r\nomega\r\n";
  const after = "\uFEFFALPHA\r\nkept\r\nomega\r\n";
  const args = { path: "crlf.txt", edits: [{ oldText: "alpha\nkept", newText: "ALPHA\nkept" }] };
  for (const cwd of [f.cwd, f.nativeCwd]) await writeFile(join(cwd, args.path), before);
  const result = await f.tools.edit.execute("edit", args, undefined, undefined, f.ctx);
  const native = await f.native.edit.execute("edit", args, undefined, undefined, f.nativeCtx);
  assert.deepEqual(result, native);
  assert.deepEqual(await readFile(join(f.cwd, args.path)), Buffer.from(after));
  const rendered = f.tools.edit.renderResult!(result, { expanded: false, isPartial: false }, theme, renderContext(f.cwd, args));
  assert.ok(rendered instanceof DiffView);
  await rendered.ready;
  assert.equal(rendered.patch, native.details?.patch);
  assert.equal(applyPatch("alpha\nkept\nomega\n", rendered.patch), "ALPHA\nkept\nomega\n");
});

test("relative edit/write paths resolve against ctx.cwd, not the factory process.cwd", bounded, async (t) => {
  const f = await fixture(t);
  const processCwd = process.cwd();
  const path = `ctx-${f.cwd.split(/[\\/]/).at(-2)}.txt`;
  await assert.rejects(stat(resolve(processCwd, path)), { code: "ENOENT" });
  await f.tools.write.execute("write", { path, content: "old\n" }, undefined, undefined, f.ctx);
  await f.tools.edit.execute("edit", { path, edits: [{ oldText: "old", newText: "new" }] }, undefined, undefined, f.ctx);
  assert.equal(await readFile(join(f.cwd, path), "utf8"), "new\n");
  await assert.rejects(stat(resolve(processCwd, path)), { code: "ENOENT" });
  assert.equal(process.cwd(), processCwd);
});

test("edit failures reject exactly as native and never partially mutate a file", bounded, async (t) => {
  const f = await fixture(t);
  const cases = [
    { name: "missing-file", before: undefined, edits: [{ oldText: "x", newText: "y" }] },
    { name: "ambiguous", before: "same\nsame\n", edits: [{ oldText: "same", newText: "other" }] },
    { name: "overlap", before: "abcdef\n", edits: [{ oldText: "abc", newText: "A" }, { oldText: "bc", newText: "B" }] },
    { name: "second-edit-missing", before: "alpha\nbeta\n", edits: [{ oldText: "alpha", newText: "ALPHA" }, { oldText: "absent", newText: "new" }] },
    { name: "empty-edits", before: "alpha\n", edits: [] },
  ];
  for (const { name, before, edits } of cases) {
    await t.test(name, async () => {
      const path = `${name}.txt`;
      if (before !== undefined) for (const cwd of [f.cwd, f.nativeCwd]) await writeFile(join(cwd, path), before);
      let nativeMessage = "";
      await assert.rejects(f.native.edit.execute(name, { path, edits }, undefined, undefined, f.nativeCtx), (error: unknown) => {
        assert.ok(error instanceof Error);
        nativeMessage = error.message;
        return true;
      });
      await assert.rejects(f.tools.edit.execute(name, { path, edits }, undefined, undefined, f.ctx), { message: nativeMessage });
      if (before === undefined) await assert.rejects(stat(join(f.cwd, path)), { code: "ENOENT" });
      else assert.equal(await readFile(join(f.cwd, path), "utf8"), before);
    });
  }
});

test("write filesystem failures reject without manufacturing successful diff details", bounded, async (t) => {
  const f = await fixture(t);
  const args = { path: "directory", content: "not written" };
  for (const cwd of [f.cwd, f.nativeCwd]) await mkdir(join(cwd, args.path));
  await assert.rejects(f.native.write.execute("native", args, undefined, undefined, f.nativeCtx), { code: "EISDIR" });
  await assert.rejects(f.tools.write.execute("wrapped", args, undefined, undefined, f.ctx), { code: "EISDIR" });
  assert.equal((await stat(join(f.cwd, args.path))).isDirectory(), true);
  await rm(join(f.cwd, args.path), { recursive: true });
  const recovered = await f.tools.write.execute("recovered", args, undefined, undefined, f.ctx);
  assert.equal(applyPatch("", recovered.details!.slateDiff.patch!), args.content, "failure must release the native queue");
});

test("pre-aborted native and wrapped tools reject without modifying files", bounded, async (t) => {
  const f = await fixture(t);
  const signal = AbortSignal.abort();
  for (const cwd of [f.cwd, f.nativeCwd]) await writeFile(join(cwd, "abort.txt"), "before\n");
  for (const [tools, ctx] of [[f.tools, f.ctx], [f.native, f.nativeCtx]] as const) {
    await assert.rejects(tools.write.execute("write", { path: "abort.txt", content: "after\n" }, signal, undefined, ctx), /Operation aborted/);
    await assert.rejects(tools.edit.execute("edit", { path: "abort.txt", edits: [{ oldText: "before", newText: "after" }] }, signal, undefined, ctx), /Operation aborted/);
    assert.equal(await readFile(join(ctx.cwd, "abort.txt"), "utf8"), "before\n");
    await assert.rejects(tools.write.execute("create", { path: "absent/new.txt", content: "after" }, signal, undefined, ctx), /Operation aborted/);
    await assert.rejects(stat(join(ctx.cwd, "absent")), { code: "ENOENT" });
  }
});

test("aborts while waiting for the native queue cannot return success or block the next write", bounded, async (t) => {
  const f = await fixture(t);
  const path = "queued-abort.txt";
  await writeFile(join(f.cwd, path), "before\n");
  const entered = gate();
  const release = gate();
  t.after(release.release);
  const blocker = withFileMutationQueue(join(f.cwd, path), async () => { entered.release(); await release.promise; });
  await entered.promise;
  const controller = new AbortController();
  const update = () => assert.fail("aborted tool must not emit a successful update");
  const write = f.tools.write.execute("write", { path, content: "after\n" }, controller.signal, update, f.ctx);
  const edit = f.tools.edit.execute("edit", { path, edits: [{ oldText: "before", newText: "after" }] }, controller.signal, update, f.ctx);
  const rejected = Promise.all([assert.rejects(write, /Operation aborted/), assert.rejects(edit, /Operation aborted/)]);
  controller.abort();
  release.release();
  await Promise.all([blocker, rejected]);
  assert.equal(await readFile(join(f.cwd, path), "utf8"), "before\n");
  const recovered = await f.tools.write.execute("recovered", { path, content: "recovered\n" }, undefined, undefined, f.ctx);
  assert.equal(applyPatch("before\n", recovered.details!.slateDiff.patch!), "recovered\n");
});

test("RPC, JSON, and print execution return native results without TUI write details", bounded, async (t) => {
  const f = await fixture(t);
  for (const mode of ["rpc", "json", "print"] as const) {
    await t.test(mode, async () => {
      const ctx = context(f.cwd, mode);
      const nativeCtx = context(f.nativeCwd, mode);
      const args = { path: `${mode}.txt`, content: "old\n" };
      const write = await f.tools.write.execute(mode, args, undefined, undefined, ctx);
      const nativeWrite = await f.native.write.execute(mode, args, undefined, undefined, nativeCtx);
      assert.deepEqual(write, nativeWrite);
      assert.equal(write.details, undefined);
      const editArgs = { path: args.path, edits: [{ oldText: "old", newText: "new" }] };
      const edit = await f.tools.edit.execute(mode, editArgs, undefined, undefined, ctx);
      const nativeEdit = await f.native.edit.execute(mode, editArgs, undefined, undefined, nativeCtx);
      assert.deepEqual(edit, nativeEdit);
      assert.equal(await readFile(join(f.cwd, args.path), "utf8"), "new\n");
    });
  }
});

test("edit and write render serialized native-backed details and reuse only matching views", bounded, async (t) => {
  const f = await fixture(t);
  for (const name of ["edit", "write"] as const) {
    await t.test(name, async () => {
      const path = `${name}.txt`;
      await writeFile(join(f.cwd, path), "old\n");
      // A single argument object satisfies both native schemas without loosening their types.
      const args = { path, content: "new\n", edits: [{ oldText: "old", newText: "new" }] };
      const tool = f.tools[name];
      const result = await tool.execute(name, args, undefined, undefined, f.ctx);
      const restored: typeof result = JSON.parse(JSON.stringify(result));
      const serializedPatch = restored.details && ("slateDiff" in restored.details ? restored.details.slateDiff.patch : restored.details.patch);
      let redraws = 0;
      const ctx = renderContext(f.cwd, args, { invalidate() { redraws++; } });
      // Split the union at the renderer boundary to retain each native details type.
      const render = (expanded: boolean, lastComponent?: Component, renderArgs = args) => {
        const options = { expanded, isPartial: false };
        const current = { ...ctx, args: renderArgs, expanded, lastComponent };
        return name === "edit"
          ? f.tools.edit.renderResult!(restored as Awaited<ReturnType<typeof f.tools.edit.execute>>, options, theme, current)
          : f.tools.write.renderResult!(restored as Awaited<ReturnType<typeof f.tools.write.execute>>, options, theme, current);
      };
      const view = render(false);
      assert.ok(view instanceof DiffView);
      await view.ready;
      assert.equal(redraws, 1);
      assert.equal(view.patch, serializedPatch);
      assert.equal(view.path, path);
      assert.equal(view.kind, name);
      assert.match(plain(view), name === "edit" ? /diff · split/ : /diff · unified/);
      assert.equal(render(false, view), view);
      const expanded = render(true, view);
      assert.ok(expanded instanceof DiffView);
      assert.notEqual(expanded, view);
      await expanded.ready;
      assert.equal(expanded.expanded, true);
      const otherPath = render(false, view, { ...args, path: "other.txt" });
      assert.ok(otherPath instanceof DiffView);
      assert.notEqual(otherPath, view);
      await otherPath.ready;
      assert.equal(otherPath.path, "other.txt");
    });
  }
});

test("renderers prioritize partial and error paths over successful patch details", bounded, async (t) => {
  const f = await fixture(t);
  const args = { path: "render.txt", content: "new\n", edits: [{ oldText: "new", newText: "edited" }] };
  const write = await f.tools.write.execute("write", args, undefined, undefined, f.ctx);
  const edit = await f.tools.edit.execute("edit", args, undefined, undefined, f.ctx);
  const ctx = renderContext(f.cwd, args);
  const options = { expanded: false, isPartial: false };
  for (const [tool, result, message] of [[f.tools.write, write, "Writing…"], [f.tools.edit, edit, "Editing…"]] as const) {
    // Both renderers accept absent details, even for historical or failed tool messages.
    const partial = tool.renderResult!({ ...result, details: undefined }, { ...options, isPartial: true }, theme, { ...ctx, isPartial: true });
    assert.ok(partial instanceof Text);
    assert.equal(plain(partial), message);
    const fallback = tool.renderResult!({ ...result, details: undefined }, options, theme, ctx);
    assert.ok(fallback instanceof Text);
    assert.match(plain(fallback), /Successfully/);
    const call = tool.renderCall!({ ...args, path: "evil\x1b[2J.txt" }, theme, ctx);
    assert.match(plain(call), /evil\\x1b\[2J\.txt/);
  }
  const failure = [{ type: "text" as const, text: "failed\x1b[2J\nnot successful" }];
  const errorCtx = { ...ctx, isError: true };
  const errors = [
    f.tools.write.renderResult!({ ...write, content: failure }, options, theme, errorCtx),
    f.tools.edit.renderResult!({ ...edit, content: failure }, options, theme, errorCtx),
    f.tools.write.renderResult!({ content: failure, details: { slateDiff: { note: "must not append a success preview" } } }, options, theme, errorCtx),
  ];
  for (const error of errors) {
    assert.ok(error instanceof Text);
    assert.equal(plain(error), "failed\\x1b[2J\nnot successful");
    assert.doesNotMatch(plain(error), /diff ·|success preview/);
  }
  const partialWrite = f.tools.write.renderResult!(write, { ...options, isPartial: true }, theme, { ...ctx, isPartial: true });
  const partialEdit = f.tools.edit.renderResult!(edit, { ...options, isPartial: true }, theme, { ...ctx, isPartial: true });
  assert.equal(plain(partialWrite), "Writing…");
  assert.equal(plain(partialEdit), "Editing…");
});

test("disabled diff registers neither overrides nor shutdown hooks", () => {
  const previous = process.env.SLATE_DIFF_ENABLED;
  let registered = 0;
  let hooks = 0;
  const api: Pick<ExtensionAPI, "registerTool" | "on"> = {
    registerTool() { registered++; },
    on() { hooks++; },
  };
  try {
    for (const disabled of ["0", "false", "OFF"]) {
      process.env.SLATE_DIFF_ENABLED = disabled;
      installDiff(api as ExtensionAPI);
    }
    delete process.env.SLATE_DIFF_ENABLED;
    installDiff(api as ExtensionAPI, { enabled: false });
    assert.equal(registered, 0);
    assert.equal(hooks, 0);
  } finally {
    if (previous === undefined) delete process.env.SLATE_DIFF_ENABLED;
    else process.env.SLATE_DIFF_ENABLED = previous;
  }
});
