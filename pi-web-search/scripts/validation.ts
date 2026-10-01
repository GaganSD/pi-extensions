import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Validation must not consult the operator's Pi config, auth store, or npm credentials. */
export function isolatedEnvironment(root: string): NodeJS.ProcessEnv {
	const home = join(root, "home");
	const agentDir = join(root, "agent");
	mkdirSync(home, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	const npmrc = join(root, "npmrc");
	writeFileSync(npmrc, "");
	return {
		PATH: process.env.PATH,
		SystemRoot: process.env.SystemRoot,
		WINDIR: process.env.WINDIR,
		HOME: home,
		USERPROFILE: home,
		TMPDIR: tmpdir(),
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
