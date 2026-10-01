import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { isolatedEnvironment, runNpmCommand, withTemporaryDirectory } from "../../scripts/validation.ts";

test("runNpmCommand invokes the JS CLI with the current Node and literal array arguments, including spaces", () => {
	withTemporaryDirectory("npm cli validation space-", (root) => {
		const cli = join(root, "mock npm cli.cjs");
		writeFileSync(cli, "console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), node: process.execPath }));");
		const args = ["pack", "--pack-destination", join(root, "packed output"), "literal & echo not-a-command", 'literal "quotes" $HOME', "line\nbreak"];
		const output = runNpmCommand(args, root, isolatedEnvironment(root), cli);
		assert.deepEqual(JSON.parse(output), { args, cwd: realpathSync(root), node: process.execPath });
	});
});

test("runNpmCommand rejects missing, relative, nonexistent, directory, and non-JavaScript CLI paths", () => {
	withTemporaryDirectory("npm cli invalid space-", (root) => {
		const directory = join(root, "directory.js");
		mkdirSync(directory);
		const shim = join(root, "npm.cmd");
		writeFileSync(shim, "must not execute");
		for (const cli of ["", "relative cli.js", join(root, "missing cli.js"), directory, shim]) {
			assert.throws(() => runNpmCommand(["pack"], root, isolatedEnvironment(root), cli), /npm_execpath must name an existing absolute JavaScript CLI file/);
		}
	});
});

test("runNpmCommand propagates a failing CLI with stdout and stderr", () => {
	withTemporaryDirectory("npm cli failure space-", (root) => {
		const cli = join(root, "failing npm cli.cjs");
		writeFileSync(cli, 'console.log("mock CLI stdout"); console.error("mock CLI stderr"); process.exit(7);');
		assert.throws(() => runNpmCommand(["install"], root, isolatedEnvironment(root), cli), /failed[\s\S]*mock CLI stdout[\s\S]*mock CLI stderr/);
	});
});
