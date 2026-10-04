import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { packages, packageConfig } from "./packages.mjs";
import { git, isMain, npm, root, run } from "./lib.mjs";

export const repository = "GaganSD/pi-extensions";
export const planPath = ".release/plan.json";
const registry = "https://registry.npmjs.org";
const shaPattern = /^[a-f0-9]{40}$/;
const json = value => JSON.stringify(value, null, 2) + "\n";

export function bumpVersion(version, bump) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error(`Not a stable version: ${version}`);
  const parts = version.split(".").map(Number);
  const index = ["major", "minor", "patch"].indexOf(bump);
  if (index < 0 || !parts.every(Number.isSafeInteger)) throw new Error(`Invalid bump: ${bump}`);
  parts[index]++;
  for (let i = index + 1; i < 3; i++) parts[i] = 0;
  if (!parts.every(Number.isSafeInteger)) throw new Error("Version overflow");
  return parts.join(".");
}

export function selections(values, defaultBump) {
  if (!values?.length) throw new Error("Specify --package (path or path:bump)");
  const selected = values.map(value => {
    const [path, bump = defaultBump, extra] = value.split(":");
    packageConfig(path);
    if (extra !== undefined) throw new Error(`Invalid selection: ${value}`);
    bumpVersion("0.0.0", bump);
    return { path, bump };
  }).sort((a, b) => a.path.localeCompare(b.path));
  if (new Set(selected.map(item => item.path)).size !== selected.length) throw new Error("Duplicate package selection");
  return selected;
}

export function validatePlan(plan) {
  assert.deepEqual(Object.keys(plan).sort(), ["notes", "packages", "schema", "sourceSha"]);
  assert.equal(plan.schema, 1);
  assert.match(plan.sourceSha, shaPattern);
  assert.equal(typeof plan.notes, "string");
  assert(plan.notes.trim().length > 0 && plan.notes.length <= 16000, "Release notes are required (max 16,000 characters)");
  assert(Array.isArray(plan.packages) && plan.packages.length > 0 && plan.packages.length <= Object.keys(packages).length);
  const paths = plan.packages.map(item => item.path);
  assert.deepEqual(paths, [...new Set(paths)].sort(), "Packages must be unique and sorted");
  for (const item of plan.packages) {
    assert.deepEqual(Object.keys(item).sort(), ["bump", "from", "name", "path", "to"]);
    assert.equal(item.name, packageConfig(item.path).name);
    assert.equal(item.to, bumpVersion(item.from, item.bump));
  }
  return plan;
}

export function makePlan(sourceSha, selected, notes, read) {
  const plan = { schema: 1, sourceSha, notes, packages: selected.map(({ path, bump }) => {
    const manifest = JSON.parse(read(`${path}/package.json`));
    assert.equal(manifest.name, packageConfig(path).name);
    assert.notEqual(manifest.private, true);
    return { path, name: manifest.name, from: manifest.version, to: bumpVersion(manifest.version, bump), bump };
  }) };
  return validatePlan(plan);
}

