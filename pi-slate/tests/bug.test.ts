import assert from "node:assert/strict";
import test from "node:test";
import {
  formatBugReport,
  issueTemplate,
  openExternalArgs,
  SLATE_ISSUES_URL,
} from "../extensions/pi-slate/bug.ts";
import { SLATE_VERSION } from "../extensions/pi-slate/layout.ts";

test("bug links stay on the public npm package page", () => {
  assert.equal(SLATE_ISSUES_URL, "https://www.npmjs.com/package/pi-slate");
  assert.doesNotMatch(SLATE_ISSUES_URL, /github\.com/i);
});

test("issue template includes environment and empty report sections", () => {
  assert.match(SLATE_VERSION, /^\d+\.\d+\.\d+$/);
  const body = issueTemplate({ slateVersion: SLATE_VERSION, piVersion: "0.85.1", platform: "darwin arm64" });
  assert.match(body, /## What happened/);
  assert.match(body, /## Expected/);
  assert.match(body, new RegExp(`- pi-slate: ${SLATE_VERSION}`));
  assert.match(body, /- pi: 0\.85\.1/);
  assert.match(body, /- platform: darwin arm64/);
  assert.equal(formatBugReport("Sidebar crash", body), `# Sidebar crash\n\n${body}`);
});

test("open args stay usable across platforms", () => {
  assert.deepEqual(openExternalArgs(SLATE_ISSUES_URL, "darwin"), { command: "open", args: [SLATE_ISSUES_URL] });
  assert.deepEqual(openExternalArgs(SLATE_ISSUES_URL, "linux"), { command: "xdg-open", args: [SLATE_ISSUES_URL] });
  assert.deepEqual(openExternalArgs(SLATE_ISSUES_URL, "win32"), { command: "cmd", args: ["/c", "start", "", `"${SLATE_ISSUES_URL}"`] });
  assert.deepEqual(openExternalArgs("/tmp/note.md", "darwin"), { command: "open", args: ["/tmp/note.md"] });
  assert.deepEqual(openExternalArgs("/tmp/note.md", "linux"), { command: "xdg-open", args: ["/tmp/note.md"] });
  assert.deepEqual(openExternalArgs("/tmp/note.md", "win32"), { command: "cmd", args: ["/c", "start", "", `"/tmp/note.md"`] });
});
