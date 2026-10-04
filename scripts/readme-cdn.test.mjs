import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { packReadme, toCdn, toRepo, unpackReadme } from "./readme-cdn.mjs";

const html = `<img src="assets/slate-overview.png" alt="overview" />`;
const markdown = `![Multi-select](assets/multi.png)`;

test("toCdn lifts repo assets and collapses existing CDN urls", () => {
  const fromRepo = toCdn(html, "pi-slate", "0.1.9");
  assert.equal(
    fromRepo,
    `<img src="https://cdn.jsdelivr.net/npm/pi-slate@0.1.9/assets/slate-overview.png" alt="overview" />`,
  );
  assert.equal(toCdn(fromRepo, "pi-slate", "0.1.9"), fromRepo);
  assert.equal(
    toCdn(
      `<img src="https://cdn.jsdelivr.net/gh/GaganSD/pi-extensions@26a9e68/pi-slate/assets/slate-diff-yaml.png" />`,
      "pi-slate",
      "0.1.9",
    ),
    `<img src="https://cdn.jsdelivr.net/npm/pi-slate@0.1.9/assets/slate-diff-yaml.png" />`,
  );
  assert.equal(
    toCdn(markdown, "@gagansd/pi-ask", "0.1.3"),
    `![Multi-select](https://cdn.jsdelivr.net/npm/@gagansd/pi-ask@0.1.3/assets/multi.png)`,
  );
});

test("toRepo restores relative assets", () => {
  assert.equal(
    toRepo(`<img src="https://cdn.jsdelivr.net/npm/pi-slate@0.1.9/assets/slate-overview.png" alt="overview" />`),
    html,
  );
  assert.equal(
    toRepo(`![Multi-select](https://cdn.jsdelivr.net/npm/@gagansd/pi-ask@0.1.2/assets/multi.png)`),
    markdown,
  );
});

test("pack rewrites from the source copy and unpack restores it", () => {
  const dir = mkdtempSync(join(tmpdir(), "readme-cdn-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "pi-slate", version: "0.1.9" }));
    writeFileSync(join(dir, "README.md"), html);
    packReadme(dir);
    assert.match(readFileSync(join(dir, "README.md"), "utf8"), /cdn\.jsdelivr\.net\/npm\/pi-slate@0\.1\.9/);
    packReadme(dir);
    unpackReadme(dir);
    assert.equal(readFileSync(join(dir, "README.md"), "utf8"), html);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
