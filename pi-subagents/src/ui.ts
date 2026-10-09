import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { isLive, type RunRecord } from "./types.ts";
import { HumanState, safeText, stateLabel, taskTitle } from "./presentation.ts";
export const plain = safeText;

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return total % 60 ? `${minutes}m ${total % 60}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}
export function mark(run: RunRecord): string {
  if (run.question) return "ask";
  if (run.notificationError) return "!";
  if (run.state === "starting") return "…";
  if (run.state === "cancelling" || run.state === "cleanup_unknown") return "stop";
  return "";
}
export function formatContext(run: RunRecord): string {
  const usage = run.contextUsage, window = usage?.contextWindow;
  const validWindow = window != null && Number.isFinite(window) && window > 0;
  const tokens = usage?.tokens, percent = usage?.percent;
  const known = validWindow && tokens != null && Number.isFinite(tokens) && tokens >= 0 && percent != null && Number.isFinite(percent) && percent >= 0;
  const compact = (value: number) => value >= 1_000_000 ? `${Number((value / 1_000_000).toFixed(1))}M` : value >= 1000 ? `${Number((value / 1000).toFixed(1))}K` : String(value);
  const percentage = known ? percent > 100 ? Math.max(100.1, Number(percent.toFixed(1))) : Math.round(percent) : "?";
  return `${percentage}%/${validWindow ? compact(window) : "?"}`;
}
export function rowText(run: RunRecord, width = Infinity, peers: RunRecord[] = [], state = new HumanState()): string {
  state.remember(peers);
  const name = state.name(run), status = stateLabel(run);
  const suffix = ` · ${status}`;
  const title = `${name} · ${taskTitle(run.task)}`;
  const limit = Number.isFinite(width) ? Math.max(1, width) : visibleWidth(title + suffix);
  if (limit < visibleWidth(name + suffix)) return truncateToWidth(`${name} · ${status}`, limit);
  return truncateToWidth(title, Math.max(1, limit - visibleWidth(suffix))) + suffix;
}
export function rows(runs: RunRecord[]): string[] {
  const state = new HumanState();
  return runs.length ? ["Sub-agents", ...state.visible(runs).map(run => rowText(run, Infinity, runs, state))] : [];
}
export function nextLive(runs: RunRecord[], id: string): string | undefined {
  const live = runs.filter(run => isLive(run.state));
  const index = live.findIndex(run => run.id === id);
  return index < 0 ? live[0]?.id : live[index + 1]?.id;
}
export interface NavigationHost {
  version: 1;
  isActive?(): boolean;
  canFocusRoster?(): boolean;
  focusEditor(data?: string): void;
  bindDown(handler: () => void): () => void;
  mount?(view: Component & { dispose?(): void }): (() => void) | undefined;
}
export interface WidgetSlot { instance?: SubagentWidget; state?: HumanState; navigation?: NavigationHost }
export function syncWidget(ctx: ExtensionContext, runs: RunRecord[], blocked: boolean, onOpen: (id: string) => void, slot: WidgetSlot): void {
  if (ctx.mode !== "tui") return;
  slot.state ??= new HumanState();
  slot.state.remember(runs);
  if (!runs.length && !blocked) {
    if (slot.instance) { ctx.ui.setWidget("minimal-subagents", undefined); slot.instance = undefined; }
    return;
  }
  const restore = (data?: string) => {
    if (slot.navigation && slot.navigation.isActive?.() !== false) slot.navigation.focusEditor(data);
    else slot.instance?.restoreOrigin(data);
  };
  if (slot.instance) { slot.instance.update(runs, blocked, onOpen); return; }
  ctx.ui.setWidget("minimal-subagents", (tui, theme) => {
    slot.instance = new SubagentWidget(tui, theme, onOpen, slot.state, restore, Boolean(slot.navigation) || typeof (tui as TUI & { getFocusedComponent?: unknown }).getFocusedComponent === "function");
    slot.instance.update(runs, blocked, onOpen);
    return slot.instance;
  }, { placement: "belowEditor" });
}

/** Real focusable rows: navigation never activates a conversation. */
export class SubagentWidget implements Component, Focusable {
  private hasFocus = false;
  get focused(): boolean { return this.hasFocus; }
  set focused(value: boolean) { this.hasFocus = value; this.state.selected = value ? this.selectedId : undefined; }
  private runs: RunRecord[] = [];
  private blocked = false;
  private selectedId?: string;
  private recentOpen = false;
  private mouseRows: Array<string | "recent"> = [];
  private readonly tui: TUI;
  private readonly theme: Theme;
  private onOpen: (id: string) => void;
  readonly state: HumanState;
  private readonly restoreEditor?: (data?: string) => void;
  private origin?: Component;
  private readonly canFocus: boolean;
  constructor(tui: TUI, theme: Theme, onOpen: (id: string) => void,
    state = new HumanState(), restoreEditor?: (data?: string) => void, canFocus = true) {
    this.tui = tui; this.theme = theme; this.onOpen = onOpen;
    this.state = state; this.restoreEditor = restoreEditor; this.canFocus = canFocus;
  }
  update(runs: RunRecord[], blocked: boolean, onOpen?: (id: string) => void): void {
    this.runs = runs; this.blocked = blocked; this.state.remember(runs);
    if (onOpen) this.onOpen = onOpen;
    this.tui.requestRender();
  }
  focusRoster(id?: string): void {
    const previous = (this.tui as TUI & { getFocusedComponent?(): Component | null }).getFocusedComponent?.();
    if (previous && previous !== this) this.origin = previous;
    const entries = this.entries();
    this.selectedId = id ?? this.selectedId ?? entries[0];
    if (!this.selectedId || !entries.includes(this.selectedId)) this.selectedId = entries[0];
    if (!this.selectedId) { this.leave(); return; }
    if (!this.canFocus) return;
    this.focused = true; this.tui.setFocus(this); this.tui.requestRender();
  }
  restoreOrigin(data?: string): void { if (this.origin) this.focusMain(this.origin, data); }
  focusMain(editor: Component, data?: string): void {
    this.focused = false; this.tui.setFocus(editor);
    if (data) editor.handleInput?.(data);
    this.tui.requestRender();
  }
  invalidate(): void {}
  handleInput(data: string): void {
    const entries = this.entries(), index = entries.indexOf(this.selectedId ?? "");
    if (matchesKey(data, "escape") || (matchesKey(data, "up") && index <= 0)) { this.leave(); return; }
    if (matchesKey(data, "up") || matchesKey(data, "down")) {
      const next = index + (matchesKey(data, "down") ? 1 : -1);
      this.selectedId = entries[Math.max(0, Math.min(entries.length - 1, next))];
      this.state.selected = this.selectedId; this.tui.requestRender(); return;
    }
    if (matchesKey(data, "enter") || data === " ") {
      if (this.selectedId === "recent") { this.recentOpen = !this.recentOpen; this.tui.requestRender(); }
      else if (this.selectedId) this.onOpen(this.selectedId);
      return;
    }
    this.leave(data); // Typing returns to the real editor without discarding that key.
  }
  render(width: number): string[] {
    const inner = Math.max(1, width), entries = this.entries();
    const index = entries.indexOf(this.selectedId ?? "");
    const start = this.focused ? Math.max(0, index - 6) : 0;
    const shown = entries.slice(start, start + 8);
    this.mouseRows = shown;
    const lines = [this.theme.fg(this.blocked ? "error" : "dim", truncateToWidth(this.blocked ? "Sub-agents · cleanup unknown — launches blocked" : "Sub-agents · ↓ select · enter/space open", inner))];
    for (const id of shown) {
      const selected = this.focused && this.selectedId === id;
      const run = this.runs.find(item => item.id === id);
      const label = id === "recent" ? `${this.recentOpen ? "▾" : "▸"} Recent (${this.state.recent(this.runs).length})`
        : run ? rowText(run, Math.max(1, inner - 2), this.runs, this.state) : "Unavailable";
      const prefix = selected ? `${CURSOR_MARKER}› ` : "  ";
      lines.push(this.theme.fg(selected ? "accent" : run?.question ? "warning" : "dim", truncateToWidth(prefix + label, inner)));
    }
    return lines;
  }
  handleMouse(event: TuiMouseEvent) {
    if (event.type !== "click" || event.button !== "left") return;
    const id = this.mouseRows[event.y - 1];
    if (!id) return;
    this.focusRoster(id);
    if ((event.clickCount ?? 1) >= 2) this.handleInput("\r");
    return { handled: true as const, focus: this.focused };
  }
  private entries(): string[] {
    const visible = this.state.visible(this.runs).map(run => run.id);
    const recent = this.state.recent(this.runs);
    return [...visible, ...(recent.length ? ["recent", ...(this.recentOpen ? recent.map(run => run.id) : [])] : [])];
  }
  private leave(data?: string): void {
    this.focused = false;
    if (this.restoreEditor) this.restoreEditor(data); else this.restoreOrigin(data);
    this.tui.requestRender();
  }
}
