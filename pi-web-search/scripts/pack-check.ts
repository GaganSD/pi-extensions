import assert from "node:assert/strict";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isAllowedPackagePath, validatePackageContent, type PackageManifest } from "./package-content.ts";
import { isolatedEnvironment, runCommand, withTemporaryDirectory } from "./validation.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function sourcePaths(directory: string, prefix = "src"): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
		? sourcePaths(join(directory, entry.name), `${prefix}/${entry.name}`)
		: [`${prefix}/${entry.name}`]).sort();
}

withTemporaryDirectory("pi-web-search-pack-", (root) => {
	const env = isolatedEnvironment(root);
	const output = JSON.parse(runCommand(npm,
		["pack", "--json", "--ignore-scripts", "--offline", "--pack-destination", root], packageRoot, env));
	// npm 10/11 return an array; npm 12 keys the same metadata by package name.
	const packed = Array.isArray(output) ? output : Object.values(output);
	assert.equal(packed.length, 1);
	const metadata = packed[0];
	assert.ok(metadata.size <= 5 * 1024 * 1024 && metadata.unpackedSize <= 5 * 1024 * 1024, "Package exceeds the 5 MiB validation bound");
	assert.equal(metadata.filename, `${metadata.name.replace(/^@/, "").replaceAll("/", "-")}-${metadata.version}.tgz`);
	const archive = join(root, metadata.filename);
	const listed = runCommand("tar", ["-tzf", archive], packageRoot, env).trim().split("\n");
	assert.ok(listed.length <= 512, "Package exceeds the 512-file validation bound");
	const paths = listed.map((path) => {
		assert.ok(path.startsWith("package/") && isAllowedPackagePath(path.slice(8)), `Unexpected archive member: ${path}`);
		return path.slice(8);
	}).sort();
	assert.equal(new Set(paths).size, paths.length, "Duplicate archive members");
	assert.deepEqual(paths, metadata.files.map((file: { path: string }) => file.path).sort());
	const extracted = join(root, "extracted");
	mkdirSync(extracted);
	runCommand("tar", ["-xzf", archive, "-C", extracted], packageRoot, env);
	const artifact = join(extracted, "package");
	const files = new Map(paths.map((path) => {
		const absolute = join(artifact, path);
		assert.ok(lstatSync(absolute).isFile(), `Archive member must be a regular file: ${path}`);
		return [path, readFileSync(absolute, "utf8")];
	}));
	const manifest: PackageManifest = JSON.parse(files.get("package.json")!);
	validatePackageContent(manifest, files);
	assert.deepEqual(paths.filter((path) => path.startsWith("src/")), sourcePaths(join(packageRoot, "src")), "Every TypeScript source module must ship");
	for (const path of paths.filter((path) => path !== "package.json")) {
		assert.equal(files.get(path), readFileSync(join(packageRoot, path), "utf8"), `Packed file differs from source: ${path}`);
	}
	for (const optional of ["llms.txt", "docs"]) {
		if (existsSync(join(packageRoot, optional))) {
			assert.ok(paths.some((path) => path === optional || path.startsWith(`${optional}/`)), `${optional} exists but was omitted from the package`);
		}
	}
	// Matches Pi's managed npm install: host peers must not be fetched or duplicated.
	const consumer = join(root, "consumer");
	mkdirSync(consumer);
	writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "pack-check-consumer", private: true }));
	runCommand(npm, ["install", archive, "--omit=dev", "--legacy-peer-deps", "--ignore-scripts", "--offline", "--package-lock=false"], consumer, env);
	assert.deepEqual(readdirSync(join(consumer, "node_modules")).filter((path) => !path.startsWith(".")), ["@gagansd"], "Installing the tarball must not install host peers");
	const installed = join(consumer, "node_modules", manifest.name);
	process.stdout.write(runCommand(process.execPath, ["--experimental-strip-types", join(packageRoot, "scripts/artifact-smoke.ts"), installed], packageRoot, env));
	// Tests/fixtures stay out of the publication, but run against the extracted src.
	cpSync(join(packageRoot, "tests"), join(artifact, "tests"), {
		recursive: true,
		filter: (path) => path !== join(packageRoot, "tests/package"),
	});
	symlinkSync(resolve(packageRoot, "node_modules"), join(artifact, "node_modules"), "junction");
	process.stdout.write(runCommand(process.execPath,
		["--experimental-strip-types", join(packageRoot, "scripts/test.ts"), join(artifact, "tests")], packageRoot, env));
	console.log(`Package content validated: ${paths.length} files, ${metadata.unpackedSize} unpacked bytes; extracted-source regression tests passed.`);
});
