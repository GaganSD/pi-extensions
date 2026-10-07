import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { RunRecord } from "./types.ts";

export interface ArtifactStore {
  directory(id: string): string;
  create(record: RunRecord, signal?: AbortSignal): Promise<void>;
  save(record: RunRecord, signal?: AbortSignal): Promise<void>;
  report(id: string, text: string, signal?: AbortSignal): Promise<string>;
}
export class FileArtifacts implements ArtifactStore {
  readonly root: string;
  constructor(root: string) { this.root = root; }
  directory(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid run ID");
    return path.join(this.root, id);
  }
  async create(record: RunRecord, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await mkdir(this.root, { recursive: true, mode: 0o700 }); // mkdir has no signal option; check at each step.
    // Recursive mkdir only applies mode to the first new ancestor and never to an existing root.
    await chmod(this.root, 0o700);
    signal?.throwIfAborted();
    const directory = this.directory(record.id);
    await mkdir(directory, { mode: 0o700 });
    signal?.throwIfAborted();
    try {
      await this.save(record, signal);
    } catch (error) {
      // Roll back the allocation so a later create() for this id can succeed.
      await rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }
  async save(record: RunRecord, signal?: AbortSignal): Promise<void> {
    await atomic(path.join(this.directory(record.id), "run.json"), JSON.stringify(record, null, 2) + "\n", signal);
  }
  async report(id: string, text: string, signal?: AbortSignal): Promise<string> {
    if (!text.trim()) throw new Error("Sub-agent settled without a nonempty report");
    const target = path.join(this.directory(id), "report.md");
    await atomic(target, text + "\n", signal);
    return target;
  }
}
async function atomic(target: string, contents: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(contents, { signal });
      signal?.throwIfAborted(); // A timed-out write must not publish stale success.
      await handle.sync(); // Durable before the rename publishes the final name.
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    const directory = await open(path.dirname(target), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await rm(temporary, { force: true });
  }
}
