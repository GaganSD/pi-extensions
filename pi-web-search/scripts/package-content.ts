import assert from "node:assert/strict";
import { isBuiltin } from "node:module";
import { posix } from "node:path";
import ts from "typescript";

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
	}
	for (const required of ["package.json", "README.md", "LICENSE", "src/index.ts"]) {
		assert.ok(files.has(required), `Missing required package file: ${required}`);
	}
	for (const [path, contents] of files) {
		assert.ok(isAllowedPackagePath(path), `Unexpected package file: ${path}`);
		if (!path.startsWith("src/")) continue;
		const source = ts.createSourceFile(path, contents, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
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
		const visit = (node: ts.Node): void => {
			if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
				if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) checkImport(node.moduleSpecifier.text);
			} else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
				assert.ok(node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]), `${path}: dynamic imports must use literal packaged paths`);
				checkImport((node.arguments[0] as ts.StringLiteral).text);
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
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
