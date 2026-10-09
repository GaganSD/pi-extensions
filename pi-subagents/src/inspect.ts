import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Editor, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type Focusable, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { errorText, isLive, type RunRecord } from "./types.ts";
import { formatContext, formatElapsed, plain, type NavigationHost } from "./ui.ts";
import { HumanState, stateLabel } from "./presentation.ts";
import { conversationText, readConversation, type ConversationMessage } from "./conversation.ts";

export type HumanCommand = { action: "list" } | { action: "attach"; id: string } | { action: "stop"; id: string }
  | { action: "steer"; id: string; message: string } | { action: "reply"; id: string; message: string };
export function parseCommand(args: string): HumanCommand {
  const trimmed = args.trim();
  if (!trimmed) return { action: "list" };
  const words = trimmed.split(/\s+/), head = words[0]!;
  if (head === "stop") {
    if (words.length !== 2) throw new Error("Usage: /subagents stop <id>");
    return { action: "stop", id: words[1]! };
  }
  if (head === "steer" || head === "reply") {
    const rest = trimmed.slice(head.length).trimStart(), split = rest.search(/\s/);
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

export async function attach(ctx: ExtensionContext, id: string, actions: InspectActions, state = new HumanState(), navigation?: NavigationHost, onView?: (close: () => void) => void): Promise<void> {
  actions.status(id);
  if (navigation?.mount) {
    let mounted = false;
    await new Promise<void>((resolve, reject) => {
      // Obtain the host's active TUI without occupying/changing the main editor.
      ctx.ui.setWidget("minimal-subagents:thread-host", (tui, theme) => {
        let release: (() => void) | undefined;
        const view = new InspectView(tui, theme, id, actions, () => { release?.(); if (mounted) resolve(); }, state);
        onView?.(() => view.dispose());
        try { release = navigation.mount!(view); } catch (error) { view.dispose(); reject(error); }
        if (!release) { view.dispose(); reject(new Error("Conversation workspace unavailable; keep the existing layout untouched")); }
        else mounted = true;
        return { render: () => [], invalidate() {}, dispose() { if (mounted) view.dispose(); } };
      }, { placement: "belowEditor" });
    }).finally(() => ctx.ui.setWidget("minimal-subagents:thread-host", undefined));
    return;
  }
  // Plain Pi fallback: opaque entire viewport. Never pretend it preserves a sidebar.
  await ctx.ui.custom((tui, theme, _keys, done) => {
    const view = new InspectView(tui, theme, id, actions, done, state);
    onView?.(() => view.dispose());
    return view;
  }, {
    overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 },
  });
}

export class InspectView implements Component, Focusable {
  focused = true;
  private readonly input: Editor;
  private readonly unsubscribe: () => void;
  private readonly draft;
  private zone: "message" | "transcript" | "actions";
  private action = 0;
  private readonly buttons = ["Back", "Details", "Tools", "Older", "Latest", "Stop"];
  private note = "Esc back · Tab focus · Enter send · Shift+Enter newline";
  private closed = false;
  private details = false;
  private confirmStop = false;
  private stopping = false;
  private inflight = false;
  private messages: ConversationMessage[] = [];
  private preview: string[] = [];
  private before?: number;
  private omitted = false;
  private history = false;
  private reading = false;
  private reread = false;
  private lastWidth = 80;
  private detailsScroll = 0;
  private bodyHeight = 1;
  private lastInputStart = 0;
  private inputCrop = 0;
  private contentRevision = 0;
  private bodyCache?: { key: string; width: number; lines: string[] };
  private lastActionsRow = 0;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly id: string;
  private readonly actions: InspectActions;
  private readonly done: (value?: void) => void;
  private readonly state: HumanState;
  constructor(tui: TUI, theme: Theme, id: string,
    actions: InspectActions, done: (value?: void) => void, state = new HumanState()) {
    this.tui = tui; this.theme = theme; this.id = id;
    this.actions = actions; this.done = done; this.state = state;
    const record = actions.status(id);
    this.state.open = id;
    this.draft = state.draft(record);
    this.history = this.draft.pageEnd !== undefined;
    this.before = this.draft.pageEnd;
    this.zone = isLive(record.state) ? "message" : "transcript";
    const accent = (text: string) => theme.fg("accent", text), dim = (text: string) => theme.fg("dim", text);
    this.input = new Editor(tui, { borderColor: dim, selectList: { selectedPrefix: accent, selectedText: accent, description: dim, scrollInfo: dim, noMatch: dim } }, { paddingX: 0 });
    this.input.setText(this.draft.text);
    this.input.onChange = () => {
      const next = this.input.getExpandedText();
      if (!this.draft.text || !next) this.draft.questionId = this.safeStatus()?.question?.id;
      this.draft.text = next;
      tui.requestRender();
    };
    this.unsubscribe = actions.subscribe(() => this.refresh());
    this.refresh();
  }
  dispose(): void {
    if (this.closed) return;
    this.closed = true; this.unsubscribe();
    this.state.open = undefined;
    this.done();
  }
  invalidate(): void { this.input.invalidate(); }
  handleInput(data: string): void {
    if (this.closed) return;
    if (this.confirmStop) {
      if (matchesKey(data, "escape")) { this.confirmStop = false; this.note = "Stop cancelled"; }
      else if (matchesKey(data, "enter")) { this.confirmStop = false; void this.halt(); }
      this.tui.requestRender(); return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { this.dispose(); return; }
    if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
      const zones = ["message", "transcript", "actions"] as const;
      const next = zones.indexOf(this.zone) + (matchesKey(data, "shift+tab") ? -1 : 1);
      this.zone = zones[(next + zones.length) % zones.length]!;
      this.tui.requestRender(); return;
    }
    if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
      this.scroll(matchesKey(data, "pageUp") ? this.bodyHeight : -this.bodyHeight); return;
    }
    if (this.zone === "actions") {
      if (matchesKey(data, "left") || matchesKey(data, "right")) this.action = Math.max(0, Math.min(this.buttons.length - 1, this.action + (matchesKey(data, "right") ? 1 : -1)));
      else if (matchesKey(data, "enter") || data === " ") this.activate(this.action);
      this.tui.requestRender(); return;
    }
    if (this.zone === "transcript") {
      if (matchesKey(data, "up") || matchesKey(data, "down")) this.scroll(matchesKey(data, "up") ? 1 : -1);
      return;
    }
    if (matchesKey(data, "enter")) { void this.send(this.input.getExpandedText()); return; }
    this.input.focused = this.focused;
    this.input.handleInput(data); // Space/arrows and Ctrl-X are ordinary editing, never switching/Stop.
    this.tui.requestRender();
  }
  render(width: number): string[] {
    this.lastWidth = Math.max(1, width);
    const inner = this.lastWidth, height = Math.max(1, this.tui.terminal.rows), record = this.safeStatus();
    const header = [this.theme.fg("accent", truncateToWidth(`Agent › ${record ? this.state.title(record) : "Unavailable worker"}`, inner)),
      this.theme.fg("dim", truncateToWidth(record ? `${stateLabel(record)} · ${plain(record.model.split("/").slice(1).join("/"))} · ${record.thinking} · ${formatElapsed(record.elapsedMs)}` : "Run unavailable", inner))];
    this.input.focused = this.focused && this.zone === "message" && !this.details;
    const editor = this.fitEditor(inner, Math.max(1, Math.min(5, height - 5)));
    const footer = [this.theme.fg("dim", truncateToWidth(this.note, inner)),
      this.theme.fg("accent", truncateToWidth(this.buttons.map((label, i) => `${this.zone === "actions" && this.action === i ? CURSOR_MARKER + "›" : ""}[${label}]`).join(" "), inner)),
      ...(this.details ? [] : [this.theme.fg("dim", truncateToWidth(record?.question ? "Reply to this question" : record && !isLive(record.state) ? "Settled · sending disabled · draft retained" : "Message the sub-agent", inner)), ...editor])];
    const content = this.body(inner, record);
    const keptFooter = footer.slice(-Math.max(1, height - 1));
    const keptHeader = header.slice(0, Math.max(0, height - keptFooter.length - 1));
    this.bodyHeight = Math.max(0, height - keptHeader.length - keptFooter.length);
    const offset = this.details ? this.detailsScroll : this.draft.scroll;
    const maxOffset = Math.max(0, content.length - this.bodyHeight), clamped = Math.min(offset, maxOffset);
    const from = Math.max(0, content.length - this.bodyHeight - clamped);
    const body = content.slice(from, from + this.bodyHeight);
    while (body.length < this.bodyHeight) body.push("");
    if (this.zone === "transcript" && this.focused && body.length) body[0] = CURSOR_MARKER + body[0];
    this.lastActionsRow = height - keptFooter.length + Math.max(0, keptFooter.indexOf(footer[1]!));
    this.lastInputStart = height - editor.length;
    // Every viewport row is painted: no parent transcript can show through.
    return [...keptHeader, ...body, ...keptFooter].slice(-height).map(line => truncateToWidth(line, inner));
  }
  handleMouse(event: TuiMouseEvent) {
    if (event.type === "wheel") { this.scroll(-(event.wheelDelta ?? 0)); return { handled: true, focus: true }; }
    if (event.type !== "click" || event.button !== "left") return;
    if (event.y >= this.lastInputStart && !this.details) {
      this.zone = "message"; this.input.handleMouse({ ...event, y: event.y - this.lastInputStart + this.inputCrop });
    } else if (event.y === this.lastActionsRow) {
      let column = 0;
      for (let i = 0; i < this.buttons.length; i++) {
        const length = this.buttons[i]!.length + 3 + (this.zone === "actions" && this.action === i ? 1 : 0);
        if (event.x >= column && event.x < column + length) { this.zone = "actions"; this.action = i; this.activate(i); break; }
        column += length;
      }
    } else this.zone = "transcript";
    this.tui.requestRender(); return { handled: true, focus: true };
  }
  private body(width: number, record?: RunRecord): string[] {
    const key = `${this.contentRevision}:${this.details}:${this.draft.expanded}:${this.history}:${record?.question?.id}:${record?.error}`;
    if (!this.details && this.bodyCache?.key === key && this.bodyCache.width === width) return this.bodyCache.lines;
    if (this.details && record) return wrapTextWithAnsi(conversationText([
      `Run ID: ${record.id}`, `Native session ID: ${record.sessionId ?? "starting"}`, `Shared process PID: ${record.pid ?? "unknown"}`,
      `Workspace: ${record.cwd}`, `Model: ${record.model} · ${record.thinking}`, `Context estimate: ${formatContext(record)}`,
      `Usage: ${JSON.stringify(record.usage ?? "unknown")}`, `Metadata: ${record.metadataPath}`, `Transcript: ${record.sessionPath ?? "not ready"}`,
      `Report: ${record.reportPath ?? "not saved"}`, `Delivery warning: ${record.notificationError ?? "none"}`,
    ].join("\n")), width);
    const lines: string[] = [];
    if (this.history) lines.push(this.theme.fg("dim", "Earlier conversation page · Latest returns to live messages"));
    if (this.omitted) lines.push(this.theme.fg("dim", "Earlier/oversized/incomplete content omitted · Older loads a bounded page · Details has the original"));
    if (this.messages.length) for (const message of this.messages) {
      lines.push(this.theme.fg("accent", message.label));
      const text = wrapTextWithAnsi(message.text, width);
      lines.push(...(message.tool && !this.draft.expanded ? [...text.slice(0, 3), ...(text.length > 3 ? [this.theme.fg("dim", "… Tools expands output")] : [])] : text), "");
    }
    else if (this.history) lines.push("No finalized messages in this page · Details has the original");
    else lines.push(...this.preview.flatMap(line => wrapTextWithAnsi(conversationText(line), width)));
    if (record?.error) lines.push(...wrapTextWithAnsi(conversationText(record.error), width), "");
    if (record?.question) lines.push(this.theme.fg("warning", "Question"), ...wrapTextWithAnsi(conversationText(record.question.message, 8192), width), "");
    const body = lines.length ? lines : ["Waiting for finalized conversation messages…"];
    this.bodyCache = { key, width, lines: body };
    return body;
  }
  private fitEditor(width: number, limit: number): string[] {
    const lines = this.input.render(width);
    this.inputCrop = 0;
    if (lines.length <= limit) return lines;
    const cursor = lines.findIndex(line => line.includes(CURSOR_MARKER));
    const from = Math.max(0, Math.min(lines.length - limit, cursor < 0 ? lines.length - limit : cursor - limit + 1));
    this.inputCrop = from;
    return lines.slice(from, from + limit);
  }
  private refresh(): void {
    if (this.closed) return;
    const record = this.safeStatus();
    if (record) this.state.markRead(record);
    try { this.preview = this.actions.preview(this.id); } catch { this.preview = []; }
    this.contentRevision++;
    if (!this.draft.text) this.draft.questionId = record?.question?.id;
    if (record?.sessionPath && (!this.history || !this.messages.length)) {
      if (this.reading) { if (!this.history) this.reread = true; }
      else void this.read(record.sessionPath, this.history);
    }
    this.tui.requestRender();
  }
  private async read(path: string, older = false): Promise<void> {
    if (this.reading || this.closed) return;
    this.reading = true;
    try {
      const page = await readConversation(path, older ? this.before : undefined);
      if (this.closed || this.history !== older) return;
      const previousHeight = this.body(this.lastWidth, this.safeStatus()).length;
      const hadMessages = this.messages.length > 0;
      this.messages = page.messages;
      this.before = page.before;
      this.omitted = page.omitted;
      this.contentRevision++;
      if (this.draft.scroll > 0 && !older && hadMessages) this.draft.scroll += Math.max(0, this.body(this.lastWidth, this.safeStatus()).length - previousHeight);
      this.tui.requestRender();
    } catch (error) { if (!this.closed) { this.note = plain(errorText(error)); this.tui.requestRender(); } }
    finally {
      this.reading = false;
      if (this.reread && !this.closed) { this.reread = false; void this.read(path, this.history); }
    }
  }
  private scroll(delta: number): void {
    const max = Math.max(0, this.body(this.lastWidth, this.safeStatus()).length - this.bodyHeight);
    if (this.details) this.detailsScroll = Math.max(0, Math.min(max, this.detailsScroll + delta));
    else this.draft.scroll = Math.max(0, Math.min(max, this.draft.scroll + delta));
    this.tui.requestRender();
  }
  private activate(index: number): void {
    if (index === 0) this.dispose();
    else if (index === 1) { this.details = !this.details; this.detailsScroll = 0; }
    else if (index === 2) this.draft.expanded = !this.draft.expanded;
    else if (index === 3) {
      const path = this.safeStatus()?.sessionPath;
      if (this.reading) this.note = "Loading conversation · try Older again when ready";
      else if (this.before !== undefined && path) {
        this.history = true; this.draft.pageEnd = this.before; this.draft.scroll = 0;
        void this.read(path, true);
      } else this.note = "No earlier page available";
    } else if (index === 4) {
      this.history = false; this.draft.pageEnd = undefined; this.draft.scroll = 0; this.before = undefined;
      const path = this.safeStatus()?.sessionPath;
      if (path) { if (this.reading) this.reread = true; else void this.read(path); }
    } else if (index === 5) {
      if (!this.safeStatus() || !isLive(this.safeStatus()!.state)) this.note = "Already settled";
      else { this.confirmStop = true; this.note = "Stop this worker? Enter confirms · Esc cancels"; }
    }
    this.tui.requestRender();
  }
  private safeStatus(): RunRecord | undefined { try { return this.actions.status(this.id); } catch { return undefined; } }
  private async send(value: string): Promise<void> {
    const message = value.trim();
    if (!message || this.closed) return;
    if (this.inflight) { this.note = "Sending previous message · draft kept"; this.tui.requestRender(); return; }
    const record = this.safeStatus();
    if (!record || !isLive(record.state) || !["running", "waiting_for_agent"].includes(record.state)) {
      this.note = "Cannot send in this state · draft kept"; this.tui.requestRender(); return;
    }
    if (this.draft.questionId !== record.question?.id) {
      this.note = "Question changed or resolved · draft kept; clear it to target the current conversation";
      this.tui.requestRender(); return;
    }
    this.inflight = true;
    try {
      if (record.question) await this.actions.reply(this.id, record.question.id, message);
      else await this.actions.steer(this.id, message);
      if (this.draft.text === value) {
        this.draft.text = ""; this.draft.questionId = this.safeStatus()?.question?.id;
        if (!this.closed) this.input.setText("");
      }
      this.note = record.question ? "Reply delivered" : "Message queued · delivery is not compliance";
    } catch (error) { this.note = `${plain(errorText(error))} · draft kept`; }
    finally { this.inflight = false; if (!this.closed) this.tui.requestRender(); }
  }
  private async halt(): Promise<void> {
    if (this.closed || this.stopping) return;
    this.stopping = true;
    try { await this.actions.stop(this.id); this.note = "Stop requested"; }
    catch (error) { this.note = plain(errorText(error)); }
    finally { this.stopping = false; if (!this.closed) this.tui.requestRender(); }
  }
}
