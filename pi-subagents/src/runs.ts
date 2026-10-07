import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ArtifactStore } from "./artifacts.ts";
import { errorText, isLive, PREVIEW_LINES, type SubAgent, type Config, type PreparedTask, type Question, type RunRecord } from "./types.ts";
import { overlaps } from "./workspace.ts";
import { text } from "./validation.ts";

interface PendingQuestion {
  question: Question;
  resolve(message: string): void;
  reject(error: Error): void;
}
interface Run {
  record: RunRecord;
  preview: string[];
  controller: AbortController;
  subAgent?: SubAgent;
  question?: PendingQuestion;
  work: Promise<void>;
  writes: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  stopping?: Promise<void>;
  aborting?: Promise<void>;
  notified: boolean;
  cleaned: boolean;
  pendingWrites: Set<AbortController>;
  finishing?: Promise<void>;
}
export interface ManagerOptions {
  owner: string;
  config: Config;
  store: ArtifactStore;
  admitted?: number;
  recordAdmissions?(total: number): void;
  changed?(): void;
  notify?(record: RunRecord, kind: "question" | "finished"): Promise<void>;
  unsafeCleanup?(record: RunRecord): void;
  assertLaunchable?(): void;
  cleanupMs?: number;
}

/** Owns only this live agent. Files are evidence, never a source of launch authority. */
export class RunManager {
  private readonly runs = new Map<string, Run>();
  private admission: Promise<void> = Promise.resolve();
  private closed = false;
  private blocked?: string;
  private admitted: number;
  private readonly options: ManagerOptions;
  constructor(options: ManagerOptions) { this.options = options; this.admitted = options.admitted ?? 0; }

  list(): RunRecord[] { return [...this.runs.values()].map(run => this.snapshot(run)); }
  live(): RunRecord[] { return [...this.runs.values()].filter(run => isLive(run.record.state)).map(run => this.snapshot(run)); }
  status(id: string): RunRecord { return this.snapshot(this.owned(id)); }
  preview(id: string): string[] { return this.owned(id).preview.slice(); }
  get activeCount(): number { return [...this.runs.values()].filter(run => isLive(run.record.state)).length; }

