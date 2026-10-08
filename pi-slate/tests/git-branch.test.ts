import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GitBranchPoller } from "../extensions/pi-slate/git-branch.ts";

test("editor branch service polls independently and stops on disposal", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const calls: string[][] = [];
  const branches: Array<string | null> = [];
  const pi = { exec: async (_command: string, args: string[]) => {
    calls.push(args);
    return { code: 0, stdout: calls.length === 1 ? "feature\n" : "\n", stderr: "", killed: false };
  } } as Pick<ExtensionAPI, "exec">;
  const poller = new GitBranchPoller(pi, (branch) => branches.push(branch));
  t.after(() => poller.dispose());
  poller.start("/workspace");
  await Promise.resolve();
  assert.deepEqual(calls, [["-C", "/workspace", "branch", "--show-current"]]);
  assert.deepEqual(branches, ["feature"]);
  t.mock.timers.tick(5000);
  await Promise.resolve();
  assert.deepEqual(branches, ["feature", null]);
  poller.dispose();
  poller.dispose();
  t.mock.timers.tick(10_000);
  assert.equal(calls.length, 2);
});

test("disposed branch requests cannot repaint a stale session", async () => {
  let finish!: (value: { code: number; stdout: string; stderr: string; killed: boolean }) => void;
  const pi = { exec: () => new Promise((resolve) => { finish = resolve; }) } as Pick<ExtensionAPI, "exec">;
  const branches: Array<string | null> = [];
  const poller = new GitBranchPoller(pi, (branch) => branches.push(branch));
  poller.start("/workspace");
  poller.dispose();
  finish({ code: 0, stdout: "stale", stderr: "", killed: false });
  await Promise.resolve();
  assert.deepEqual(branches, []);
});
