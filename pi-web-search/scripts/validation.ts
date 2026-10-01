import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join } from "node:path";

/** Validation must not consult the operator's Pi config, auth store, or npm credentials. */
export function isolatedEnvironment(root: string): NodeJS.ProcessEnv {
	const home = join(root, "home");
	const agentDir = join(root, "agent");
	const temporaryDir = join(root, "tmp");
	mkdirSync(home, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(temporaryDir, { recursive: true });
	const npmrc = join(root, "npmrc");
	writeFileSync(npmrc, "");
	return {
		PATH: process.env.PATH,
		SystemRoot: process.env.SystemRoot,
		WINDIR: process.env.WINDIR,
		HOME: home,
		USERPROFILE: home,
		TMPDIR: temporaryDir,
		TEMP: temporaryDir,
		TMP: temporaryDir,
		PI_CODING_AGENT_DIR: agentDir,
		PI_WEB_SEARCH_CONFIG: join(agentDir, "web-search.json"),
		npm_config_userconfig: npmrc,
		npm_config_cache: process.env.npm_config_cache ?? join(home, ".npm"),
		npm_config_offline: "true",
		npm_config_audit: "false",
		npm_config_fund: "false",
		NO_COLOR: "1",
	};
}

export function withTemporaryDirectory<T>(prefix: string, run: (root: string) => T): T {
	const root = mkdtempSync(join(tmpdir(), prefix));
	try {
		return run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

/** Run npm's lifecycle-provided JS CLI directly: Windows .cmd shims require a shell. */
export function runNpmCommand(
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
	npmExecPath = process.env.npm_execpath,
): string {
	if (!npmExecPath || !isAbsolute(npmExecPath) ||
		![".js", ".cjs", ".mjs"].includes(extname(npmExecPath)) ||
		!existsSync(npmExecPath) || !statSync(npmExecPath).isFile()) {
		throw new Error("Run validation through npm: npm_execpath must name an existing absolute JavaScript CLI file");
	}
	return runCommand(process.execPath, [npmExecPath, ...args], cwd, env);
}

export function runCommand(
	command: string,
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
): string {
	const result = spawnSync(command, args, {
		cwd,
		env,
		encoding: "utf8",
		timeout: 120_000,
		maxBuffer: 2 * 1024 * 1024,
	});
	if (result.error || result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed\n${result.error?.message ?? ""}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
	}
	return result.stdout;
}
