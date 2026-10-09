import assert from "node:assert/strict";
import test from "node:test";
import { parseSlateArgs, slateArgumentCompletions } from "../extensions/pi-slate/layout.ts";
import { FRESH_SURFACES, formatSurfaces, has, parseSurfaceConfig, SURFACES } from "../extensions/pi-slate/surfaces.ts";

test("missing file selects the fresh three, with sidebar selected but focused", () => {
  const parsed = parseSurfaceConfig(undefined);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value.surfaces, FRESH_SURFACES);
  assert.equal((parsed.value as { focused?: boolean }).focused, true);
});

test("legacy settings migrate to the explicit six and preserve appearance facts", () => {
  const old = { density: "compact", footer: "minimal", sidebarPercent: 40, showPid: true, messageLength: "all", focused: false, modelDisplay: { stripPrefixes: ["us."] } };
  const parsed = parseSurfaceConfig(JSON.stringify(old));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value.surfaces, SURFACES);
  assert.equal(parsed.value.composerMetadata, "minimal");
  for (const [key, value] of Object.entries(old)) assert.deepEqual(Reflect.get(parsed.value, key), value);
  assert.equal(parsed.ok && parsed.migrated, true);
});

test("explicit composerMetadata takes precedence over its legacy footer alias", () => {
  const parsed = parseSurfaceConfig(JSON.stringify({ surfaces: ["editor"], footer: "minimal", composerMetadata: "standard" }));
  assert.equal(parsed.value.composerMetadata, "standard");
});

test("none and focused do not enable a disabled sidebar", () => {
  for (const focused of [true, false]) {
    const parsed = parseSurfaceConfig(JSON.stringify({ version: 1, surfaces: [], focused }));
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.value.surfaces, []);
    assert.equal(has(parsed.value.surfaces, "sidebar"), false);
    assert.equal(formatSurfaces(parsed.value.surfaces), "none");
  }
});

test("invalid JSON, unknown surfaces and unsupported versions fail closed", () => {
  for (const text of ["{", "null", "[]", '{"surfaces":["marketplace"]}', '{"surfaces":"full"}', '{"version":2}', '{"version":"1"}']) {
    const parsed = parseSurfaceConfig(text);
    assert.equal(parsed.ok, false, text);
    assert.deepEqual(parsed.value.surfaces, []);
    if (!parsed.ok) assert.match(parsed.error, /preserved/);
  }
});

test("surface commands expand full, accept none and closed-enum combinations", () => {
  assert.deepEqual(parseSlateArgs("surfaces"), { ok: true, kind: "surfaces" });
  assert.deepEqual(parseSlateArgs("surfaces full"), { ok: true, kind: "surfaces", value: [...SURFACES] });
  assert.deepEqual(parseSlateArgs("surfaces none"), { ok: true, kind: "surfaces", value: [] });
  assert.deepEqual(parseSlateArgs("surfaces set editor"), { ok: true, kind: "surfaces", value: ["editor"] });
  assert.deepEqual(parseSlateArgs("surfaces set header tool-cards"), { ok: true, kind: "surfaces", value: ["header", "tool-cards"] });
  for (const arg of ["surfaces set", "surfaces set unknown", "surfaces full editor", "surfaces none sidebar", "surfaces *"]) assert.deepEqual(parseSlateArgs(arg), { ok: false });
  assert.deepEqual(slateArgumentCompletions("surfaces set editor tool-"), [{ value: "surfaces set editor tool-cards", label: "surfaces set editor tool-cards" }]);
});
