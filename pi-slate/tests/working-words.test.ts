import assert from "node:assert/strict";
import test from "node:test";
import { WORKING_WORDS, createWordPicker } from "../extensions/pi-slate/working-words.ts";

test("shuffle bag deals every word once before repeating", () => {
  const picker = createWordPicker();
  const first = Array.from({ length: WORKING_WORDS.length }, () => picker.next());
  assert.deepEqual(new Set(first).size, WORKING_WORDS.length);
  assert.ok(first.every((word) => (WORKING_WORDS as readonly string[]).includes(word)));

  const second = Array.from({ length: WORKING_WORDS.length }, () => picker.next());
  assert.deepEqual(new Set(second).size, WORKING_WORDS.length);
  assert.notEqual(first[first.length - 1], second[0]);
});
