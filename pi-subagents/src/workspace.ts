import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

export function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  // Case-insensitive GIT_* stripping: Windows environment variables are case-insensitive.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  env.LC_ALL = "C"; // Deterministic English fatals for error classification.
  env.LANG = "C";
  return new Promise((resolve, reject) => {
    execFile("git", ["--no-optional-locks", "--literal-pathspecs", "--no-pager", "-c", "core.fsmonitor=false", "-C", cwd, ...args], {
      env, signal, timeout: 10000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8", windowsHide: true,
    }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      const detail = (stderr || error.message).trim();
      let message: string;
      if (error.killed) message = `Git inspection timed out or was aborted: ${detail}`;
      else if ((error as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") message = `Git inspection failed (narrow the target if output is too large): ${detail}`;
      else message = `Git inspection failed: ${detail}`;
      const wrapped = new Error(message, { cause: error }) as Error & { stderr?: string };
      wrapped.stderr = stderr ?? "";
      reject(wrapped);
    });
  });
}
export async function canonicalDirectory(value: string): Promise<string> {
  const canonical = await realpath(value);
  if (!(await stat(canonical)).isDirectory()) throw new Error(`Not a directory: ${value}`);
  return canonical;
}
export async function workspaceRoot(cwd: string, signal?: AbortSignal): Promise<string> {
  cwd = await canonicalDirectory(cwd);
  // Distinguish a non-repository from a broken Git executable or timed-out command.
  try {
    const root = (await git(cwd, ["rev-parse", "--show-toplevel"], signal)).trimEnd();
    return await canonicalDirectory(root);
  } catch (error) {
    if (signal?.aborted) throw error;
    const stderr = error instanceof Error ? ((error as Error & { stderr?: string }).stderr ?? error.message) : String(error);
    if (/(?:^|\n)fatal: not a git repository\b/.test(stderr)) return cwd;
    throw error;
  }
}
/** Containment after symlink resolution so aliases of one tree cannot admit two writers. */
export async function overlaps(a: string, b: string): Promise<boolean> {
  const normalize = async (value: string) => {
    const resolved = await realpath(value).catch(() => path.resolve(value));
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const [left, right] = await Promise.all([normalize(a), normalize(b)]);
  const inside = (root: string, candidate: string) => {
    const rel = path.relative(root, candidate);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
  };
  return inside(left, right) || inside(right, left);
}
