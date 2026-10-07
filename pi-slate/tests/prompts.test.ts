import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
  initTheme,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  getKeybindings,
  matchesKey,
  setKeybindings,
  visibleWidth,
  type Component,
  type Focusable,
  type Keybinding,
  type KeyId,
  type TUI,
} from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { installPromptPicker } from "../extensions/pi-slate/prompts.ts";

type Picker = Component & Focusable & { handleInput(data: string): void };
type Factory = (tui: TUI, theme: Theme, kb: KeybindingsManager, done: (value: string | undefined) => void) => Picker;
const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text } as Theme;

async function fixture(t: test.TestContext, files: Record<string, string>, kb = new KeybindingsManager()) {
  initTheme("dark", false);
  const dir = await mkdtemp(join(tmpdir(), "slate-prompts-"));
  const previous = getKeybindings();
  setKeybindings(kb);
  t.after(async () => { setKeybindings(previous); await rm(dir, { recursive: true, force: true }); });
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, `${name}.md`), content);
  let commands = Object.keys(files).map((name) => ({ name, source: "prompt", sourceInfo: { path: join(dir, `${name}.md`) } }));
  let handler!: (args: string, ctx: ExtensionContext) => Promise<void>;
  let shortcut!: KeyId;
  let shortcutHandler!: (ctx: ExtensionContext) => Promise<void>;
  const pasted: string[] = [];
  const notices: string[] = [];
  let opened = 0;
  let interact: (picker: Picker, done: (value: string | undefined) => void) => void = () => {};
  installPromptPicker({
    getCommands: () => commands,
    registerCommand: (_name: string, command: { handler: typeof handler }) => { handler = command.handler; },
    registerShortcut: (key: KeyId, entry: { handler: typeof shortcutHandler }) => { shortcut = key; shortcutHandler = entry.handler; },
  } as unknown as ExtensionAPI);
  const ctx = {
    mode: "tui",
    ui: {
      custom: (factory: Factory) => new Promise<string | undefined>((resolve) => {
        opened++;
        const picker = factory({ requestRender() {} } as TUI, theme, kb, resolve);
        picker.focused = true;
        interact(picker, resolve);
      }),
      pasteToEditor: (text: string) => pasted.push(text),
      notify: (text: string) => notices.push(text),
    },
  } as unknown as ExtensionContext;
  return {
    ctx, pasted, notices,
    get opened() { return opened; },
    get shortcut() { return shortcut; },
    open: () => handler("", ctx),
    shortcutOpen: () => shortcutHandler(ctx),
    interact: (next: typeof interact) => { interact = next; },
    commands: (next: typeof commands) => { commands = next; },
    path: (name: string) => join(dir, `${name}.md`),
  };
}

const textOf = (picker: Picker, width = 60) => stripVTControlCharacters(picker.render(width).join("\n"));

test("picker searches live bodies, strips frontmatter, and inserts only on confirmation", async (t) => {
  const f = await fixture(t, {
    review: "---\nname: Review code\ndescription: Inspect changes\n---\nReview ${1:-correctness}\nneedle",
    alpha: "---\nname: ''\n---\nOther body",
  });
  f.interact((picker) => {
    assert.ok(picker.render(60).join("\n").includes(CURSOR_MARKER));
    assert.match(textOf(picker), /alpha/);
    assert.doesNotMatch(textOf(picker), /Other body/);
    picker.handleInput("NEEDLE");
    assert.match(textOf(picker), /Review code/);
    assert.doesNotMatch(textOf(picker), /alpha/);
    picker.handleInput("\r");
  });
  await f.open();
  assert.deepEqual(f.pasted, ["Review ${1:-correctness}\nneedle"]);
  await writeFile(f.path("review"), "---\nname: Revised\n---\nChanged body");
  f.interact((picker) => { picker.handleInput("Changed"); picker.handleInput("\r"); });
  await f.open();
  assert.equal(f.pasted.at(-1), "Changed body");
});

test("picker sorts names naturally and searches ids, names, and descriptions", async (t) => {
  const f = await fixture(t, {
    ten: "---\nname: Prompt 10\ndescription: Target\n---\nTen",
    two: "---\nname: Prompt 2\n---\nTwo",
  });
  for (const [query, expected] of [["", "Two"], ["TEN", "Ten"], ["prompt 10", "Ten"], ["target", "Ten"]]) {
    f.interact((picker) => { if (query) picker.handleInput(query); picker.handleInput("\r"); });
    await f.open();
    assert.equal(f.pasted.at(-1), expected);
  }
});

