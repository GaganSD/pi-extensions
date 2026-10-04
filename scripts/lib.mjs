import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../", import.meta.url));
export function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root, encoding: "utf8", timeout: 600_000, maxBuffer: 16 * 1024 * 1024, ...options,
  });
}
export function git(...args) { return run("git", args).trim(); }
export function npm(args, options = {}) {
  if (!process.env.npm_execpath) throw new Error("Run this command through npm");
  return run(process.execPath, [process.env.npm_execpath, ...args], options);
}
export function isMain(url) {
  return Boolean(process.argv[1]) && realpathSync(fileURLToPath(url)) === realpathSync(resolve(process.argv[1]));
}
export function isolatedEnvironment(directory) {
  const home = join(directory, "home"), agent = join(directory, "agent");
  mkdirSync(home, { recursive: true });
  mkdirSync(agent, { recursive: true });
  const npmrc = join(directory, "npmrc");
  writeFileSync(npmrc, "");
  return {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
    HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agent,
    PI_WEB_SEARCH_CONFIG: join(agent, "web-search.json"),
    npm_execpath: process.env.npm_execpath,
    npm_config_cache: process.env.npm_config_cache,
    npm_config_userconfig: npmrc, NO_COLOR: "1",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
  };
}
