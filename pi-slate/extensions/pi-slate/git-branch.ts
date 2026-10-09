import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Composer branch facts must not require taking the host's footer slot. */
export class GitBranchPoller {
  private timer?: ReturnType<typeof setInterval>;
  private generation = 0;
  private pending = false;

  private readonly pi: Pick<ExtensionAPI, "exec">;
  private readonly onChange: (branch: string | null) => void;

  constructor(pi: Pick<ExtensionAPI, "exec">, onChange: (branch: string | null) => void) {
    this.pi = pi;
    this.onChange = onChange;
  }

  start(cwd: string): void {
    this.dispose();
    const generation = this.generation;
    const refresh = async (): Promise<void> => {
      if (this.pending) return;
      this.pending = true;
      try {
        const result = await this.pi.exec("git", ["-C", cwd, "branch", "--show-current"], { timeout: 2000 });
        if (generation === this.generation) this.onChange(result.code === 0 ? result.stdout.trim() || null : null);
      } catch {
        if (generation === this.generation) this.onChange(null);
      } finally {
        this.pending = false;
      }
    };
    void refresh();
    this.timer = setInterval(() => void refresh(), 5000);
    this.timer.unref();
  }

  dispose(): void {
    this.generation += 1;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
