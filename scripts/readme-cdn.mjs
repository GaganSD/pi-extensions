#!/usr/bin/env node
// GitHub Camo rate-limits jsDelivr, so READMEs in git use repo-relative
// `assets/…` paths. npm cannot resolve those, so pack rewrites them to the
// versioned npm CDN and unpack restores the repo files.

import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_NAME = ".readme-source.md";
const ASSET_NAME = /[\w.-]+\.(?:png|jpe?g|gif|webp|svg)/i;
const ABSOLUTE_ASSET = new RegExp(
  String.raw`https://(?:cdn\.jsdelivr\.net/(?:npm/(?:@[^/\s]+/)?[^/\s]+@[^/\s]+|gh/[^/\s]+/[^/\s]+@[^/\s]+/[^/\s]+)|raw\.githubusercontent\.com/[^/\s]+/[^/\s]+/[^/\s]+/[^/\s]+)/assets/(${ASSET_NAME.source})`,
  "gi",
);

export function cdnOrigin(name, version) {
  return `https://cdn.jsdelivr.net/npm/${name}@${version}`;
}

export function toRepo(content) {
  return content.replace(ABSOLUTE_ASSET, "assets/$1");
}

export function toCdn(content, name, version) {
  const origin = cdnOrigin(name, version);
  return toRepo(content).replace(
    /(?<=(?:src="|\()(?:\.\/)?)assets\/([\w.-]+\.(?:png|jpe?g|gif|webp|svg))/gi,
    `${origin}/assets/$1`,
  );
}

function readPackage(dir) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  if (typeof pkg.name !== "string" || typeof pkg.version !== "string") {
    throw new Error(`package.json in ${dir} needs name and version`);
  }
  return pkg;
}

export function packReadme(dir) {
  const readme = join(dir, "README.md");
  const source = join(dir, SOURCE_NAME);
  const pkg = readPackage(dir);
  if (!existsSync(source)) copyFileSync(readme, source);
  writeFileSync(readme, toCdn(readFileSync(source, "utf8"), pkg.name, pkg.version));
}

export function unpackReadme(dir) {
  const readme = join(dir, "README.md");
  const source = join(dir, SOURCE_NAME);
  if (existsSync(source)) {
    renameSync(source, readme);
    return;
  }
  writeFileSync(readme, toRepo(readFileSync(readme, "utf8")));
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invoked) {
  const mode = process.argv[2];
  const packageDir = process.argv[3] ?? process.cwd();
  if (mode === "pack") packReadme(packageDir);
  else if (mode === "unpack") unpackReadme(packageDir);
  else {
    console.error(`usage: ${process.argv[1]} <pack|unpack> [packageDir]`);
    process.exit(1);
  }
}
