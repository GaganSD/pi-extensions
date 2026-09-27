import { execFile } from "node:child_process";
import { relative, resolve, sep } from "node:path";
import type { FileChange } from "./files-modified.ts";

export const GIT_DIFF_TIMEOUT_MS = 2000;
export type GitDiffRunResult = { stdout: string; exitCode: number };
export type GitDiffRunner = (cwd: string, argv: string[]) => Promise<GitDiffRunResult>;
export type GitDiffResult = { state: "diff" | "empty" | "error"; text: string };
export type DiffLineKind = "added" | "removed" | "hunk" | "header" | "context";

function gitDiff(cwd: string, argv: string[]): Promise<GitDiffRunResult> {
  return new Promise((resolveResult, reject) => {
    execFile(
      "git",
      argv,
      { cwd, encoding: "utf8", timeout: GIT_DIFF_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        const text = typeof stdout === "string" ? stdout : "";
        // git diff --no-index returns 1 whenever it found a difference.
        if (!error || (typeof error.code === "number" && error.code === 1)) {
          resolveResult({ stdout: text, exitCode: typeof error?.code === "number" ? error.code : 0 });
          return;
        }
        reject(error);
      },
    );
  });
}

export function isUntracked(change: FileChange): boolean {
  return change.index === "?" || change.worktree === "?";
}

export function classifyDiffLine(line: string): DiffLineKind {
  if (
    line.startsWith("+++")
    || line.startsWith("---")
    || /^(?:diff |index |new file |deleted file |old mode |new mode |similarity index |rename |copy )/.test(line)
  ) {
    return "header";
  }
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "added";
  if (line.startsWith("-")) return "removed";
  return "context";
}

export function isBinaryDiff(text: string): boolean {
  return text.includes("\0") || /^Binary files .+ differ$/m.test(text) || /^GIT binary patch$/m.test(text);
}

export function repoRelativePath(cwd: string, filePath: string): string | undefined {
  const root = resolve(cwd);
  const absolute = resolve(cwd, filePath);
  const rel = relative(root, absolute);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || resolve(cwd, rel) !== absolute) return undefined;
  return rel;
}

export function gitDiffArgs(cwd: string, change: FileChange): string[] | undefined {
  const rel = repoRelativePath(cwd, change.path);
  if (!rel) return undefined;
  if (isUntracked(change)) {
    return [
      "--no-optional-locks",
      "diff",
      "--no-index",
      "--no-ext-diff",
      "--color=never",
      "--",
      "/dev/null",
      resolve(cwd, rel),
    ];
  }
  if (change.origPath) {
    const origRel = repoRelativePath(cwd, change.origPath);
    if (!origRel) return undefined;
    return ["--no-optional-locks", "diff", "--no-ext-diff", "--color=never", "-M", "HEAD", "--", origRel, rel];
  }
  return ["--no-optional-locks", "diff", "--no-ext-diff", "--color=never", "HEAD", "--", rel];
}

export async function loadGitDiff(
  cwd: string,
  change: FileChange,
  run: GitDiffRunner = gitDiff,
): Promise<GitDiffResult> {
  const argv = gitDiffArgs(cwd, change);
  if (!argv) return { state: "error", text: "Preview unavailable: file path is outside this workspace." };
  try {
    const result = await run(cwd, argv);
    if (!result.stdout || isBinaryDiff(result.stdout)) {
      return { state: "empty", text: "No text diff is available for this file." };
    }
    return { state: "diff", text: result.stdout };
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : "Git could not load this diff.";
    return { state: "error", text: `Preview unavailable: ${message}` };
  }
}

function cacheKey(cwd: string, snapshot: string, change: FileChange): string {
  return `${cwd}\0${snapshot}\0${change.index}${change.worktree}\0${change.path}\0${change.origPath ?? ""}`;
}

/** Selection token and status-snapshot cache for lazy diff requests. */
export class GitDiffPreviewLoader {
  private generation = 0;
  private snapshot = "";
  private cache = new Map<string, GitDiffResult>();
  private inflight = new Map<string, Promise<GitDiffResult>>();
  private readonly run: GitDiffRunner;

  constructor(run: GitDiffRunner = gitDiff) {
    this.run = run;
  }

  clear(): void {
    this.generation += 1;
    this.snapshot = "";
    this.cache.clear();
    this.inflight.clear();
  }

  peek(cwd: string, change: FileChange, snapshot: string): GitDiffResult | undefined {
    return this.cache.get(cacheKey(cwd, snapshot, change));
  }

  async select(
    cwd: string,
    change: FileChange,
    snapshot: string,
    apply: (result: GitDiffResult) => void,
  ): Promise<void> {
    const generation = ++this.generation;
    if (this.snapshot !== snapshot) {
      this.snapshot = snapshot;
      this.cache.clear();
      this.inflight.clear();
    }
    const key = cacheKey(cwd, snapshot, change);
    const cached = this.cache.get(key);
    if (cached) {
      if (generation === this.generation) apply(cached);
      return;
    }

    let pending = this.inflight.get(key);
    if (!pending) {
      pending = loadGitDiff(cwd, change, this.run).then((result) => {
        if (this.snapshot === snapshot) this.cache.set(key, result);
        this.inflight.delete(key);
        return result;
      });
      this.inflight.set(key, pending);
    }

    const result = await pending;
    if (generation === this.generation) apply(result);
  }
}
