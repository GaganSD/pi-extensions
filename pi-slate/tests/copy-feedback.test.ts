import assert from "node:assert/strict";
import test from "node:test";
import { confirmCopy } from "../extensions/pi-slate/copy-feedback.ts";

test("confirmCopy uses the TUI flash when available", () => {
  const flashes: string[] = [];
  const notes: string[] = [];
  confirmCopy({ flash: (message: string) => flashes.push(message) }, (message) => notes.push(message));
  assert.deepEqual(flashes, ["Copied!"]);
  assert.deepEqual(notes, []);
});

test("confirmCopy notifies only when flash is missing", () => {
  const notes: Array<[string, string]> = [];
  confirmCopy(undefined, (message, kind) => notes.push([message, kind]));
  confirmCopy({}, (message, kind) => notes.push([message, kind]));
  assert.deepEqual(notes, [
    ["Copied", "info"],
    ["Copied", "info"],
  ]);
});