export function releaseFiles(plan, read) {
  validatePlan(plan);
  const files = { [planPath]: json(plan) };
  for (const item of plan.packages) {
    const manifestPath = `${item.path}/package.json`, lockPath = `${item.path}/package-lock.json`;
    const manifest = JSON.parse(read(manifestPath)), lock = JSON.parse(read(lockPath));
    assert.equal(manifest.name, item.name);
    assert.equal(manifest.version, item.from);
    assert.equal(lock.version, item.from);
    assert.equal(lock.packages[""].version, item.from);
    manifest.version = lock.version = lock.packages[""].version = item.to;
    files[manifestPath] = json(manifest);
    files[lockPath] = json(lock);
    const changelogPath = `${item.path}/CHANGELOG.md`;
    const previous = read(changelogPath, true) ?? "# Changelog\n\n";
    const heading = `## ${item.to}\n\n${plan.notes.trim()}\n\n`;
    const unreleased = /^## Unreleased\s*\n/m;
    if (unreleased.test(previous)) {
      files[changelogPath] = previous.replace(unreleased, `## Unreleased\n\n${heading}`);
    } else {
      const first = previous.search(/^## /m);
      files[changelogPath] = first < 0 ? previous.trimEnd() + "\n\n" + heading
        : previous.slice(0, first) + heading + previous.slice(first);
    }
  }
  return files;
}

function readAt(sha) {
  assert.match(sha, shaPattern);
  return (path, optional = false) => {
    if (optional && !git("ls-tree", "--name-only", sha, "--", path)) return undefined;
    return run("git", ["show", `${sha}:${path}`]);
  };
}

export function checkRelease(base, head, read = readAt, changed = (a, b) => git("diff", "--name-only", "--no-renames", a, b).split("\n").filter(Boolean)) {
  assert.match(base, shaPattern);
  assert.match(head, shaPattern);
  const files = changed(base, head), before = read(base), after = read(head);
  if (!files.includes(planPath)) {
    for (const path of Object.keys(packages)) {
      const previous = before(`${path}/package.json`, true);
      if (previous === undefined) continue; // Onboarding a package does not publish it.
      assert.equal(JSON.parse(after(`${path}/package.json`)).version,
        JSON.parse(previous).version, `Version changes require a release plan: ${path}`);
    }
    return null;
  }
  const current = before(planPath, true), next = after(planPath, true);
  if (current) {
    const previous = validatePlan(JSON.parse(current)), original = read(previous.sourceSha);
    if (next === original(planPath, true)) {
      // Permit an exact revert of an unpublished release, not arbitrary version edits.
      const generated = releaseFiles(previous, original);
      assert.deepEqual(files.sort(), Object.keys(generated).sort(), "Cancellation must revert only the release metadata");
      for (const [path, content] of Object.entries(generated)) {
        assert.equal(before(path), content, "Cancel before making further release-metadata edits");
        assert.equal(after(path, true), original(path, true), `Cancellation must restore ${path}`);
      }
      return { cancelled: previous };
    }
  }
  const plan = validatePlan(JSON.parse(next));
  assert.equal(plan.sourceSha, base, "Trunk moved: regenerate the release PR from current main");
  const expected = releaseFiles(plan, before);
  assert.deepEqual(files.sort(), Object.keys(expected).sort(), "A release PR may only change its generated release files");
  for (const [path, contents] of Object.entries(expected)) {
    assert.equal(after(path), contents, `Release file differs from the plan: ${path}`);
  }
  return plan;
}

async function request(url, options = {}, allow404 = false) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
  if (allow404 && response.status === 404) return null;
  if (!response.ok) throw new Error(`Request failed: ${new URL(url).hostname} HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}

export function npmMetadata(name, version) {
  return request(`${registry}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`, {}, true);
}

export async function verifyUnpublished(plan, lookup = npmMetadata) {
  for (const item of plan.packages) {
    assert.equal(await lookup(item.name, item.to), null, "Cannot cancel a partially or fully published release; retry publication instead");
  }
}

async function checkRegistry(plan) {
  for (const item of plan.packages) {
    const latest = await npmMetadata(item.name, "latest");
    assert.equal(latest?.version, item.from, `${item.name}: main must match npm latest before preparing a release`);
    assert.equal(await npmMetadata(item.name, item.to), null, `${item.name}@${item.to} already exists`);
  }
}

function output(name, value) {
  const line = `${name}=${typeof value === "string" ? value : JSON.stringify(value)}\n`;
  process.stdout.write(line);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
}

async function prepare(args, apply) {
  const { values } = parseArgs({ args, options: {
    package: { type: "string", multiple: true }, bump: { type: "string" },
    notes: { type: "string" }, "dry-run": { type: "boolean", default: false },
    "source-sha": { type: "string" },
  } });
  const selected = selections(values.package, values.bump);
  const latestSha = run("gh", ["api", `repos/${repository}/commits/main`, "--jq", ".sha"]).trim();
  const source = values["source-sha"] ?? latestSha;
  assert.match(source, shaPattern);
  assert.equal(source, latestSha, "Requested source is no longer main; retry from current trunk");
  run("git", ["fetch", "--no-tags", `https://github.com/${repository}.git`, source]);
  const sourceFiles = readAt(source);
  const plan = makePlan(source, selected, values.notes ?? "", sourceFiles);
  const previous = sourceFiles(planPath, true);
  if (previous) {
    // One release at a time, including failed/partially published releases.
    for (const item of validatePlan(JSON.parse(previous)).packages) {
      assert(await npmMetadata(item.name, item.to), "Finish or retry the previous release before preparing another");
      run("gh", ["api", `repos/${repository}/releases/tags/${item.path}-v${item.to}`]);
    }
  }
  await checkRegistry(plan);
  console.log(json(plan));
  if (values["dry-run"]) return;
  if (!apply) {
    run("gh", ["workflow", "run", "release-prepare.yml", "--repo", repository, "--ref", "main",
      "-f", `source_sha=${source}`, "-f", `packages=${selected.map(item => `${item.path}:${item.bump}`).join(",")}`,
      "-f", `notes=${plan.notes}`], { stdio: "inherit" });
    return;
  }
  assert.equal(process.env.GITHUB_ACTIONS, "true", "Only GitHub Actions may apply a release plan");
  assert.equal(process.env.GITHUB_REF, "refs/heads/main", "Release preparation must run from main");
  assert.equal(git("rev-parse", "HEAD"), source);
  assert.equal(git("status", "--porcelain"), "", "Release workspace must be clean");
  for (const [path, content] of Object.entries(releaseFiles(plan, readAt(source)))) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  writeFileSync(join(root, ".release/body.md"),
    `Release from \`${source}\`. Merging this PR publishes only these packages after CI passes.\n\n` +
    plan.packages.map(item => `- **${item.name}**: ${item.from} → ${item.to} (${item.bump})`).join("\n") +
    `\n\n${plan.notes}\n\nIf main advances, rerun release preparation before merging.\n`);
}

async function github(path, { method = "GET", body, allow404 = false } = {}) {
  assert(process.env.GH_TOKEN, "GH_TOKEN is required");
  return request(`https://api.github.com/repos/${repository}/${path}`, {
    method, headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }, allow404);
}

export function verifyArtifact(item, metadata, bytes) {
  assert.equal(metadata.name, item.name);
  assert.equal(metadata.version, item.to);
  assert.equal(metadata.filename, `${item.name.replace(/^@/, "").replaceAll("/", "-")}-${item.to}.tgz`);
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  assert.equal(metadata.integrity, integrity, "Artifact integrity mismatch");
  return integrity;
}

export function isReleasePullRequest(pr, sha) {
  return Boolean(pr.merged_at && pr.merge_commit_sha === sha &&
    pr.base?.ref === "main" && pr.base?.repo?.full_name === repository &&
    pr.head?.ref === "release/next" && pr.head?.repo?.full_name === repository);
}

export function publicationState(item, integrity, existing, latest) {
  if (existing) {
    assert.equal(existing.dist.integrity, integrity, "Published version has different bytes; refusing to overwrite or skip");
    return "already-published";
  }
  assert.equal(latest?.version, item.from, "Registry advanced; refusing an out-of-order publication");
  return "publish";
}

async function publish() {
  assert.equal(process.env.GITHUB_ACTIONS, "true", "Publication is GitHub Actions only");
  assert.equal(process.env.GITHUB_REF, "refs/heads/main");
  const head = git("rev-parse", "HEAD"), base = git("rev-parse", "HEAD^1");
  const plan = checkRelease(base, head);
  assert(plan && !plan.cancelled, "This commit is not a release");
  const prs = await github(`commits/${head}/pulls`);
  assert(prs.some(pr => isReleasePullRequest(pr, head)), "Publication requires a merged release/next PR from this repository");
  // Validate every artifact and registry state before any irreversible publication.
  const artifacts = [];
  for (const item of plan.packages) {
    const directory = join(root, ".artifacts", `npm-${item.path}`);
    const metadata = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
    assert.equal(metadata.filename, `${item.name.replace(/^@/, "").replaceAll("/", "-")}-${item.to}.tgz`);
    const archive = join(directory, metadata.filename);
    const integrity = verifyArtifact(item, metadata, readFileSync(archive));
    const manifest = JSON.parse(run("tar", ["-xOf", archive, "package/package.json"]));
    assert.equal(manifest.name, item.name);
    assert.equal(manifest.version, item.to);
    const existing = await npmMetadata(item.name, item.to);
    publicationState(item, integrity, existing, existing ? null : await npmMetadata(item.name, "latest"));
    const tag = `${item.path}-v${item.to}`;
    const ref = await github(`git/ref/tags/${tag}`, { allow404: true });
    if (ref) {
      assert.equal(ref.object.type, "commit", "Expected a lightweight release tag");
      assert.equal(ref.object.sha, head, "Release tag points at a different commit");
    }
    artifacts.push({ item, archive, existing, tag, ref });
  }
  for (const { item, archive, existing, tag, ref } of artifacts) {
    if (!existing) npm(["publish", archive, "--ignore-scripts", "--access", "public", "--registry", registry], { stdio: "inherit" });
    else console.log(`Already published matching artifact: ${item.name}@${item.to}`);
    if (!ref) await github("git/refs", { method: "POST", body: { ref: `refs/tags/${tag}`, sha: head } });
    if (!await github(`releases/tags/${tag}`, { allow404: true })) {
      await github("releases", { method: "POST", body: {
        tag_name: tag, target_commitish: head, name: `${item.name}@${item.to}`,
        body: `${plan.notes}\n\nSource: ${head}\n\nInstall: \`npm install ${item.name}@${item.to}\``,
      } });
    }
  }
}

if (isMain(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === "prepare" || command === "apply") await prepare(args, command === "apply");
    else if (command === "check") {
      const plan = checkRelease(args[0], args[1]);
      if (plan?.cancelled) await verifyUnpublished(plan.cancelled);
      output("release", Boolean(plan && !plan.cancelled));
    } else if (command === "publish") await publish();
    else throw new Error("Expected prepare, apply, check, or publish");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
