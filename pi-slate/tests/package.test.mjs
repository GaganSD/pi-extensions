import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const readme = readFileSync(new URL("README.md", root), "utf8");

test("package and README use the requested subtitle", () => {
  const subtitle = "A minimal-TUI with rich-graphics support that adds zero-context bloat";
  assert.equal(pkg.description, subtitle);
  assert.ok(readme.includes(subtitle));
});

test("README screenshots use gallery-compatible Markdown and bundled assets", () => {
  assert.doesNotMatch(readme, /<img\b/i);
  const images = [...readme.matchAll(/!\[([^\]]+)\]\((https:\/\/[^)]+)\)/g)];
  assert.equal(images.length, 5);
  for (const [, alt, url] of images) {
    assert.ok(alt.length > 0);
    assert.ok(url.startsWith("https://raw.githubusercontent.com/GaganSD/pi-extensions/main/pi-slate/assets/"));
    const asset = new URL(url).pathname.split("/").at(-1);
    assert.ok(statSync(new URL(`assets/${asset}`, root)).size > 0);
  }
  assert.equal(pkg.pi.image, images[0][2]);
  assert.ok(pkg.files.includes("assets"));
});

test("packing does not mutate the README or require scripts outside the package", () => {
  assert.equal(pkg.scripts.prepack, undefined);
  assert.equal(pkg.scripts.postpack, undefined);
});
