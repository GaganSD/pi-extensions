import assert from "node:assert/strict";
import test from "node:test";
import { formatUpdateNotice, isNewerVersion } from "../extensions/pi-slate/updates.ts";

test("formats none, one, many, pi, and mixed notices", () => {
  assert.equal(formatUpdateNotice({ packages: [] }), undefined);
  assert.equal(
    formatUpdateNotice({ packages: ["@dev.fast/pi-whiteboard"] }),
    "update available · @dev.fast/pi-whiteboard · pi update --extensions",
  );
  assert.equal(
    formatUpdateNotice({ packages: ["pi-whiteboard", "pi-ask", "pi-subagents"] }),
    "3 updates available · pi-whiteboard, pi-ask, pi-subagents · pi update --extensions",
  );
  assert.equal(
    formatUpdateNotice({ pi: { current: "0.99.1", next: "0.99.2" }, packages: [] }),
    "update available · pi 0.99.1 → 0.99.2 · pi update",
  );
  assert.equal(
    formatUpdateNotice({
      pi: { current: "0.99.1", next: "0.99.2" },
      packages: ["@dev.fast/pi-whiteboard"],
    }),
    "2 updates available · pi 0.99.1 → 0.99.2, @dev.fast/pi-whiteboard · pi update",
  );
});

test("compares dotted versions", () => {
  assert.equal(isNewerVersion("0.99.2", "0.99.1"), true);
  assert.equal(isNewerVersion("0.99.1", "0.99.1"), false);
  assert.equal(isNewerVersion("0.98.9", "0.99.1"), false);
});