test("picker closes without changing the editor on Escape or Ctrl+C", async (t) => {
  const f = await fixture(t, { example: "Body" });
  for (const key of ["\x1b", "\x03"]) {
    f.interact((picker) => picker.handleInput(key));
    await f.open();
  }
  assert.deepEqual(f.pasted, []);
});

test("picker respects remapped selection keys", async (t) => {
  const f = await fixture(t, { a: "First", b: "Second" }, new KeybindingsManager({
    "tui.select.down": "ctrl+n",
    "tui.select.confirm": "ctrl+y",
    "tui.select.cancel": "ctrl+q",
  }));
  f.interact((picker, done) => {
    picker.handleInput("\x0e");
    picker.handleInput("\x19");
    done(undefined); // Keep a broken routing implementation from hanging the test.
  });
  await f.open();
  assert.deepEqual(f.pasted, ["Second"]);
  f.interact((picker) => picker.handleInput("\x11"));
  await f.open();
  assert.equal(f.pasted.length, 1);
});

test("unreadable prompts are reported without hiding readable templates", async (t) => {
  const f = await fixture(t, { good: "Readable", missing: "Deleted" });
  await rm(f.path("missing"));
  f.interact((picker) => { assert.match(textOf(picker), /good/); picker.handleInput("\r"); });
  await f.open();
  assert.deepEqual(f.pasted, ["Readable"]);
  assert.match(f.notices.join("\n"), /1.*prompt/i);
});

test("no templates or all unreadable templates produce a notice, not an empty modal", async (t) => {
  const f = await fixture(t, { gone: "Deleted" });
  f.interact((_picker, done) => done(undefined));
  await rm(f.path("gone"));
  await f.open();
  f.commands([]);
  await f.open();
  assert.equal(f.opened, 0);
  assert.ok(f.notices.length >= 2);
});

test("picker is terminal-only and suppresses repeated opens until dismissal", async (t) => {
  const f = await fixture(t, { example: "Body" });
  f.interact((picker) => picker.handleInput("\x1b"));
  for (const mode of ["rpc", "json", "print"] as const) {
    f.ctx.mode = mode;
    await f.open();
  }
  assert.equal(f.opened, 0);
  f.ctx.mode = "tui";
  f.interact((picker) => picker.handleInput("\x1b"));
  await Promise.all([f.open(), f.shortcutOpen()]);
  assert.equal(f.opened, 1);
  await f.open();
  assert.equal(f.opened, 2);
});

test("picker rows fit narrow widths including no matches and multiline names", async (t) => {
  const f = await fixture(t, { example: "---\nname: |\n  First line\n  Second line\n---\nBody" });
  f.interact((picker) => {
    for (const width of [1, 3, 12, 20, 60]) {
      for (const line of picker.render(width)) {
        assert.ok(visibleWidth(line) <= width, `${width}: ${JSON.stringify(line)}`);
        assert.ok(!line.includes("\n"));
      }
    }
    picker.handleInput("not found");
    for (const line of picker.render(12)) assert.ok(visibleWidth(line) <= 12);
    picker.handleInput("\r");
    picker.handleInput("\x1b");
  });
  await f.open();
  assert.deepEqual(f.pasted, []);
});

test("picker reads only prompt commands and uses the current resource list", async (t) => {
  const f = await fixture(t, { template: "Body", extension: "Not a template" });
  f.commands([
    { name: "template", source: "prompt", sourceInfo: { path: f.path("template") } },
    { name: "extension", source: "extension", sourceInfo: { path: f.path("extension") } },
    { name: "skill", source: "skill", sourceInfo: { path: f.path("extension") } },
  ]);
  f.interact((picker) => {
    assert.match(textOf(picker), /template/);
    assert.doesNotMatch(textOf(picker), /extension|skill/);
    picker.handleInput("\x1b");
  });
  await f.open();
  f.commands([]);
  await f.open();
  assert.equal(f.opened, 1);
});

test("picker can reopen after a failed custom UI interaction", async (t) => {
  const f = await fixture(t, { example: "Body" });
  f.interact(() => { throw new Error("UI closed"); });
  await assert.rejects(f.open(), /UI closed/);
  f.interact((picker) => picker.handleInput("\x1b"));
  await f.open();
  assert.equal(f.opened, 2);
});

test("picker shortcut does not collide with any default Pi binding", async (t) => {
  const f = await fixture(t, {});
  const kb = new KeybindingsManager();
  const data = "\x1b[112;7u"; // Kitty Ctrl+Alt+P.
  assert.ok(matchesKey(data, f.shortcut));
  for (const action of Object.keys(kb.getResolvedBindings()) as Keybinding[]) assert.ok(!kb.matches(data, action), action);
});
