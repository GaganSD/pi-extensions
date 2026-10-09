import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component, type OverlayHandle, type OverlayOptions, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { clampSidebarColumns, dashboardColumnWidth, formatCompactTokenCount, isSidebarResizeHandle, parseSidebarPercent, sidebarHandleColumn, sidebarPercentFromColumns, SIDEBAR_HIDDEN } from "./layout.ts";
import { installSidebarSplit } from "./sidebar-split.ts";
import type { WorkspaceView } from "./workspace.ts";
import { chromePaint } from "./composer.ts";
import { DEFAULT_SIDEBAR_FOLDS, sidebarText, type SidebarFolds, type SidebarResources, type SidebarSession } from "./sidebar-data.ts";
import type { BackgroundTask } from "./background-tasks.ts";
import { sessionSidebarSlots, sidebarCost, sidebarDuration, sidebarListOffset } from "./sidebar-layout.ts";

export const DOUBLE_CLICK_MS = 400;
type ListName = "mcp" | "skills" | "tasks";
type Row = { text: string; action?: () => void; list?: ListName; item?: number };
type Hit = { y: number; x0: number; x1: number; action: () => void };
export type SidebarActions = {
  copy(text: string): void;
  openFile(filePath: string): void;
  commands?(): void;
  inspect?(title: string, text: string): void;
  persistWidth?(percent: number | undefined): void;
  persistFold?(section: keyof SidebarFolds, expanded: boolean): SidebarFolds | undefined;
};
const EMPTY_SESSION: SidebarSession = {
  id: "", name: "Session", pid: process.pid, cwd: "", model: "—", thinking: "—", tokens: null,
  percent: null, contextWindow: null, estimated: false, rate: null, startedAt: 0,
  lastTurnMs: null, working: false, turns: 0, messages: 0,
  usage: { input: null, output: null, total: null, cacheRead: null, cacheWrite: null, cost: null },
};
const EMPTY_RESOURCES: SidebarResources = { skills: [], commands: [], mcp: [] };

/** One session rail; plain facts in, theme-aware bounded rows and matching hit regions out. */
export class Sidebar implements Component {
  private tui?: TUI;
  private theme?: Theme;
  private themeProvider?: () => Theme | undefined;
  private splitDispose?: () => void;
  private guideHandle?: OverlayHandle;
  private guideOptions?: OverlayOptions;
  private resizing = false;
  private resizeStartScreenX = 0;
  private resizeStartWidth = 0;
  private _preferredWidth?: number;
  hidden = false;
  splitActive = false;
  private session: SidebarSession = EMPTY_SESSION;
  private resources: SidebarResources = EMPTY_RESOURCES;
  private tasks: BackgroundTask[] = [];
  private folds: SidebarFolds = { ...DEFAULT_SIDEBAR_FOLDS };
  private offsets: Record<ListName, number> = { mcp: 0, skills: 0, tasks: 0 };
  private middleOffset = 0;
  private middleRows = 0;
  private middleStart = 0;
  private middleHeight = 0;
  private listRows: Array<{ y: number; list: ListName }> = [];
  private hits: Hit[] = [];
  private selectedImage?: WorkspaceView;
  private peekImage?: WorkspaceView;
  private pinned = false;
  private clearedImageId?: string;
  private imageStart = 0;
  private imageHeight = 0;
  private lastClick?: { target: string; at: number };
  private cached?: { key: string; lines: string[] };
  private revision = 0;
  private actions?: SidebarActions;

