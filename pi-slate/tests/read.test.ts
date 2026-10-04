import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
  createReadToolDefinition,
  type ExtensionAPI,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { createReadTool, installRead } from "../extensions/pi-slate/read.ts";
import { ReadGrouper } from "../extensions/pi-slate/read-group.ts";

const themeMethods: Pick<Theme, "fg" | "bold"> = { fg: (_color, text) => text, bold: (text) => text };
const theme = themeMethods as Theme;
const plain = (component: Component) => component.render(120).map((line) => stripVTControlCharacters(line).trimEnd()).join("\n");

function renderContext(id: string, args: { path: string; offset?: number; limit?: number }, invalidate = () => {}) {
  return {
    cwd: process.cwd(), args, toolCallId: id, invalidate, lastComponent: undefined, state: {},
    executionStarted: true, argsComplete: true, isPartial: false, expanded: false,
    showImages: false, isError: false,
  };
}

test("createReadTool keeps the native schema and execute path", () => {
  const grouper = new ReadGrouper();
  const tool = createReadTool(grouper, process.cwd());
  const native = createReadToolDefinition(process.cwd());
  for (const key of ["name", "label", "description", "promptSnippet", "promptGuidelines", "constrainedSampling", "executionMode"] as const) {
    assert.deepEqual(tool[key], native[key], key);
  }
  assert.equal(tool.parameters, native.parameters);
  assert.equal(tool.prepareArguments, native.prepareArguments);
  assert.equal(tool.renderShell, "self");
});

test("a lone read renders the path; a follower renders nothing", () => {
  const grouper = new ReadGrouper();
  const tool = createReadTool(grouper);
  grouper.seeRead({ id: "a", path: "x.md", range: "" });
  grouper.seeRead({ id: "b", path: "y.ts", range: ":1-8" });
  const lead = tool.renderCall!({ path: "x.md" }, theme, renderContext("a", { path: "x.md" }));
  const follow = tool.renderCall!({ path: "y.ts", offset: 1, limit: 8 }, theme, renderContext("b", { path: "y.ts", offset: 1, limit: 8 }));
  assert.ok(lead instanceof Text);
  assert.equal(plain(lead), "read 2 files");
  assert.deepEqual(follow.render(80), []);
  const result = { content: [], details: undefined };
  const expanded = tool.renderResult!(result, { expanded: true, isPartial: false }, theme, { ...renderContext("a", { path: "x.md" }), expanded: true });
  assert.match(plain(expanded), /x\.md/);
  assert.match(plain(expanded), /y\.ts:1-8/);
  const collapsed = tool.renderResult!(result, { expanded: false, isPartial: false }, theme, renderContext("a", { path: "x.md" }));
  assert.deepEqual(collapsed.render(80), []);
});

test("a single read still shows the file name", () => {
  const grouper = new ReadGrouper();
  const tool = createReadTool(grouper);
  grouper.seeRead({ id: "a", path: "only.md", range: ":3-9" });
  const call = tool.renderCall!({ path: "only.md", offset: 3, limit: 7 }, theme, renderContext("a", { path: "only.md", offset: 3, limit: 7 }));
  assert.equal(plain(call), "read only.md:3-9");
});

test("joining a later read refreshes the lead through invalidate", () => {
  const grouper = new ReadGrouper();
  const tool = createReadTool(grouper);
  let invalidations = 0;
  grouper.seeRead({ id: "a", path: "a.ts", range: "" });
  const first = tool.renderCall!({ path: "a.ts" }, theme, renderContext("a", { path: "a.ts" }, () => { invalidations += 1; }));
  assert.equal(plain(first), "read a.ts");
  grouper.seeRead({ id: "b", path: "b.ts", range: "" });
  assert.equal(invalidations, 1);
  const again = tool.renderCall!({ path: "a.ts" }, theme, renderContext("a", { path: "a.ts" }));
  assert.equal(plain(again), "read 2 files");
});

test("failed lead and follower reads show their own path and error", () => {
  const grouper = new ReadGrouper();
  const tool = createReadTool(grouper);
  grouper.seeRead({ id: "a", path: "a.ts", range: "" });
  grouper.seeRead({ id: "b", path: "b.ts", range: "" });
  for (const id of ["a", "b"]) {
    const args = { path: `${id}.ts` };
    const context = { ...renderContext(id, args), isError: true };
    assert.equal(plain(tool.renderCall!(args, theme, context)), `read ${id}.ts`);
    for (const expanded of [false, true]) {
      const result = tool.renderResult!(
        { content: [{ type: "text", text: "ENOENT\nunsafe\x1b[2J" }], details: undefined },
        { expanded, isPartial: false }, theme, context,
      );
      const paths = id === "a" && expanded ? "\n  a.ts\n  b.ts" : "";
      assert.equal(plain(result), "ENOENT\nunsafe\\x1b[2J" + paths);
    }
  }
});

test("installRead registers read and hydrates on session events", () => {
  const names: string[] = [];
  const hooks: string[] = [];
  const api: Pick<ExtensionAPI, "registerTool" | "on"> = {
    registerTool(tool) { names.push(tool.name); },
    on(event) { hooks.push(event); return () => {}; },
  };
  installRead(api as ExtensionAPI);
  assert.deepEqual(names, ["read"]);
  assert.deepEqual(hooks, ["session_start", "session_tree", "session_shutdown", "message_start", "message_update", "message_end", "tool_call"]);
});
