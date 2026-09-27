import { execFile } from "node:child_process";
import { parsePorcelain, sameFiles, type FileChange } from "./files-modified.ts";

export const GIT_STATUS_TIMEOUT_MS = 2000;

export type GitPorcelainRunner = (cwd: string) => Promise<string>;

function gitPorcelain(cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { cwd, encoding: "utf8", timeout: GIT_STATUS_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (!error) {
          resolve(typeof stdout === "string" ? stdout : "");
          return;
        }
        if (error.killed) {
          reject(error);
          return;
        }
        resolve("");
      },
    );
  });
}

export class GitStatusPoller {
  private cwd = "";
  private refreshPromise?: Promise<void>;
  private refreshQueued = false;
  private last: FileChange[] = [];
  private started = false;
  private readonly onChange: (files: FileChange[]) => void;
  private readonly run: GitPorcelainRunner;

  constructor(
    onChange: (files: FileChange[]) => void,
    run: GitPorcelainRunner = gitPorcelain,
  ) {
    this.onChange = onChange;
    this.run = run;
  }

  start(cwd: string): void {
    this.cwd = cwd;
    this.last = [];
    this.started = true;
    void this.refresh();
  }

  refresh(): Promise<void> {
    if (!this.started || !this.cwd) return Promise.resolve();
    if (this.refreshPromise) {
      this.refreshQueued = true;
      return this.refreshPromise;
    }
    const pending = this.refreshUntilCurrent().finally(() => {
      if (this.refreshPromise === pending) this.refreshPromise = undefined;
    });
    this.refreshPromise = pending;
    return pending;
  }

  dispose(): void {
    this.started = false;
  }

  private async refreshUntilCurrent(): Promise<void> {
    do {
      this.refreshQueued = false;
      await this.pull();
    } while (this.refreshQueued);
  }

  private async pull(): Promise<void> {
    if (!this.started || !this.cwd) return;
    const cwd = this.cwd;
    try {
      const next = parsePorcelain(await this.run(cwd));
      if (!this.started || this.cwd !== cwd) return;
      if (sameFiles(this.last, next)) return;
      this.last = next;
      this.onChange(next);
    } catch {
      // Timeouts keep the last successful snapshot.
    }
  }
}
