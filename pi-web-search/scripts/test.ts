import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedEnvironment, runCommand, withTemporaryDirectory } from "./validation.ts";

export function testFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true })
		.flatMap((entry) => entry.isDirectory()
			? testFiles(join(directory, entry.name))
			: entry.isFile() && entry.name.endsWith(".test.ts") ? [join(directory, entry.name)] : [])
		.sort();
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tests = testFiles(resolve(process.argv[2] ?? join(packageRoot, "tests")));
if (tests.length === 0) throw new Error("No test files found");
withTemporaryDirectory("pi-web-search-tests-", (root) => {
	process.stdout.write(runCommand(process.execPath,
		["--test", "--experimental-strip-types", ...tests], packageRoot, isolatedEnvironment(root)));
});