  /** Serialize allocation and admission across concurrent model tool calls. */
  async launch(plans: PreparedTask[], signal?: AbortSignal): Promise<string[]> {
    let release!: () => void;
    const previous = this.admission;
    this.admission = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      signal?.throwIfAborted();
      this.assertLaunchable();
      if (plans.length < 1 || plans.length > 4) throw new Error("A batch needs 1–4 tasks");
      if (this.activeCount + plans.length > this.options.config.maxConcurrent) throw new Error("Concurrent sub-agent limit reached; wait for existing results");
      if (this.admitted + plans.length > this.options.config.maxRuns) throw new Error("Session launch budget exhausted");
      const live = [...this.runs.values()].filter(run => isLive(run.record.state)).map(run => run.record);
      const all = [...live, ...plans];
      for (let i = live.length; i < all.length; i++) {
        for (let j = 0; j < i; j++) {
          if ((all[i]!.mode === "edit" || all[j]!.mode === "edit") && await overlaps(all[i]!.workspace, all[j]!.workspace)) {
            throw new Error("Conflicting delegated workspaces: writers cannot overlap other readers or writers. Use separate existing worktrees.");
          }
        }
      }
      const staged: Run[] = [];
      try {
        for (const plan of plans) {
          const id = randomUUID();
          const record: RunRecord = {
            id, owner: this.options.owner, agent: plan.agent, mode: plan.mode, task: plan.task,
            cwd: plan.cwd, workspace: plan.workspace, model: plan.model, thinking: plan.thinking, state: "starting",
            startedAt: new Date().toISOString(), elapsedMs: 0, pid: process.pid,
            metadataPath: path.join(this.options.store.directory(id), "run.json"),
          };
          const run: Run = { record, preview: [], controller: new AbortController(), work: Promise.resolve(), writes: Promise.resolve(), notified: false, cleaned: false, pendingWrites: new Set() };
          staged.push(run);
          await this.io(signal => this.options.store.create(record, signal));
        }
        signal?.throwIfAborted();
        if (this.closed) throw new Error("Agent shut down during admission");
        this.assertLaunchable(); // Cleanup can become uncertain during allocation I/O.
        this.options.recordAdmissions?.(this.admitted + plans.length);
      } catch (error) {
        await Promise.allSettled(staged.map(async run => {
          run.record.state = "failed";
          run.record.error = `Admission failed; sub-agent was not started: ${errorText(error)}`;
          run.record.endedAt = new Date().toISOString();
          await this.persist(run);
        }));
        throw error;
      }
      this.admitted += plans.length;
      for (const run of staged) this.runs.set(run.record.id, run);
      for (const [index, run] of staged.entries()) {
        run.timer = setTimeout(() => { void this.stop(run.record.id, "Run deadline exceeded").catch(() => {}); }, this.options.config.timeoutMs);
        run.work = this.execute(run, plans[index]!);
      }
      this.changed();
      return staged.map(run => run.record.id);
    } finally { release(); }
  }

  async steer(id: string, message: string): Promise<string> {
    const run = this.owned(id);
    if (run.record.state !== "running" || !run.subAgent) throw new Error("Steer requires a running sub-agent; use reply for its pending question");
    return run.subAgent.steer(text(message, "message", 8192));
  }

  async reply(id: string, requestId: string, message: string): Promise<void> {
    const run = this.owned(id);
    if (run.record.state !== "waiting_for_agent" || !run.question || run.question.question.id !== requestId) {
      throw new Error("No matching pending question belongs to this run");
    }
    const answer = text(message, "message", 8192);
    const question = run.question;
    run.question = undefined;
    run.record.question = undefined;
    run.record.state = "running";
    try { await this.persist(run); }
    catch (error) {
      question.reject(new Error(`Cannot persist agent reply: ${errorText(error)}`));
      await this.stop(id, `Cannot persist agent reply: ${errorText(error)}`);
      throw error;
    }
    if (run.controller.signal.aborted) question.reject(new Error("Run cancelled while replying"));
    else question.resolve(answer);
    this.changed();
  }

  async stop(id: string, reason = "Stopped by agent"): Promise<void> {
    const run = this.owned(id);
    if (!isLive(run.record.state) || run.record.state === "cleanup_unknown") return;
    if (run.stopping) return run.stopping;
    run.record.state = "cancelling";
    run.record.error = reason;
    run.controller.abort(new Error(reason));
    this.changed();
    run.stopping = this.awaitStopped(run);
    return run.stopping;
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    // An in-flight admission checks closed again before starting any sub-agent.
    // Do not let allocation I/O hold shutdown hostage.
    await Promise.all([...this.runs.values()].map(run => this.stop(run.record.id, "Agent session ended or reloaded")));
  }

  /** Used by tests/host lifecycle barriers, not exposed as a polling tool. */
  async settled(id: string): Promise<void> { await this.owned(id).work; }

  private owned(id: string): Run {
    const run = this.runs.get(id);
    if (!run) throw new Error("Unknown run ID for this agent runtime; prefixes, foreign runs, and retained resume are unsupported");
    return run;
  }
  private snapshot(run: Run): RunRecord {
    return structuredClone({ ...run.record, elapsedMs: Math.max(0, (run.record.endedAt ? Date.parse(run.record.endedAt) : Date.now()) - Date.parse(run.record.startedAt)) });
  }
  private changed(): void { try { this.options.changed?.(); } catch { /* UI never determines execution success. */ } }
  private assertLaunchable(): void {
    if (this.closed) throw new Error("This agent runtime is closed; no new runs can start");
    if (this.blocked) throw new Error(this.blocked);
    this.options.assertLaunchable?.();
  }
  private poison(run: Run, reason: string): void {
    if (run.record.state === "cleanup_unknown") return;
    run.record.state = "cleanup_unknown";
    run.record.error = reason;
    run.record.endedAt = new Date().toISOString();
    this.blocked = `A sub-agent has unknown cleanup. Restart Pi before launching more sub-agents. Evidence: ${run.record.metadataPath}`;
    try { this.options.unsafeCleanup?.(this.snapshot(run)); } catch { /* The local fence remains authoritative. */ }
    this.changed();
  }
  private io<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    return bounded(work(controller.signal), this.options.cleanupMs ?? 5000, "Artifact I/O deadline exceeded", controller);
  }
  private persist(run: Run): Promise<void> {
    const controller = new AbortController();
    run.pendingWrites.add(controller);
    const write = run.writes.then(() => {
      // A predecessor that ignored its abort must not let this write start stale I/O.
      controller.signal.throwIfAborted();
      // Snapshot at write time; an enqueue-time snapshot can overwrite a newer terminal state.
      return this.options.store.save(this.snapshot(run), controller.signal);
    });
    run.writes = write.catch(() => {}); // Serialize actual I/O, not just its deadline wrapper.
    return bounded(write, this.options.cleanupMs ?? 5000, "Metadata write deadline exceeded", controller)
      .finally(() => { run.pendingWrites.delete(controller); });
  }

  private async execute(run: Run, plan: PreparedTask): Promise<void> {
    let failed: string | undefined;
    try {
      const subAgent = await plan.start({
        signal: run.controller.signal, directory: this.options.store.directory(run.record.id),
        own: subAgent => {
          if (run.subAgent && run.subAgent !== subAgent) throw new Error("Startup transferred more than one sub-agent");
          run.subAgent = subAgent;
        },
        telemetry: snapshot => {
          // Ignore late startup/queued events after cancellation or finalization.
          // Retain the last observed values; never fabricate late session evidence.
          if (run.controller.signal.aborted || run.record.endedAt || !isLive(run.record.state)) return;
          const usage = snapshot.contextUsage;
          const prior = run.record.contextUsage;
          if (run.record.pid === snapshot.pid && (!snapshot.sessionId || run.record.sessionId === snapshot.sessionId)
            && prior?.tokens === usage.tokens && prior?.contextWindow === usage.contextWindow && prior?.percent === usage.percent) return;
          run.record.pid = snapshot.pid;
          if (snapshot.sessionId) run.record.sessionId = snapshot.sessionId;
          run.record.contextUsage = { ...usage };
          this.changed(); // Cached UI update only; lifecycle writes persist the latest snapshot.
        },
        progress: tool => { if (!run.controller.signal.aborted) { run.record.currentTool = tool; this.changed(); } },
        preview: line => {
          run.preview.push(line.slice(0, 512));
          if (run.preview.length > PREVIEW_LINES) run.preview.shift();
          this.changed();
        },
        transcript: file => { run.record.sessionPath = file; },
        ask: (message, signal) => this.ask(run, message, signal),
      });
      if (run.subAgent && run.subAgent !== subAgent) throw new Error("Startup returned a different sub-agent than it owned");
      run.subAgent = subAgent;
      run.controller.signal.throwIfAborted();
      run.record.state = "running";
      await this.persist(run);
      this.changed();
      run.controller.signal.throwIfAborted();
      const result = await run.subAgent.prompt();
      run.record.usage = result.usage;
      run.record.toolErrors = result.toolErrors;
      run.controller.signal.throwIfAborted();
      run.record.reportPath = await this.io(signal => this.options.store.report(run.record.id, result.report, signal));
    } catch (error) {
      failed = errorText(error);
      run.record.error ??= failed;
    }
    // SDK abort must finish tools; collect evidence before dispose invalidates it.
    let unclean: string | undefined;
    try { await (run.aborting ??= run.subAgent?.abort() ?? Promise.resolve()); } catch (error) { unclean = errorText(error); }
    try {
      const evidence = run.subAgent?.evidence?.();
      if (evidence) { run.record.usage = evidence.usage; run.record.toolErrors = evidence.toolErrors; }
    } catch (error) {
      failed ??= `Cannot collect sub-agent evidence: ${errorText(error)}`;
      run.record.error ??= failed;
    }
    try { await run.subAgent?.dispose(); } catch (error) { unclean = errorText(error); }
    run.cleaned = !unclean;
    if (run.cleaned) run.subAgent = undefined; // Do not retain SDK transcripts through settled wrappers.
    if (unclean) this.poison(run, `Cleanup not confirmed: ${unclean}`);
    // A stop deadline may have published failure or uncertainty already. Never promote it later.
    if (run.record.state === "cleanup_unknown" || !isLive(run.record.state)) {
      clearTimeout(run.timer);
      if (run.finishing) await this.persist(run).catch(() => {}); // Late evidence, never late success.
      await this.finish(run);
      return;
    }
    run.record.state = run.controller.signal.aborted ? "cancelled"
      : failed ? "failed" : "completed";
    run.record.endedAt = new Date().toISOString();
    run.record.currentTool = undefined;
    run.record.question = undefined;
    run.question?.reject(new Error("Sub-agent settled"));
    run.question = undefined;
    clearTimeout(run.timer);
    await this.finish(run);
  }

  private async awaitStopped(run: Run): Promise<void> {
    // Abort as soon as the sub-agent exists. A start() that completes late must check
    // its signal; execute() also aborts/disposes it before ever prompting.
    const abort = Promise.resolve().then(() => run.aborting ??= run.subAgent?.abort() ?? Promise.resolve());
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([abort, run.work]),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Cleanup deadline exceeded")), this.options.cleanupMs ?? 5000); }),
      ]);
    } catch (error) {
      const reason = `${run.record.error ?? "Stop requested"}; ${errorText(error)}`;
      if (!isLive(run.record.state)) {
        // execute() already published a terminal state; do not rewrite it.
      } else if (run.cleaned) {
        run.record.state = "failed";
        run.record.error = `${reason}; result publication was not confirmed`;
        run.record.endedAt = new Date().toISOString();
      } else this.poison(run, `${reason}. Restart Pi before launching more work.`);
      clearTimeout(run.timer);
      for (const write of run.pendingWrites) write.abort(new Error(reason));
      this.changed();
      // Returning control is bounded even when evidence storage is unresponsive.
      void this.finish(run);
    } finally { clearTimeout(timer); }
  }

  private async ask(run: Run, message: string, signal?: AbortSignal): Promise<string> {
    run.controller.signal.throwIfAborted();
    signal?.throwIfAborted();
    if (run.question) throw new Error("Only one pending agent question per sub-agent is allowed");
    const question = { id: randomUUID(), message: text(message, "question", 8192) };
    let resolve!: (message: string) => void;
    let reject!: (error: Error) => void;
    const response = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
    // A cancellation can arrive while the notification is being persisted.
    void response.catch(() => {});
    run.question = { question, resolve, reject };
    run.record.question = question;
    run.record.state = "waiting_for_agent";
    const abort = () => reject(new Error("Agent wait cancelled"));
    run.controller.signal.addEventListener("abort", abort, { once: true });
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await this.persist(run);
      this.changed();
    } catch (error) {
      // A lost question is infrastructure failure, not permission to improvise.
      run.record.error = `Agent request failed: ${errorText(error)}`;
      run.controller.abort(new Error(run.record.error));
      throw error;
    }
    try {
      if (run.question?.question.id === question.id && !run.controller.signal.aborted) {
        await bounded(Promise.resolve(this.options.notify?.(this.snapshot(run), "question")), this.options.cleanupMs ?? 5000, "Notification submission deadline exceeded");
      }
    } catch (error) {
      if (run.question?.question.id !== question.id) {
        // reply() already accepted this question; do not abort an answered sub-agent over a failed notification.
        run.record.notificationError = errorText(error);
      } else {
        run.record.error = `Agent request failed: ${errorText(error)}`;
        run.controller.abort(new Error(run.record.error));
        throw error;
      }
    }
    try {
      return await response;
    } finally {
      run.controller.signal.removeEventListener("abort", abort);
      signal?.removeEventListener("abort", abort);
      if (run.question?.question.id === question.id) {
        run.question = undefined;
        run.record.question = undefined;
      }
    }
  }

  private finish(run: Run): Promise<void> {
    return run.finishing ??= this.publish(run);
  }
  private async publish(run: Run): Promise<void> {
    try { await this.persist(run); }
    catch (error) {
      if (run.record.state !== "cleanup_unknown") run.record.state = "failed";
      run.record.error = `${run.record.error ? run.record.error + "; " : ""}Result metadata could not be saved: ${errorText(error)}`;
      // Best effort diagnostic only; do not extend the control deadline for a retry.
      void this.persist(run).catch(() => {});
    }
    this.changed();
    if (!this.closed && !run.notified) {
      run.notified = true;
      try { await bounded(Promise.resolve(this.options.notify?.(this.snapshot(run), "finished")), this.options.cleanupMs ?? 5000, "Notification submission deadline exceeded"); }
      catch (error) {
        run.record.notificationError = errorText(error);
        void this.persist(run).catch(() => {});
        this.changed();
      }
    }
    // Small headers remain addressable until shutdown, bounded by maxRuns.
  }
}

async function bounded<T>(operation: Promise<T>, ms: number, message: string, controller?: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error(message);
          controller?.abort(error);
          reject(error);
        }, ms);
      }),
    ]);
  } finally { clearTimeout(timer); }
}
