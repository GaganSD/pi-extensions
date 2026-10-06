import assert from "node:assert/strict";
import { isBuiltin } from "node:module";
import { posix } from "node:path";
import { SyntaxKind } from "typescript/unstable/ast";
import { createScanner } from "typescript/unstable/ast/scanner";

export const packageAllowlist = ["src", "README.md", "LICENSE", "llms.txt", "docs"];
const hostPeers = ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"];

export interface PackageManifest {
	name: string;
	version: string;
	type: string;
	engines: { node: string };
	files: string[];
	keywords: string[];
	pi: { extensions: string[] };
	dependencies?: Record<string, string>;
	scripts?: Record<string, string>;
	peerDependencies: Record<string, string>;
	peerDependenciesMeta: Record<string, { optional?: boolean }>;
}

/** Checks the actual tarball, not npm's dry-run listing or a compiled substitute. */
export function validatePackageContent(manifest: PackageManifest, files: Map<string, string>): void {
	assert.equal(manifest.name, "@gagansd/pi-web-search");
	assert.equal(manifest.type, "module");
	assert.equal(manifest.engines.node, ">=22.19.0");
	assert.ok(manifest.keywords.includes("pi-package"));
	assert.deepEqual(manifest.files, packageAllowlist);
	assert.deepEqual(manifest.pi.extensions, ["./src/index.ts"]);
	assert.deepEqual(manifest.dependencies ?? {}, {}, "This source-only extension has no runtime dependencies");
	for (const hook of ["preinstall", "install", "postinstall", "prepare"]) {
		assert.equal(manifest.scripts?.[hook], undefined, `Consumers must not run lifecycle hook ${hook}`);
	}
	for (const name of hostPeers) {
		assert.equal(manifest.peerDependencies[name], "*", `${name} must be supplied by Pi, not bundled or version-resolved`);
		assert.equal(manifest.peerDependenciesMeta?.[name]?.optional, true, `${name} must not install automatically for consumers`);
	}
	for (const required of ["package.json", "README.md", "LICENSE", "src/index.ts"]) {
		assert.ok(files.has(required), `Missing required package file: ${required}`);
	}
	for (const [path, contents] of files) {
		assert.ok(isAllowedPackagePath(path), `Unexpected package file: ${path}`);
		if (!path.startsWith("src/")) continue;
		const checkImport = (specifier: string) => {
			if (specifier.startsWith(".")) {
				const target = posix.normalize(posix.join(posix.dirname(path), specifier));
				assert.ok(target.startsWith("src/"), `${path}: import escapes published source: ${specifier}`);
				assert.ok(files.has(target), `${path}: missing local import ${specifier}`);
				return;
			}
			if (isBuiltin(specifier)) return;
			const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
			assert.ok(Object.hasOwn(manifest.peerDependencies, name), `${path}: undeclared external import ${specifier}`);
		};
		const scanner = createScanner(true, undefined, contents);
		let declaration: "import" | "export" | undefined;
		for (let token = scanner.scan(); token !== SyntaxKind.EndOfFile; token = scanner.scan()) {
			if (token === SyntaxKind.ImportKeyword) {
				const next = scanner.scan();
				if (next === SyntaxKind.OpenParenToken) {
					const argument = scanner.scan();
					assert.ok(argument === SyntaxKind.StringLiteral, `${path}: dynamic imports must use literal packaged paths`);
					checkImport(scanner.getTokenValue());
					continue;
				}
				if (next === SyntaxKind.StringLiteral) {
					checkImport(scanner.getTokenValue());
					continue;
				}
				declaration = "import";
				continue;
			}
			if (token === SyntaxKind.ExportKeyword) {
				declaration = "export";
				continue;
			}
			if (token === SyntaxKind.FromKeyword && declaration !== undefined) {
				const next = scanner.scan();
				assert.ok(next === SyntaxKind.StringLiteral, `${path}: import and export specifiers must be string literals`);
				checkImport(scanner.getTokenValue());
				declaration = undefined;
				continue;
			}
			if (token === SyntaxKind.SemicolonToken) declaration = undefined;
		}
	}
}

const forbiddenNames = /(?:^|\/)(?:\.env(?:\..*)?|auth\.json|.*\.pem)$/i;

export function isAllowedPackagePath(path: string): boolean {
	if (forbiddenNames.test(path)) return false;
	if (path.includes("\\") || path.split("/").some((part) => part === ".." || part.startsWith(".") || part === "node_modules")) return false;
	if (["package.json", "README.md", "LICENSE", "llms.txt"].includes(path)) return true;
	if (path.startsWith("src/")) return path.endsWith(".ts") && !path.endsWith(".d.ts");
	return path.startsWith("docs/") && /\.(?:md|txt)$/.test(path);
}
