import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, truncateToWidth, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { errorText, isLive, type RunRecord } from "./types.ts";
import { formatElapsed, nextLive, plain } from "./ui.ts";
import { readTranscript } from "./transcript.ts";

export type HumanCommand =
  | { action: "list" }
  | { action: "attach"; id: string }
  | { action: "stop"; id: string }
  | { action: "steer"; id: string; message: string }
  | { action: "reply"; id: string; message: string };

export function parseCommand(args: string): HumanCommand {
  const trimmed = args.trim();
  if (!trimmed) return { action: "list" };
  const words = trimmed.split(/\s+/);
  const head = words[0]!;
  if (head === "stop") {
    if (words.length !== 2) throw new Error("Usage: /subagents stop <id>");
    return { action: "stop", id: words[1]! };
  }
  if (head === "steer" || head === "reply") {
    const rest = trimmed.slice(head.length).trimStart();
    const split = rest.search(/\s/);
    if (split < 1 || !rest.slice(split).trim()) throw new Error(`Usage: /subagents ${head} <id> <text>`);
    return { action: head, id: rest.slice(0, split), message: rest.slice(split).trim() };
  }
  if (words.length === 1 && /^[a-f0-9-]{8,36}$/i.test(head)) return { action: "attach", id: head };
  throw new Error("Usage: /subagents [id | stop <id> | steer <id> <text> | reply <id> <text>]");
}

export function resolveRun(runs: RunRecord[], ref: string): RunRecord {
  const exact = runs.find(run => run.id === ref);
  if (exact) return exact;
  const matches = runs.filter(run => run.id.startsWith(ref));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new Error("Ambiguous run prefix; use more of the id");
  throw new Error("Unknown run ID for this agent runtime");
}

export interface InspectActions {
  status(id: string): RunRecord;
  preview(id: string): string[];
  steer(id: string, message: string): Promise<string>;
  reply(id: string, requestId: string, message: string): Promise<void>;
  stop(id: string): Promise<void>;
  subscribe(listener: () => void): () => void;
  live(): RunRecord[];
}

export async function attach(ctx: ExtensionContext, id: string, actions: InspectActions): Promise<void> {
  actions.status(id);
  await ctx.ui.custom((tui, theme, _keys, done) => new InspectView(tui, theme, id, actions, done), {
    overlay: true,
    overlayOptions: { anchor: "center", width: "92%", maxHeight: "80%", margin: 1 },
  });
}

