import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
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

export function rowText(run: RunRecord): string {
  const bits = [run.id.slice(0, 8), run.agent, formatElapsed(run.elapsedMs)];
  const extra = mark(run);
  if (extra) bits.push(extra);
  return plain(bits.join("  "));
}

export function rows(runs: RunRecord[]): string[] {
  const live = runs.filter(run => isLive(run.state));
  if (!live.length) return [];
  const body = live.map(rowText);
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
      const prefix = live.length === 1 ? "↓  " : "   ";
      const extra = mark(run);
      const id = th.fg("dim", run.id.slice(0, 8));
      const agent = th.fg("accent", plain(run.agent, 32));
      const time = th.fg("dim", formatElapsed(run.elapsedMs));
      const flagColor = extra === "ask" ? "warning" : "error";
      const flag = extra ? th.fg(flagColor, extra) : "";
      const line = [prefix + id, agent, time, flag].filter(Boolean).join("  ");
      lines.push(truncateToWidth(line, inner));
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
