import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { isLive, type RunRecord } from "./types.ts";

// Terminal control sequences, bidi controls, and line breaks are not UI content.
export function plain(value: string, max = 180): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e-\u200f\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, max);
}

/** Seconds until 60s, then minutes, then hours. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) {
    const seconds = total % 60;
    return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

export function mark(run: RunRecord): string {
  if (run.question) return "ask";
  if (run.notificationError) return "!";
  if (run.state === "starting") return "…";
  if (run.state === "cancelling" || run.state === "cleanup_unknown") return "stop";
  return "";
}

export function formatContext(run: RunRecord): string {
  const usage = run.contextUsage;
  const window = usage?.contextWindow;
  const validWindow = window != null && Number.isFinite(window) && window > 0;
  const tokens = usage?.tokens, percent = usage?.percent;
  const known = validWindow && tokens != null && Number.isFinite(tokens) && tokens >= 0
    && percent != null && Number.isFinite(percent) && percent >= 0;
  const compact = (value: number) => value >= 1_000_000 ? `${Number((value / 1_000_000).toFixed(1))}M`
    : value >= 1000 ? `${Number((value / 1000).toFixed(1))}K` : String(value);
  // Do not round a small overflow back down to an apparently safe 100%.
  const percentage = known ? percent > 100 ? Math.max(100.1, Number(percent.toFixed(1))) : Math.round(percent) : "?";
  return `${percentage}%/${validWindow ? compact(window) : "?"}`;
}

function sessionPrefix(run: RunRecord, peers: RunRecord[], minimum: number): string {
  const id = plain(run.sessionId ?? "", 128);
  if (!id) return "starting";
  let length = Math.min(minimum, id.length);
  while (length < id.length && peers.some(peer => peer.id !== run.id && peer.sessionId
    && plain(peer.sessionId, 128).startsWith(id.slice(0, length)))) length++;
  return id.slice(0, length) + (length < id.length ? "…" : "");
}

/** Paint only value snapshots, adapting optional decoration before context fields. */
export function rowText(run: RunRecord, width = Infinity, peers: RunRecord[] = []): string {
  const agent = plain(run.agent, 32);
  const pid = run.pid !== undefined && Number.isSafeInteger(run.pid) && run.pid > 0 ? `PID-${run.pid}` : "PID-?";
  const context = formatContext(run);
  const extra = mark(run);
  // 'starting' already conveys unknown native identity; do not repeat an ellipsis flag.
  const flag = extra && !(extra === "…" && !run.sessionId) ? ` ${extra}` : "";
  const full = `${agent} · ${pid} ${sessionPrefix(run, peers, 8)} · ${context}${flag}`;
  if (visibleWidth(full) <= width) return full;
  const identity = `${pid} ${sessionPrefix(run, peers, 4)}`;
  const tail = ` · ${identity} · ${context}${flag}`;
  const room = width - visibleWidth(tail);
  if (room > 0) return truncateToWidth(agent, room, "…") + tail;
  for (const line of [`${identity} ${context}${flag}`, `${pid} ${context}${flag}`, `${context}${flag}`]) {
    if (visibleWidth(line) <= width) return line;
  }
  return truncateToWidth(`${context}${flag}`, Math.max(1, width), "");
}

export function rows(runs: RunRecord[]): string[] {
  const live = runs.filter(run => isLive(run.state));
  if (!live.length) return [];
  const body = live.map(run => rowText(run, Infinity, live));
  return live.length === 1 ? [`↓  ${body[0]}`] : [`↓  ${live.length}`, ...body];
}

export function nextLive(runs: RunRecord[], id: string): string | undefined {
  const live = runs.filter(run => isLive(run.state));
  const index = live.findIndex(run => run.id === id);
  if (index < 0) return live[0]?.id;
  return live[index + 1]?.id;
}

export interface WidgetSlot { instance?: SubagentWidget }

/** Mount once; later ticks update in place so the line does not remount and flicker. */
export function syncWidget(
  ctx: ExtensionContext, runs: RunRecord[], blocked: boolean,
  onOpen: (id: string) => void, slot: WidgetSlot,
): void {
  if (ctx.mode !== "tui") return;
  // rows()/render() paint live runs only; a settled-only list must unmount.
  const show = runs.some(run => isLive(run.state)) || blocked;
  if (!show) {
    if (slot.instance) {
      ctx.ui.setWidget("minimal-subagents", undefined);
      slot.instance = undefined;
    }
    return;
  }
  if (slot.instance) { slot.instance.update(runs, blocked, onOpen); return; }
  ctx.ui.setWidget("minimal-subagents", (tui, theme) => {
    slot.instance = new SubagentWidget(tui, theme, onOpen);
    slot.instance.update(runs, blocked, onOpen);
    return slot.instance;
  }, { placement: "belowEditor" });
}

export class SubagentWidget implements Component {
  private runs: RunRecord[] = [];
  private blocked = false;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private onOpen: (id: string) => void;
  constructor(tui: TUI, theme: Theme, onOpen: (id: string) => void) {
    this.tui = tui;
    this.theme = theme;
    this.onOpen = onOpen;
  }
  update(runs: RunRecord[], blocked: boolean, onOpen?: (id: string) => void): void {
    this.runs = runs;
    this.blocked = blocked;
    if (onOpen) this.onOpen = onOpen; // Later ticks must not leave clicks on a stale callback.
    this.tui.requestRender();
  }
  invalidate(): void { /* Rendered from live state. */ }
  render(width: number): string[] {
    const inner = Math.max(1, width);
    const th = this.theme;
    const live = this.runs.filter(run => isLive(run.state));
    const lines: string[] = [];
    if (live.length !== 1) {
      const head = this.blocked && !live.length ? "cleanup unknown" : `↓  ${live.length || ""}`.trimEnd();
      lines.push(th.fg(this.blocked ? "error" : "accent", truncateToWidth(plain(head), inner)));
    }
    for (const run of live) {
      const decoration = live.length === 1 ? "↓  " : "   ";
      const prefix = visibleWidth(decoration + rowText(run, Infinity, live)) <= inner ? decoration : "";
      const line = prefix + rowText(run, inner - visibleWidth(prefix), live);
      const extra = mark(run);
      lines.push(th.fg(extra === "ask" ? "warning" : extra === "stop" || extra === "!" ? "error" : "accent", line));
    }
    if (this.blocked && live.length) lines.push(th.fg("error", truncateToWidth("cleanup unknown — launches blocked", inner)));
    return lines;
  }
  handleMouse(event: TuiMouseEvent) {
    if (event.type !== "click" || event.button !== "left") return;
    const live = this.runs.filter(run => isLive(run.state));
    if (!live.length) return;
    const firstRow = live.length === 1 ? 0 : 1; // Multi-run lists paint a count header first.
    const row = event.y - firstRow;
    if (row < 0 || row >= live.length) return; // Header/footer chrome is not a run.
    this.onOpen(live[row]!.id);
    return { handled: true as const };
  }
}
