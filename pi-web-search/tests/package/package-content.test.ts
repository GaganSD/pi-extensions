import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { isAllowedPackagePath, packageAllowlist, validatePackageContent, type PackageManifest } from "../../scripts/package-content.ts";
import { isolatedEnvironment, withTemporaryDirectory } from "../../scripts/validation.ts";

function fixture(): { manifest: PackageManifest; files: Map<string, string> } {
	const manifest: PackageManifest = {
		name: "@gagansd/pi-web-search",
		version: "0.1.0",
		type: "module",
		engines: { node: ">=22.19.0" },
		files: [...packageAllowlist],
		keywords: ["pi-package"],
		pi: { extensions: ["./src/index.ts"] },
		peerDependencies: {
			"@earendil-works/pi-ai": "*",
			"@earendil-works/pi-coding-agent": "*",
			"@earendil-works/pi-tui": "*",
			typebox: "*",
		},
	};
	const files = new Map([
		["package.json", JSON.stringify(manifest)],
		["README.md", "Package documentation"],
		["LICENSE", "MIT"],
		["src/index.ts", 'import { Type } from "@earendil-works/pi-ai";\nexport { value } from "./value.ts";\nexport default function () {}'],
		["src/value.ts", 'import { readFile } from "node:fs/promises";\nexport const value = 1;\nconst load = () => import("./nested/other.ts");'],
		["src/nested/other.ts", "export default 2;"],
	]);
	return { manifest, files };
}

function validate(change: (sample: ReturnType<typeof fixture>) => void): void {
	const value = fixture();
	change(value);
	validatePackageContent(value.manifest, value.files);
}

test("package-content accepts a complete source-only Pi package without future docs", () => {
	assert.doesNotThrow(() => validate(() => {}));
});

test("package-content permits future llms.txt and Markdown/text docs, not generated artifacts or secrets", () => {
	assert.doesNotThrow(() => validate(({ files }) => {
		files.set("llms.txt", "# Search\n");
		files.set("docs/configuration.md", "# Configuration\n");
	}));
	for (const path of ["tests/leak.test.ts", "scripts/test.ts", "node_modules/typebox/index.js", "SPEC.md", "dist/index.js", "src/index.ts.map", "src/generated.d.ts", "src/.env", "docs/auth.json", "docs/node_modules/leak.md", "../README.md", "/README.md", "docs/../../secret.md", "src\\index.ts"]) {
		assert.equal(isAllowedPackagePath(path), false, path);
		assert.throws(() => validate(({ files }) => files.set(path, "leak")), /Unexpected package file/);
	}
});

test("package-content requires the README, license, and declared TS entrypoint", () => {
	for (const path of ["package.json", "README.md", "LICENSE", "src/index.ts"]) {
		assert.throws(() => validate(({ files }) => files.delete(path)), /Missing required package file/);
	}
	assert.throws(() => validate(({ manifest }) => { manifest.pi.extensions = ["./dist/index.js"]; }));
});

test("package-content verifies static, re-exported, and dynamic local import closure", () => {
	assert.throws(() => validate(({ files }) => files.delete("src/value.ts")), /missing local import \.\/value\.ts/);
	assert.throws(() => validate(({ files }) => files.delete("src/nested/other.ts")), /missing local import \.\/nested\/other\.ts/);
	assert.throws(() => validate(({ files }) => files.set("src/value.ts", 'import type { X } from "./missing.ts";')), /missing local import/);
});

test("package-content rejects imports outside published source and nonliteral dynamic imports", () => {
	assert.throws(() => validate(({ files }) => files.set("src/value.ts", 'export * from "../tests/helper.ts";')), /import escapes published source/);
	assert.throws(() => validate(({ files }) => files.set("src/value.ts", 'const path = "./nested/other.ts"; import(path);')), /dynamic imports must use literal/);
});

test("package-content requires declared host imports and accepts their subpaths", () => {
	assert.throws(() => validate(({ files }) => files.set("src/value.ts", 'import "undeclared-package";')), /undeclared external import/);
	assert.doesNotThrow(() => validate(({ files }) => files.set("src/value.ts", 'import "typebox/value"; import "fs";')));
});

test("package-content prevents bundling or separately version-resolving host packages", () => {
	assert.throws(() => validate(({ manifest }) => { manifest.dependencies = { "@earendil-works/pi-ai": "0.99.0" }; }), /no runtime dependencies/);
	assert.throws(() => validate(({ manifest }) => { manifest.peerDependencies["@earendil-works/pi-ai"] = ">=0.99.0"; }), /must be supplied by Pi/);
	assert.throws(() => validate(({ manifest }) => { manifest.files.push("tests"); }));
});

test("validation isolates Pi/npm configuration and excludes inherited credentials", () => {
	let temporaryRoot = "";
	withTemporaryDirectory("package-environment-test-", (root) => {
		temporaryRoot = root;
		const env = isolatedEnvironment(root);
		assert.equal(env.HOME, join(root, "home"));
		assert.equal(env.PI_CODING_AGENT_DIR, join(root, "agent"));
		assert.equal(env.PI_WEB_SEARCH_CONFIG, join(root, "agent/web-search.json"));
		assert.ok(existsSync(env.npm_config_userconfig!));
		assert.equal(env.npm_config_offline, "true");
		for (const name of ["EXA_API_KEY", "PARALLEL_API_KEY", "GITHUB_TOKEN", "GH_TOKEN", "TYPESAFE_API_KEY", "JEV_API_KEY", "AI_GATEWAY_API_KEY", "NODE_OPTIONS", "NPM_TOKEN"]) {
			assert.equal(env[name], undefined, name);
		}
	});
	assert.equal(existsSync(temporaryRoot), false, "Validation cleans up temporary files");
});