export class InspectView implements Component, Focusable {
  focused = true;
  private readonly input = new Input({ prompt: "> ", placeholder: "message the sub-agent…" });
  private readonly tui: TUI;
  private readonly theme: Theme;
  private id: string;
  private readonly actions: InspectActions;
  private readonly done: (value?: void) => void;
  private readonly unsubscribe: () => void;
  private note = "↓ next or agent · esc agent · enter send · ctrl-x stop";
  private closed = false;
  private transcript = ["(no transcript yet)"];
  private loadedPath?: string;
  private previewVersion = 0;
  constructor(tui: TUI, theme: Theme, id: string, actions: InspectActions, done: (value?: void) => void) {
    this.tui = tui;
    this.theme = theme;
    this.id = id;
    this.actions = actions;
    this.done = done;
    this.input.onSubmit = value => { void this.send(value); };
    this.input.onEscape = () => this.close();
    this.unsubscribe = actions.subscribe(() => this.refresh());
    this.refresh();
  }
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    this.done(); // Host teardown must settle the attach() promise, not just close().
  }
  handleInput(data: string): void {
    if (this.closed) return;
    if (matchesKey(data, "ctrl+x")) { void this.halt(); return; }
    if (matchesKey(data, "ctrl+c")) { this.close(); return; }
    if (matchesKey(data, "down") && !this.input.getValue().trim()) {
      const next = nextLive(this.actions.live(), this.id);
      if (!next) { this.close(); return; }
      this.id = next;
      this.loadedPath = undefined;
      this.previewVersion++;
      this.transcript = ["(no transcript yet)"];
      this.refresh();
      return;
    }
    this.input.focused = this.focused;
    this.input.handleInput(data);
    this.tui.requestRender();
  }
  invalidate(): void { this.input.invalidate(); }
  render(width: number): string[] {
    const th = this.theme;
    const record = this.safeStatus();
    const inner = Math.max(1, width);
    const height = Math.max(1, Math.floor(this.tui.terminal.rows * 0.8));
    const title = record
      ? `${record.id.slice(0, 8)} · ${record.agent} · ${record.state} · ${formatElapsed(record.elapsedMs)}`
      : `${this.id.slice(0, 8)} · unavailable`;
    const lines = [
      th.fg("accent", truncateToWidth(` ${plain(title, 512)}`, inner)),
      th.fg("dim", truncateToWidth(` ${plain(record?.cwd ?? "", 4096)}`, inner)),
    ];
    if (record?.question) {
      lines.push(th.fg("warning", truncateToWidth(` ask  ${plain(record.question.message, 8192)}`, inner)));
    }
    if (record?.error) lines.push(th.fg("error", truncateToWidth(` ${plain(record.error)}`, inner)));
    lines.push(th.fg("dim", "─".repeat(Math.min(inner, 80))));
    this.input.focused = this.focused;
    const footer = [th.fg("dim", "─".repeat(Math.min(inner, 80))), th.fg("dim", truncateToWidth(` ${this.note}`, inner)), ...this.input.render(inner)];
    const header = lines.slice(0, Math.max(0, height - footer.length));
    const available = Math.max(0, height - header.length - footer.length);
    const body = available ? this.transcript.slice(-available).map(line => truncateToWidth(` ${plain(line, 512)}`, inner)) : [];
    return [...header, ...body, ...footer].slice(-height).map(line => truncateToWidth(line, inner));
  }
  private refresh(): void {
    if (this.closed) return;
    let preview: string[];
    try { preview = this.actions.preview(this.id); } catch { preview = []; }
    if (preview.length) {
      this.transcript = preview;
      this.previewVersion++;
    } else {
      const path = this.safeStatus()?.sessionPath;
      if (path && path !== this.loadedPath) {
        const version = this.previewVersion;
        void readTranscript(path).then(lines => {
          if (this.closed || this.loadedPath === path || this.previewVersion !== version) return;
          this.loadedPath = path; // Commit only on success so a later tick can retry a failure.
          this.transcript = lines;
          this.tui.requestRender();
        }).catch(error => {
          if (this.closed || this.previewVersion !== version) return;
          this.note = plain(errorText(error));
          this.tui.requestRender();
        });
      }
    }
    this.tui.requestRender();
  }
  private safeStatus(): RunRecord | undefined {
    try { return this.actions.status(this.id); }
    catch { return undefined; }
  }
  private inflight = false;
  private async send(value: string): Promise<void> {
    const message = value.trim();
    this.input.setValue("");
    if (!message || this.closed || this.inflight) return;
    const id = this.id; // Pin the target; down-arrow can switch runs at any await.
    this.inflight = true;
    try {
      const record = this.actions.status(id);
      if (record.state === "waiting_for_agent" && record.question) {
        await this.actions.reply(id, record.question.id, message);
        if (this.closed || this.id !== id) return;
        this.note = "replied";
      } else if (record.state === "running") {
        await this.actions.steer(id, message);
        if (this.closed || this.id !== id) return;
        this.note = "steered — delivery is not compliance";
      } else if (this.id === id) {
        this.note = isLive(record.state) ? `cannot message while ${record.state}` : "settled — inspect only";
      }
    } catch (error) {
      if (this.closed || this.id !== id) return;
      this.note = plain(errorText(error));
    } finally { this.inflight = false; }
    if (!this.closed) this.tui.requestRender();
  }
  private async halt(): Promise<void> {
    if (this.closed || this.inflight) return;
    const id = this.id;
    this.inflight = true;
    try {
      await this.actions.stop(id);
      if (this.closed || this.id !== id) return;
      this.note = "stop requested";
    } catch (error) {
      if (this.closed || this.id !== id) return;
      this.note = plain(errorText(error));
    } finally { this.inflight = false; }
    if (!this.closed) this.tui.requestRender();
  }
  private close(): void {
    this.dispose();
  }
}
