import test from "node:test";
import assert from "node:assert/strict";
import { assertSupportedPiHost } from "../index.ts";

test("host guard accepts stable Pi 1.x minor/patch upgrades and build metadata", () => {
  for (const version of ["1.0.0", "1.0.4", "1.1.0", "1.1.9", "1.2.0", "1.99.99", "1.1.0+build.7"]) {
    assert.doesNotThrow(() => assertSupportedPiHost(version, false), version);
  }
});

test("host guard rejects old/new majors, prereleases, malformed versions, and Bun", () => {
  for (const version of ["0.99.2", "2.0.0", "10.0.0", "1.0.0-rc.1", "1.1.0-beta.1", "2.0.0-rc.1",
    "", "1", "1.1", "v1.1.0", "1.01.0", "1.1.00", "1.1.0garbage", "1.1.0+", "1.1.0+build..7"]) {
    assert.throws(() => assertSupportedPiHost(version, false), /Unsupported Pi host.*Pi 1\.x/, version);
  }
  assert.throws(() => assertSupportedPiHost("1.1.0", true), /on Node/);
});