  private readonly now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }
  requireTheme(): Theme {
    const theme = this.themeProvider?.() ?? this.theme;
    if (!theme) throw new Error("sidebar is not attached");
    return theme;
  }
  setThemeProvider(provider: () => Theme | undefined): void { this.themeProvider = provider; this.invalidate(); }
  attach(tui: TUI, theme: Theme, onYield?: () => void): void {
    this.tui = tui; this.theme = theme;
    if (this.splitDispose) return;
    this.splitDispose = installSidebarSplit(tui, this, () => this.hidden ? SIDEBAR_HIDDEN : this._preferredWidth, () => {
      this.splitActive = false; this.splitDispose = undefined;
      this.hideResizeGuide(); this.resizing = false; this.hits = []; this.listRows = [];
      onYield?.();
    });
    this.splitActive = Boolean(this.splitDispose);
    this.invalidate();
  }
  isVisible(columns: number, rows: number): boolean { return this.splitActive && !this.hidden && dashboardColumnWidth(columns, rows, this._preferredWidth) > 0; }
  get preferredWidth(): number | undefined { return this._preferredWidth; }
  setPreferredWidth(width: number | undefined): void {
    const next = width === undefined ? undefined : parseSidebarPercent(width);
    if (next === this._preferredWidth) return;
    this._preferredWidth = next; this.changed();
  }
  setHidden(hidden: boolean): void {
    if (this.hidden === hidden) return;
    this.hidden = hidden; if (this.splitActive) this.tui?.requestRender(true);
  }
  setActions(actions: SidebarActions): void { this.actions = actions; }
  setSession(session: SidebarSession): void { this.session = { ...session, usage: { ...session.usage } }; this.changed(); }
  setResources(resources: SidebarResources): void {
    this.resources = { ...resources, mcp: resources.mcp.map(x => ({ ...x })), skills: resources.skills.map(x => ({ ...x })), commands: resources.commands.map(x => ({ ...x })) };
    this.changed();
  }
  setTasks(tasks: readonly BackgroundTask[]): void { this.tasks = tasks.map(task => ({ ...task })); this.changed(); }
  setFolds(folds: SidebarFolds): void { this.folds = { ...folds }; this.changed(); }
  getFolds(): SidebarFolds { return { ...this.folds }; }
  toggleSection(section: keyof SidebarFolds): void { this.setSection(section, !this.folds[section]); }
  setSection(section: keyof SidebarFolds, expanded: boolean): void {
    const next = this.actions?.persistFold
      ? this.actions.persistFold(section, expanded) : { ...this.folds, [section]: expanded };
    if (next) this.setFolds(next);
  }
  /** A new session cannot inherit scroll positions, selected images, or old hit targets. */
  reset(): void {
    this.session = EMPTY_SESSION; this.resources = EMPTY_RESOURCES; this.tasks = [];
    this.offsets = { mcp: 0, skills: 0, tasks: 0 }; this.middleOffset = 0;
    this.selectedImage = undefined; this.peekImage = undefined; this.pinned = false; this.clearedImageId = undefined;
    this.hits = []; this.listRows = []; this.lastClick = undefined; this.changed();
  }
  /** Caret peeks update the image shelf, but cannot replace an explicitly pinned selection. */
  setView(view: WorkspaceView | undefined): void {
    if (!view) { this.peekImage = undefined; this.clearedImageId = undefined; return; }
    if (!view.id.startsWith("image:") || view.id === this.clearedImageId) return;
    this.peekImage = view;
    if (!this.pinned) this.selectedImage = view;
    this.changed();
  }
  currentViewId(): string | undefined { return this.imageView()?.id; }
  private imageView(): WorkspaceView | undefined { return this.pinned ? this.selectedImage : this.peekImage ?? this.selectedImage; }
  pinImage(): void { this.setImagePinned(!this.pinned); }
  setImagePinned(pinned: boolean): void {
    const image = this.imageView();
    if (!image || pinned === this.pinned) return;
    if (pinned) this.selectedImage = image;
    this.pinned = pinned; this.changed();
  }
  clearImage(): void {
    this.clearedImageId = this.imageView()?.id;
    this.selectedImage = undefined; this.peekImage = undefined; this.pinned = false; this.changed();
  }
  imagePath(): string | undefined { return this.imageView()?.filePath; }
  isImagePinned(): boolean { return this.pinned; }
  sessionDetails(): string {
    const s = this.session;
    const uncached = s.usage.input === null || s.usage.cacheRead === null || s.usage.cacheWrite === null ? null : Math.max(0, s.usage.input - s.usage.cacheRead - s.usage.cacheWrite);
    const hit = s.usage.input !== null && s.usage.cacheRead !== null && s.usage.input > 0 ? `${Math.round(s.usage.cacheRead / s.usage.input * 100)}%` : "—";
    return [`${sidebarText(s.name)} · ${s.id || "—"}`, `PID: ${s.pid}`, `Model: ${s.model} · ${s.thinking}`,
      `Context: ${formatCompactTokenCount(s.tokens)} / ${formatCompactTokenCount(s.contextWindow)}${s.estimated ? " (estimated)" : ""}`,
      `Wall time (this runtime): ${sidebarDuration(s.startedAt > 0 ? this.now() - s.startedAt : null)}`,
      `Last turn: ${sidebarDuration(s.lastTurnMs)}`, `Turns: ${s.turns} · Messages: ${s.messages}`,
      `Active-branch usage:`, `Input (uncached + cache read + cache write): ${formatCompactTokenCount(s.usage.input)}`,
      `Output: ${formatCompactTokenCount(s.usage.output)} · Total: ${formatCompactTokenCount(s.usage.total)}`,
      `Cache read: ${formatCompactTokenCount(s.usage.cacheRead)} · Cache write: ${formatCompactTokenCount(s.usage.cacheWrite)}`,
      `Uncached input: ${formatCompactTokenCount(uncached)} · Cache-hit share: ${hit}`,
      `Cost: ${s.usage.cost === null ? "—" : `$${s.usage.cost.toFixed(2)}`}`, `Estimated rate: ${s.rate === null ? "—" : `~${Math.round(s.rate)} tokens/sec`}`, s.cwd].join("\n");
  }
  tick(): void { if (!this.hidden && this.splitActive) this.tui?.requestRender(); }
  invalidate(): void {
    this.cached = undefined;
    this.selectedImage?.invalidate(); this.peekImage?.invalidate();
  }
  private changed(): void { this.revision += 1; this.cached = undefined; if (this.splitActive) this.tui?.requestRender(); }

  handleSplitMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const sidebarWidth = this.displayedWidth(event.width);
    if (sidebarWidth <= 0) return undefined;
    const divider = event.width - sidebarWidth;
    return this.handleResizeMouse(event, event.x >= divider - 1 && event.x <= divider + 1);
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const resize = this.handleResizeMouse(event, isSidebarResizeHandle(event));
    if (resize) return resize;
    if (event.type === "wheel") {
      const delta = -(event.wheelDelta ?? 0);
      const list = this.listRows.find(row => row.y === event.y)?.list;
      if (list && this.scrollList(list, delta)) return { handled: true, render: true };
      if (event.y >= this.middleStart && event.y < this.middleStart + this.middleHeight) {
        const next = sidebarListOffset(this.middleOffset + delta, this.middleRows, this.middleHeight);
        if (next !== this.middleOffset) { this.middleOffset = next; this.changed(); }
        return { handled: true, render: true };
      }
      return undefined;
    }
    if (event.type !== "click" || event.button !== "left") return undefined;
    const hit = this.hits.find(hit => hit.y === event.y && event.x >= hit.x0 && event.x < hit.x1);
    if (hit) { hit.action(); return { handled: true, render: true }; }
    if (event.y > this.imageStart && event.y < this.imageStart + this.imageHeight) {
      const path = this.imagePath();
      if (path && this.isDoubleClick(event, `image:${path}`)) {
        this.actions?.openFile(path); return { handled: true };
      }
    }
    return undefined;
  }

  render(width: number): string[] {
    const height = Math.max(0, this.tui?.terminal.rows ?? 1);
    if (width <= 0) return Array.from({ length: height }, () => "");
    const theme = this.themeProvider?.() ?? this.theme;
    if (theme !== this.theme) { this.theme = theme; this.invalidate(); }
    if (theme) { this.selectedImage?.setTheme?.(theme); this.peekImage?.setTheme?.(theme); }
    const key = `${width}:${height}:${this.revision}:${Math.floor(this.now() / 1000)}`;
    if (this.cached?.key === key) return this.cached.lines;
    this.hits = []; this.listRows = [];
    const slots = sessionSidebarSlots(height, this.tasks.length, Boolean(this.imageView()));
    const inner = Math.max(0, width - 2);
    const lines: string[] = [];
    const add = (row: Row): void => {
      const y = lines.length;
      lines.push(this.decorateLine(row.text, width));
      if (row.action && inner > 0) this.hits.push({ y, x0: 2, x1: width, action: row.action });
      if (row.list) this.listRows.push({ y, list: row.list });
    };
    for (const row of this.headerRows(inner).slice(0, slots.header)) add(row);
    const middle = this.middle(inner);
    this.middleRows = middle.length; this.middleHeight = slots.middle; this.middleStart = lines.length;
    this.middleOffset = sidebarListOffset(this.middleOffset, middle.length, slots.middle);
    for (let i = 0; i < slots.middle; i++) add(middle[this.middleOffset + i] ?? { text: "" });
    for (const row of this.taskRows(inner, slots.tasks)) add(row);
    this.imageStart = lines.length; this.imageHeight = slots.image;
    lines.push(...this.imageLines(width, slots.image, lines.length));
    if (slots.footer) add({ text: this.paint("dim", "/slate session · details"), action: () => this.actions?.inspect?.("Session", this.sessionDetails()) });
    while (lines.length < height) lines.push(this.decorateLine("", width));
    this.cached = { key, lines: lines.slice(0, height) };
    return this.cached.lines;
  }

  private headerRows(width: number): Row[] {
    const s = this.session;
    const percent = s.percent !== null && Number.isFinite(s.percent) ? s.percent : null;
    const filled = percent === null ? 0 : Math.round(Math.max(0, Math.min(100, percent)) * width / 100);
    const tone = percent !== null && percent >= 80 ? "warning" : "success";
    const identity = `${sidebarText(s.id).slice(0, 8) || "—"} · pid ${s.pid}`;
    const occupancy = `${s.estimated ? "~" : ""}${formatCompactTokenCount(s.tokens)} / ${formatCompactTokenCount(s.contextWindow)}`;
    const context = this.pair("Context", percent === null ? "—%" : `${Math.round(percent)}%`, width);
    return [
      { text: this.paint("muted", "SESSION"), action: () => this.actions?.inspect?.("Session", this.sessionDetails()) },
      { text: this.heading(sidebarText(s.name) || "Untitled session") },
      { text: this.paint("muted", visibleWidth(identity) > width ? this.pair(sidebarText(s.id).slice(0, 8), `pid ${s.pid}`, width) : identity), action: () => { if (s.id) this.actions?.copy(s.id); } },
      { text: "" },
      { text: this.pair(this.paint("text", sidebarText(s.model)), this.paint("dim", sidebarText(s.thinking)), width) },
      { text: "" },
      { text: this.paint("muted", context) },
      { text: this.paint(tone, "█".repeat(filled)) + this.paint("dim", "─".repeat(width - filled)) },
      { text: this.paint("muted", occupancy) },
      { text: "" },
      ...[["Input", formatCompactTokenCount(s.usage.input)], ["Output", formatCompactTokenCount(s.usage.output)], ["Cost", sidebarCost(s.usage.cost)]].map(([label, value]) => ({
        text: this.pair(this.paint("muted", label!), this.paint("text", value!), width),
        action: () => this.actions?.inspect?.("Branch usage", this.sessionDetails()),
      })),
      { text: "" },
      { text: this.paint("dim", "─".repeat(width)) },
    ];
  }
  private middle(width: number): Row[] {
    const enabled = this.resources.mcp.filter(x => x.enabled === true).length;
    const unknown = this.resources.mcp.some(x => x.enabled === null);
    const loaded = this.resources.skills.filter(x => x.loaded).length;
    const resourceHeading = (label: string, count: string): string =>
      this.heading(label) + this.paint("muted", ` · ${count}`);
    const rows: Row[] = [{ text: "" }, {
      text: resourceHeading(`${this.folds.mcp ? "⌄" : "›"} MCP`, this.resources.mcpError ? "config error" : `${unknown ? "—" : enabled} enabled`),
      action: () => this.toggleSection("mcp"),
    }];
    if (this.folds.mcp) {
      if (this.resources.mcpError) rows.push({ text: this.paint("warning", this.resources.mcpError) });
      rows.push(...this.resourceRows("mcp", width));
    }
    rows.push({ text: "" }, { text: resourceHeading(`${this.folds.skills ? "⌄" : "›"} Skills`, `${loaded} loaded`), action: () => this.toggleSection("skills") });
    if (this.folds.skills) rows.push(...this.resourceRows("skills", width));
    rows.push({ text: "" }, { text: resourceHeading("› Commands", String(this.resources.commands.length)), action: () => this.actions?.commands?.() });
    return rows;
  }
  private resourceRows(list: Exclude<ListName, "tasks">, width: number): Row[] {
    const items = this.resources[list];
    const visible = list === "mcp" ? 5 : 3;
    this.offsets[list] = sidebarListOffset(this.offsets[list], items.length, visible);
    if (!items.length) return [{ text: this.paint("dim", list === "skills" ? "No skill catalog available" : "none"), list }];
    const start = this.offsets[list];
    const rows: Row[] = [];
    for (let i = start; i < Math.min(items.length, start + visible); i++) {
      if (list === "mcp") {
        const server = this.resources.mcp[i]!;
        const state = server.enabled === null ? "—" : server.enabled ? "enabled" : "disabled";
        rows.push({ text: this.paint(server.enabled === null ? "warning" : server.enabled ? "muted" : "dim", this.pair(`${server.enabled ? "●" : "○"} ${sidebarText(server.name)}`, state, width)), list, item: i,
          action: () => this.actions?.inspect?.(server.name, `${state} (configuration, not connection status)\nSource: ${server.source}\nUse /mcp to manage this server.`) });
      } else if (list === "skills") {
        const skill = this.resources.skills[i]!;
        rows.push({ text: this.paint(skill.loaded ? "muted" : "dim", this.pair(`${skill.loaded ? "●" : "○"} ${sidebarText(skill.name)}`, skill.loaded ? "loaded" : "available", width)), list, item: i,
          action: () => this.actions?.inspect?.(skill.name, `${skill.loaded ? "Instructions observed loaded on this branch" : "Available; instructions not observed loaded"}\nSource: ${skill.source}\n${skill.path}`) });
      }
    }
    if (items.length > visible) rows.push({ text: this.paint("dim", `${start + 1}–${Math.min(items.length, start + visible)} / ${items.length} · scroll ↕`), list });
    return rows;
  }
  private taskRows(width: number, height: number): Row[] {
    if (height <= 0 || !this.tasks.length) return [];
    const live = this.tasks.filter(t => t.state !== "failed" && t.state !== "cleanup_unknown").length;
    const rows: Row[] = height >= 4 ? [{ text: "" }] : [];
    rows.push({ text: this.pair(this.heading("Tasks"), this.paint("muted", live ? `${live} live` : `${this.tasks.length} recorded`), width),
      action: () => this.actions?.inspect?.("Background tasks", this.tasks.map(t => this.taskDetails(t)).join("\n\n")) });
    const visible = Math.max(1, Math.ceil((height - rows.length) / 2));
    this.offsets.tasks = sidebarListOffset(this.offsets.tasks, this.tasks.length, visible);
    for (const task of this.tasks.slice(this.offsets.tasks, this.offsets.tasks + visible)) {
      const error = task.state === "failed" || task.state === "cleanup_unknown";
      const icon = error ? "!" : task.state === "waiting" ? "?" : "●";
      const action = () => this.actions?.inspect?.(task.label, this.taskDetails(task));
      if (rows.length < height) rows.push({ text: this.paint(error ? "error" : task.state === "waiting" ? "warning" : "muted",
        this.pair(`${icon} ${sidebarText(task.label)}`, task.state, width)), list: "tasks", action });
      if (rows.length < height) rows.push({ text: this.paint("dim", `${task.kind} · ${sidebarDuration(this.now() - task.startedAt)}${task.pid ? ` · pid ${task.pid}` : ""}`), list: "tasks", action });
    }
    while (rows.length < height) rows.push({ text: "" });
    return rows;
  }
  private taskDetails(task: BackgroundTask): string {
    return `${task.kind} · ${task.state}\nSource: ${task.source}\nID: ${task.id}\n${task.pid ? `PID: ${task.pid}\n` : ""}Elapsed: ${sidebarDuration(this.now() - task.startedAt)}\n${task.detail ?? ""}`;
  }
  private imageLines(width: number, height: number, start: number): string[] {
    const view = this.imageView();
    if (height <= 0 || !view) return [];
    const inner = Math.max(0, width - 2);
    const title = height <= 2 ? `Preview · ${sidebarText(view.title ?? view.filePath)}` : "Preview";
    const lines = [this.decorateLine(this.pair(this.heading(title), this.paint("muted", this.pinned ? "pinned" : "caret"), inner), width)];
    if (height === 1) return lines;
    const controls: Array<{ label: string; action: () => void }> = [
      { label: this.pinned ? "[unpin]" : "[pin]", action: () => this.pinImage() },
      { label: "[open]", action: () => { if (view.filePath) this.actions?.openFile(view.filePath); } },
      { label: "[copy]", action: () => { if (view.filePath) this.actions?.copy(view.filePath); } },
      { label: "[clear]", action: () => this.clearImage() },
    ];
    while (visibleWidth(controls.map(x => x.label).join(" ")) > inner && controls.length > 1) controls.splice(1, 1);
    const caption = height > 2 ? 1 : 0;
    const bodyHeight = Math.max(0, height - 2 - caption);
    if (bodyHeight && inner) lines.push(...view.render(inner, bodyHeight).slice(0, bodyHeight).map(line => this.decorateLine(line, width)));
    while (lines.length < height - 1 - caption) lines.push(this.decorateLine("", width));
    if (caption) lines.push(this.decorateLine(this.paint("dim", sidebarText(view.title ?? view.filePath)), width));
    const actions = controls.map(x => x.label).join(" ");
    let x = 2;
    if (inner >= visibleWidth(actions)) for (const control of controls) {
      this.hits.push({ y: start + height - 1, x0: x, x1: x + visibleWidth(control.label), action: control.action });
      x += visibleWidth(control.label) + 1;
    }
    lines.push(this.decorateLine(this.paint("muted", actions), width));
    return lines.slice(0, height);
  }
  private scrollList(list: ListName, delta: number): boolean {
    const count = list === "tasks" ? this.tasks.length : this.resources[list].length;
    const visible = list === "tasks" ? Math.max(1, Math.ceil(this.listRows.filter(x => x.list === "tasks").length / 2)) : list === "mcp" ? 5 : 3;
    const next = sidebarListOffset(this.offsets[list] + delta, count, visible);
    if (next === this.offsets[list]) return false;
    this.offsets[list] = next; this.changed(); return true;
  }
  private pair(left: string, right: string, width: number): string {
    const r = truncateToWidth(right, Math.max(0, width - 1), "…");
    const l = truncateToWidth(left, Math.max(0, width - visibleWidth(r) - 1), "…");
    return `${l}${" ".repeat(Math.max(0, width - visibleWidth(l) - visibleWidth(r)))}${r}`;
  }
  private heading(text: string): string { const painted = this.paint("text", text); return this.theme?.bold?.(painted) ?? painted; }
  private paint(tone: "text" | "muted" | "dim" | "success" | "warning" | "error" | "mdHeading", text: string): string { return this.theme?.fg(tone, text) ?? text; }
  private isDoubleClick(event: TuiMouseEvent, target: string): boolean {
    if (event.clickCount !== undefined) return event.clickCount === 2;
    const at = this.now(); const previous = this.lastClick;
    const doubled = Boolean(previous && previous.target === target && at - previous.at <= DOUBLE_CLICK_MS);
    this.lastClick = doubled ? undefined : { target, at }; return doubled;
  }
  dispose(): void {
    this.hideResizeGuide(); this.resizing = false;
    this.splitDispose?.(); this.splitDispose = undefined; this.splitActive = false;
    this.reset(); this.tui = undefined; this.theme = undefined; this.themeProvider = undefined; this.actions = undefined;
  }

  private handleResizeMouse(event: TuiMouseEvent, onHandle: boolean): TuiMouseEventResult | undefined {
    if (this.resizing) {
      if (event.type === "drag" || event.type === "move") return this.moveResizeGuide(event.screenX);
      if (event.type === "release") {
        this.commitResize(event.screenX);
        return { handled: true, render: true };
      }
      if (event.type === "click") return { handled: true };
    }
    if (onHandle && event.type === "press" && event.button === "left") {
      this.beginResize(event.screenX);
      return { handled: true, capture: true, render: true };
    }
    if (onHandle && event.type === "click" && event.button === "left") return { handled: true };
    return undefined;
  }

  private displayedWidth(totalWidth = this.tui?.terminal.columns ?? 0): number {
    return dashboardColumnWidth(totalWidth, this.tui?.terminal.rows ?? 0, this.hidden ? SIDEBAR_HIDDEN : this._preferredWidth);
  }

  private beginResize(screenX: number): void {
    this.resizing = true;
    this.resizeStartScreenX = screenX;
    this.resizeStartWidth = this.displayedWidth();
    this.showResizeGuide(screenX);
  }

  private moveResizeGuide(screenX: number): TuiMouseEventResult {
    if (!this.guideOptions) {
      this.showResizeGuide(screenX);
      return { handled: true, render: true };
    }
    const col = this.guideColumn(screenX);
    if (this.guideOptions.col === col) return { handled: true, render: false };
    this.guideOptions.col = col;
    return { handled: true, render: true };
  }

  private commitResize(screenX: number): void {
    const next = this.widthFromPointer(screenX);
    this.hideResizeGuide();
    this.resizing = false;
    if (next === this.resizeStartWidth || next <= 0) return;
    const percent = sidebarPercentFromColumns(this.tui?.terminal.columns ?? 0, next);
    this.setPreferredWidth(percent);
    this.actions?.persistWidth?.(percent);
  }

  private showResizeGuide(screenX: number): void {
    if (!this.tui) return;
    const col = this.guideColumn(screenX);
    if (this.guideOptions && this.guideHandle) {
      this.guideOptions.col = col;
      return;
    }
    this.guideOptions = {
      nonCapturing: true,
      width: 1,
      minWidth: 1,
      col,
      row: 0,
      maxHeight: "100%",
    };
    this.guideHandle = this.tui.showOverlay(
      new ResizeGuide(() => this.tui?.terminal.rows ?? 1, this.theme),
      this.guideOptions,
    );
  }

  private hideResizeGuide(): void {
    this.guideHandle?.hide();
    this.guideHandle = undefined;
    this.guideOptions = undefined;
  }

  private widthFromPointer(screenX: number): number {
    const total = this.tui?.terminal.columns ?? 0;
    return clampSidebarColumns(
      total,
      this.resizeStartWidth + this.resizeStartScreenX - screenX,
    );
  }

  private guideColumn(screenX: number): number {
    const total = this.tui?.terminal.columns ?? 0;
    return sidebarHandleColumn(total, this.widthFromPointer(screenX));
  }



  private decorateLine(line: string, width: number): string {
    if (width <= 0) return "";
    const border = this.theme ? chromePaint(this.theme)("│") : "│";
    if (width === 1) return border;
    if (line.includes("\x1b_G") || line.includes("\x1b]1337;File=")) return `${border} ${line}`;
    const body = truncateToWidth(line, Math.max(0, width - 2), "…");
    const lineText = `${border} ${body}${" ".repeat(Math.max(0, width - 2 - visibleWidth(body)))}`;
    return this.theme?.bg?.("customMessageBg", lineText) ?? lineText;
  }
}

class ResizeGuide implements Component {
  private readonly rows: () => number;
  private readonly theme?: Theme;
  constructor(rows: () => number, theme?: Theme) { this.rows = rows; this.theme = theme; }
  invalidate(): void {}
  render(): string[] { return Array.from({ length: Math.max(1, this.rows()) }, () => this.theme?.fg("accent", "│") ?? "│"); }
}
