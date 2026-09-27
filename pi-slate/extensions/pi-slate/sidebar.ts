import { homedir } from "node:os";
import { type Theme } from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  type Component,
  type OverlayHandle,
  type OverlayOptions,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
  formatContextResources,
  formatContextTokens,
  isSidebarResizeHandle,
  clampSidebarColumns,
  parseSidebarPercent,
  sidebarPercentFromColumns,
  SIDEBAR_EDITOR_RESERVE,
  SIDEBAR_MIN_TERMINAL_WIDTH,
  SIDEBAR_MIN_WIDTH,
  sidebarHandleColumn,
  workspaceColumnWidth,
} from "./layout.ts";
import {
  clampFilesOffset,
  fileAtPanelRow,
  fileKey,
  fileMark,
  filesPanel,
  formatFileLabel,
  sameFiles,
  type FileChange,
} from "./files-modified.ts";
import { installSidebarSplit } from "./sidebar-split.ts";
import type { WorkspaceView } from "./workspace.ts";
import { TurnLogView } from "./turn-log.ts";
import { formatTurnImpact, type TurnImpactSnapshot } from "./turn-impact.ts";
import {
  filesWidgetDesiredHeight,
  SIDEBAR_DOCK_LINES,
  sidebarRowSlots,
  splitSidebarContent,
} from "./workspace-layout.ts";
import { COMPOSER_SHELF_LINES, chromePaint, composerFrameLineCount, frameRow, inscribedTitle } from "./composer.ts";

const KITTY_PREFIX = "\x1b_G";
const CLEAR = "[clear]";
const COPY = "[copy]";
const COPY_PATH = "[copy path]";
const PEEK_PAD = 2;

export type SidebarContextData = {
  tokens: number | null;
  percent: number | null;
  tokensPerSec: number;
  spend: number;
};

export const DOUBLE_CLICK_MS = 400;

export type SidebarActions = {
  copy(text: string): void;
  openFile(filePath: string): void;
  selectFile(file: FileChange): void;
  persistWidth?(columns: number | undefined): void;
};

export class Sidebar implements Component {
  private tui?: TUI;
  private theme?: Theme;
  private handle?: OverlayHandle;
  private overlayOptions?: OverlayOptions;
  private splitDispose?: () => void;
  private guideHandle?: OverlayHandle;
  private guideOptions?: OverlayOptions;
  private resizing = false;
  private resizeStartScreenX = 0;
  private resizeStartWidth = 0;
  private _preferredWidth?: number;
  private selectedView?: WorkspaceView;
  private transientView?: WorkspaceView;
  private turnImpact: TurnImpactSnapshot = emptyTurnImpact();
  private turnView?: TurnLogView;
  private contextData: SidebarContextData = { tokens: null, percent: null, tokensPerSec: 0, spend: 0 };
  private lastSlots = { summaryHeight: 0, peekHeight: 0, dividerHeight: 0, filesHeight: 0, filesStart: 0, impactStart: 0, impactHeight: 0 };
  private mcpConnected: number | null = null;
  private skillsLoaded = 0;
  private files: FileChange[] = [];
  private filesRev = 0;
  private filesOffset = 0;
  private selectedFileKey?: string;
  private selectedActivityRow?: number;
  private lastPeekHits?: Array<{ id: "clear" | "copy"; y: number; x0: number; x1: number }>;
  private lastClick?: { target: string; at: number };
  private cwd = "";
  private home = homedir();
  private contentCached?: { key: string; lines: string[] };
  private dockCached?: { key: string; lines: string[] };
  private actions?: SidebarActions;
  splitActive = false;

  requireTheme(): Theme {
    if (!this.theme) throw new Error("sidebar is not attached");
    return this.theme;
  }

  attach(tui: TUI, theme: Theme): void {
    this.tui = tui;
    this.theme = theme;
    if (this.splitDispose || this.handle) return;
    this.splitDispose = installSidebarSplit(tui, this, () => this._preferredWidth);
    this.splitActive = Boolean(this.splitDispose);
    this.contentCached = undefined;
    this.dockCached = undefined;
    if (this.splitActive) return;
    this.overlayOptions = {
      nonCapturing: true,
      anchor: "top-right",
      width: this.overlayWidth(tui.terminal.columns),
      minWidth: SIDEBAR_MIN_WIDTH,
      maxHeight: "100%",
      margin: { top: 0, right: 0, bottom: SIDEBAR_EDITOR_RESERVE, left: 0 },
      visible: (termWidth) => termWidth >= SIDEBAR_MIN_TERMINAL_WIDTH,
    };
    this.handle = tui.showOverlay(this, this.overlayOptions);
  }

  get preferredWidth(): number | undefined {
    return this._preferredWidth;
  }

  setPreferredWidth(width: number | undefined): void {
    const next = width === undefined ? undefined : parseSidebarPercent(width);
    if (this._preferredWidth === next) return;
    this._preferredWidth = next;
    this.syncOverlayWidth();
    this.tui?.requestRender();
  }

  setActions(actions: SidebarActions): void {
    this.actions = actions;
  }

  /** Temporary image preview; it overrides but never discards a selected file preview. */
  setView(view: WorkspaceView | undefined): void {
    if (this.transientView?.id === view?.id) return;
    this.transientView = view;
    this.contentCached = undefined;
    this.tui?.requestRender();
  }

  setSelectedPreview(view: WorkspaceView | undefined): void {
    if (!view) {
      this.selectedFileKey = undefined;
      this.selectedActivityRow = undefined;
    }
    if (this.selectedView?.id === view?.id) return;
    this.selectedView = view;
    this.contentCached = undefined;
    this.tui?.requestRender();
  }

  setTurnImpact(impact: TurnImpactSnapshot): void {
    if (this.turnImpact.revision === impact.revision) return;
    this.turnImpact = impact;
    this.turnView?.setEvents(impact.events);
    this.contentCached = undefined;
    this.tui?.requestRender();
  }

  private effectiveView(): WorkspaceView | undefined { return this.transientView ?? this.selectedView; }

  setContext(data: SidebarContextData): void {
    if (
      this.contextData.tokens === data.tokens &&
      this.contextData.percent === data.percent &&
      this.contextData.spend === data.spend &&
      Math.round(this.contextData.tokensPerSec) === Math.round(data.tokensPerSec)
    ) {
      return;
    }
    this.contextData = data;
    this.dockCached = undefined;
    this.tui?.requestRender();
  }

  setCwd(cwd: string): void {
    if (this.cwd === cwd) return;
    this.cwd = cwd;
    this.turnView?.setPlace(cwd, this.home);
    this.contentCached = undefined;
  }

  setFiles(files: FileChange[]): void {
    if (sameFiles(this.files, files)) return;
    this.files = files;
    this.filesRev += 1;
    this.filesOffset = clampFilesOffset(
      this.filesOffset,
      files.length,
      Math.max(0, filesWidgetDesiredHeight(files.length) - 1),
    );
    this.contentCached = undefined;
    this.tui?.requestRender();
  }

  setMcpConnected(count: number | null): void {
    if (this.mcpConnected === count) return;
    this.mcpConnected = count;
    this.dockCached = undefined;
    this.tui?.requestRender();
  }

  setSkillsLoaded(count: number): void {
    const next = Math.max(0, Math.round(count));
    if (this.skillsLoaded === next) return;
    this.skillsLoaded = next;
    this.dockCached = undefined;
    this.tui?.requestRender();
  }

  currentViewId(): string | undefined {
    return this.effectiveView()?.id;
  }

  handleSplitMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const sidebarWidth = this.displayedWidth(event.width);
    if (sidebarWidth <= 0) return undefined;
    const divider = event.width - sidebarWidth;
    return this.handleResizeMouse(event, event.x >= divider - 1 && event.x <= divider + 1);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const resize = this.handleResizeMouse(event, isSidebarResizeHandle(event));
    if (resize) return resize;

    const { summaryHeight, filesHeight, dividerHeight, peekHeight, filesStart, impactStart, impactHeight } = this.lastSlots;
    const peekStart = summaryHeight + dividerHeight;
    const impactIndex = event.y - impactStart;
    const overImpact = impactStart > 0 && impactIndex >= 0 && impactIndex < impactHeight;
    if (event.type === "click" && event.button === "left" && overImpact) {
      this.selectedFileKey = undefined;
      this.selectedActivityRow = impactIndex;
      this.setView(undefined);
      this.setSelectedPreview(this.activityView());
      return { handled: true, render: true };
    }
    if (event.type === "wheel" && event.y >= filesStart && event.y < filesStart + filesHeight) {
      if (!this.scrollFiles(-(event.wheelDelta ?? 0))) return undefined;
      return { handled: true };
    }
    if (event.type === "click" && event.button === "left" && event.y >= filesStart && event.y < filesStart + filesHeight) {
      const file = fileAtPanelRow(this.files, filesHeight, this.filesOffset, event.y - filesStart);
      if (!file) return undefined;
      this.selectedActivityRow = undefined;
      this.selectedFileKey = fileKey(file);
      this.setView(undefined);
      this.actions?.selectFile(file);
      if (this.isDoubleClick(event, `file:${file.path}:${event.x}`)) this.actions?.openFile(file.path);
      return { handled: true };
    }
    if (event.type === "click" && event.button === "left" && this.lastPeekHits) {
      const hit = this.lastPeekHits.find((item) => (
        event.y === item.y && event.x >= item.x0 && event.x < item.x1
      ));
      if (hit?.id === "clear") {
        this.setView(undefined);
        this.setSelectedPreview(undefined);
        return { handled: true, render: true };
      }
      if (hit?.id === "copy") {
        const path = this.effectiveView()?.filePath;
        if (path) this.actions?.copy(path);
        return { handled: true };
      }
    }
    const view = this.effectiveView();
    const titleOffset = peekHeight > 1 ? 1 : 0;
    const peekBodyStart = peekStart + titleOffset;
    if (event.type === "wheel" && event.y >= peekBodyStart && event.y < peekStart + peekHeight) {
      if (!view?.handleWheel?.(-(event.wheelDelta ?? 0))) return undefined;
      this.contentCached = undefined;
      this.tui?.requestRender();
      return { handled: true };
    }
    if (event.type === "click" && event.button === "left" && event.y >= peekStart && event.y < peekStart + peekHeight) {
      const path = view?.filePath;
      if (path && this.isDoubleClick(event, `preview:${path}:${event.x}:${event.y}`)) {
        this.actions?.openFile(path);
        return { handled: true };
      }
    }
    if (event.type !== "click" || event.button !== "left") return undefined;
    const y = event.y - peekBodyStart;
    if (y < 0 || y >= peekHeight - titleOffset) return undefined;
    const peekX = event.x - PEEK_PAD;
    const copied = view?.copyTextAt?.(peekX, y);
    if (copied !== undefined) {
      this.actions?.copy(copied);
      return { handled: true };
    }
    if (!view?.handleClick?.(peekX, y)) return undefined;
    return { handled: true };
  }

  invalidate(): void {
    this.contentCached = undefined;
    this.dockCached = undefined;
    this.selectedView?.invalidate();
    this.transientView?.invalidate();
  }

  render(width: number): string[] {
    this.syncOverlayWidth();
    const theme = this.theme;
    const height = Math.max(1, this.tui?.terminal.rows ?? 1);
    const dockWant = this.splitActive ? Math.max(COMPOSER_SHELF_LINES, composerFrameLineCount()) : SIDEBAR_DOCK_LINES;
    const { contentHeight, dockHeight } = sidebarRowSlots(height, dockWant);
    const contentKey = `${width}x${contentHeight}:${this.filesRev}:${this.filesOffset}:${this.turnImpact.revision}:${this.effectiveView()?.id ?? ""}:${this.selectedFileKey ?? ""}:${this.selectedActivityRow ?? ""}`;
    const dockKey = `${width}x${dockHeight}:${this.contextData.tokens}:${this.contextData.percent}:${this.contextData.spend}:${Math.round(this.contextData.tokensPerSec)}:${this.skillsLoaded}:${this.mcpConnected}`;
    const content = this.contentCached?.key === contentKey
      ? this.contentCached.lines
      : this.contentLines(width, contentHeight, theme);
    const dock = this.dockCached?.key === dockKey
      ? this.dockCached.lines
      : this.dockLines(width, dockHeight, theme);
    this.contentCached = { key: contentKey, lines: content };
    this.dockCached = { key: dockKey, lines: dock };
    return [...content, ...dock].slice(0, height);
  }

  dispose(): void {
    this.hideResizeGuide();
    this.resizing = false;
    this.splitDispose?.();
    this.splitDispose = undefined;
    this.splitActive = false;
    this.handle?.hide();
    this.handle = undefined;
    this.overlayOptions = undefined;
    this.selectedView = undefined;
    this.transientView = undefined;
    this.files = [];
    this.filesRev = 0;
    this.filesOffset = 0;
    this.selectedFileKey = undefined;
    this.selectedActivityRow = undefined;
    this.lastPeekHits = undefined;
    this.lastClick = undefined;
    this.cwd = "";
    this.contentCached = undefined;
    this.dockCached = undefined;
    this.lastSlots = { summaryHeight: 0, peekHeight: 0, dividerHeight: 0, filesHeight: 0, filesStart: 0, impactStart: 0, impactHeight: 0 };
    this.turnView = undefined;
    this.tui = undefined;
    this.theme = undefined;
  }

  private dockLines(width: number, height: number, theme: Theme | undefined): string[] {
    if (height < 1) return [];
    const tokens = formatContextTokens(
      this.contextData.tokens,
      this.contextData.percent,
      this.contextData.tokensPerSec,
    );
    const resources = formatContextResources(this.contextData.spend, this.skillsLoaded, this.mcpConnected);
    const paint = this.paint(theme);
    if (height === 1) return [inscribedTitle(this.titled("Context", theme), width, paint, "bottom")];

    const facts = [
      theme ? this.body(tokens, width, theme, "muted") : this.decorateLine(tokens, width, theme),
      theme ? this.body(resources, width, theme, "dim") : this.decorateLine(resources, width, theme),
    ];
    const lines = [inscribedTitle(this.titled("Context", theme), width, paint, "top")];
    const inner = height - 1;
    const factCount = Math.min(facts.length, Math.max(0, inner - lines.length));
    while (lines.length + factCount < inner) lines.push(this.decorateLine("", width, theme));
    lines.push(...facts.slice(0, factCount));
    lines.push(inscribedTitle("", width, paint, "bottom"));
    return lines.slice(0, height);
  }

  private contentLines(width: number, height: number, theme: Theme | undefined): string[] {
    if (height < 1) {
      this.lastSlots = { summaryHeight: 0, peekHeight: 0, dividerHeight: 0, filesHeight: 0, filesStart: 0, impactStart: 0, impactHeight: 0 };
      return [];
    }
    const slots = splitSidebarContent(height, filesWidgetDesiredHeight(this.files.length));
    this.lastSlots = { ...slots, filesStart: 0, impactStart: 0, impactHeight: 0 };
    const lines: string[] = [...this.summaryLines(width, slots.summaryHeight, slots.filesHeight, theme)];
    this.pushRule(lines, slots.dividerHeight, width, theme);
    lines.push(...this.peekLines(width, slots.peekHeight, theme));
    return lines;
  }

  private summaryLines(width: number, height: number, filesHeight: number, theme: Theme | undefined): string[] {
    if (height < 1) return [];
    const empty = this.decorateLine("", width, theme);
    const files = this.filesLines(width, filesHeight, theme);
    const impact = formatTurnImpact(this.turnImpact).map((line, index) => {
      const selected = index === this.selectedActivityRow;
      const clickable = this.turnImpact.toolsCalled > 0;
      const text = `${selected ? "> " : "  "}${line}`;
      if (selected) return this.decorateLine(theme ? theme.bold(theme.fg("muted", text)) : text, width, theme);
      return this.body(text, width, theme, clickable ? "muted" : "dim");
    });
    const extra = Math.max(0, height - (1 + files.length + 1 + impact.length));
    const lines = [inscribedTitle(this.titled("Summary", theme), width, this.paint(theme), "top")];
    if (extra > 0) lines.push(empty);
    this.lastSlots = { ...this.lastSlots, filesStart: lines.length };
    lines.push(...files);
    if (extra > 1) lines.push(empty);
    if (lines.length < height) lines.push(this.heading("Last Turn", width, theme));
    const impactStart = lines.length;
    let impactHeight = 0;
    for (const line of impact) {
      if (lines.length >= height) break;
      lines.push(line);
      if (this.turnImpact.toolsCalled > 0) impactHeight += 1;
    }
    this.lastSlots = { ...this.lastSlots, impactStart, impactHeight };
    return this.padBlock(lines, height, width, theme);
  }

  private peekLines(width: number, maxHeight: number, theme: Theme | undefined): string[] {
    if (maxHeight < 1) return [];
    const view = this.effectiveView();
    const lines = [this.peekHeading(width, theme, view)];
    const close = maxHeight >= 2 ? 1 : 0;
    const bodyHeight = maxHeight - 1 - close;
    if (bodyHeight >= 1) {
      if (!view) lines.push(this.body("none", width, theme, "dim"));
      else {
        const peek = view.render(Math.max(0, width - 2), bodyHeight);
        for (let row = 0; row < bodyHeight; row++) {
          lines.push(this.decorateLine(peek[row] ?? "", width, theme));
        }
      }
    }
    while (lines.length < maxHeight - close) lines.push(this.decorateLine("", width, theme));
    if (close) lines.push(inscribedTitle("", width, this.paint(theme), "bottom"));
    return lines.slice(0, maxHeight);
  }

  private filesLines(width: number, maxHeight: number, theme: Theme | undefined): string[] {
    if (maxHeight < 1) return [];
    const panel = filesPanel(this.files, maxHeight, this.filesOffset);
    this.filesOffset = panel.offset;
    return panel.lines.map((line) => {
      if (line.type === "heading") {
        const label = line.count > 0 ? `Files Changed · ${line.count}` : "Files Changed";
        return this.heading(label, width, theme);
      }
      if (line.type === "empty") return this.body("none", width, theme, "dim");
      const mark = fileMark(line.item);
      const label = formatFileLabel(line.item);
      const selected = fileKey(line.item) === this.selectedFileKey;
      const prefix = selected ? "> " : "  ";
      const text = `${prefix}${mark.mark} ${label}`;
      if (!theme) return this.decorateLine(text, width, theme);
      const colored = `${prefix}${theme.fg(mark.tone, mark.mark)} ${theme.fg("muted", label)}`;
      return this.decorateLine(selected ? theme.bold(colored) : colored, width, theme);
    });
  }

  private isDoubleClick(event: TuiMouseEvent, target: string): boolean {
    if (event.clickCount !== undefined) return event.clickCount === 2;
    const at = Date.now();
    const previous = this.lastClick;
    const doubled = Boolean(previous && previous.target === target && at - previous.at <= DOUBLE_CLICK_MS);
    this.lastClick = doubled ? undefined : { target, at };
    return doubled;
  }

  private activityView(): TurnLogView {
    if (!this.turnView) {
      this.turnView = new TurnLogView(this.turnImpact.events, this.requireTheme(), () => {
        this.contentCached = undefined;
        this.tui?.requestRender();
      }, this.cwd, this.home);
    }
    return this.turnView;
  }

  private scrollFiles(delta: number): boolean {
    if (delta === 0 || this.files.length === 0) return false;
    const bodyHeight = Math.max(0, this.lastSlots.filesHeight - (this.lastSlots.filesHeight > 1 ? 1 : 0));
    const next = clampFilesOffset(this.filesOffset + delta, this.files.length, bodyHeight);
    if (next === this.filesOffset) return false;
    this.filesOffset = next;
    this.contentCached = undefined;
    this.tui?.requestRender();
    return true;
  }

  private pushRule(lines: string[], height: number, width: number, theme: Theme | undefined): void {
    if (height < 1) return;
    lines.push(theme ? this.rule(width, theme) : frameRow("─".repeat(Math.max(0, width - 2)), width, (text) => text));
  }

  private padBlock(block: string[], height: number, width: number, theme: Theme | undefined): string[] {
    const lines = block.slice(0, height);
    while (lines.length < height) lines.push(this.decorateLine("", width, theme));
    return lines;
  }

  private peekHeading(width: number, theme: Theme | undefined, view: WorkspaceView | undefined): string {
    const title = view?.title ? `Preview · ${view.title}` : "Preview";
    if (!view) {
      this.lastPeekHits = undefined;
      return this.heading(title, width, theme);
    }
    const inner = Math.max(0, width - 2);
    const copyLabel = peekCopyLabel(view, inner);
    const actions = copyLabel ? `${copyLabel} ${CLEAR}` : CLEAR;
    const leftMax = Math.max(0, inner - actions.length - 1);
    const left = truncateToWidth(title, leftMax, "…");
    const pad = Math.max(0, inner - 1 - visibleWidth(left) - actions.length);
    const y = this.lastSlots.summaryHeight + this.lastSlots.dividerHeight;
    const clearX0 = Math.max(PEEK_PAD, width - 1 - CLEAR.length);
    const hits: Array<{ id: "clear" | "copy"; y: number; x0: number; x1: number }> = [
      { id: "clear", y, x0: clearX0, x1: Math.max(clearX0, width - 1) },
    ];
    if (copyLabel) {
      const copyX1 = clearX0 - 1;
      const copyX0 = Math.max(PEEK_PAD, copyX1 - copyLabel.length);
      if (copyX0 < copyX1 && copyX0 >= PEEK_PAD) {
        hits.unshift({ id: "copy", y, x0: copyX0, x1: Math.min(copyX1, clearX0) });
      }
    }
    this.lastPeekHits = hits;
    const action = theme ? theme.fg("dim", actions) : actions;
    const label = this.titled(left, theme);
    const row = frameRow(` ${left}${" ".repeat(pad)}${actions}`, width, this.paint(theme));
    return row.replace(` ${left}`, ` ${label}`).replace(actions, action);
  }

  private titled(label: string, theme: Theme | undefined): string {
    return theme ? theme.fg("mdHeading", label) : label;
  }

  private heading(label: string, width: number, theme: Theme | undefined): string {
    return this.decorateLine(this.titled(label, theme), width, theme);
  }

  private body(text: string, width: number, theme: Theme | undefined, color: "muted" | "dim"): string {
    if (!theme) return this.decorateLine(text, width, theme);
    return this.decorateLine(theme.fg(color, text), width, theme);
  }

  private paint(theme: Theme | undefined): (text: string) => string {
    return theme ? chromePaint(theme) : (text) => text;
  }

  private rule(width: number, theme: Theme): string {
    return inscribedTitle("", width, this.paint(theme), "mid");
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
    return workspaceColumnWidth(totalWidth, this._preferredWidth);
  }

  private overlayWidth(totalWidth: number): OverlayOptions["width"] {
    return this.displayedWidth(totalWidth) || "20%";
  }

  private syncOverlayWidth(): void {
    if (!this.overlayOptions || !this.tui) return;
    const width = this.overlayWidth(this.tui.terminal.columns);
    if (this.overlayOptions.width !== width) this.overlayOptions.width = width;
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

  private decorateLine(line: string, width: number, theme: Theme | undefined): string {
    if (line.includes(KITTY_PREFIX) || line.includes("\x1b]1337;File=")) {
      return `${this.paint(theme)("│")} ${line}`;
    }
    const inner = Math.max(0, width - 2);
    const body = line.length === 0 ? "" : truncateToWidth(` ${line}`, inner);
    return frameRow(body, width, this.paint(theme));
  }
}

class ResizeGuide implements Component {
  private readonly rows: () => number;
  private readonly theme?: Theme;

  constructor(rows: () => number, theme?: Theme) {
    this.rows = rows;
    this.theme = theme;
  }

  invalidate(): void {}

  render(_width: number): string[] {
    const mark = this.theme ? this.theme.fg("accent", "│") : "│";
    return Array.from({ length: Math.max(1, this.rows()) }, () => mark);
  }
}

function peekCopyLabel(view: WorkspaceView, inner: number): string | undefined {
  if (!view.filePath) return undefined;
  const preferred = view.id.startsWith("image:") ? COPY_PATH : COPY;
  const needed = (label: string) => label.length + 1 + CLEAR.length + 1;
  if (inner < needed(preferred) && preferred !== COPY) return COPY;
  return preferred;
}

function emptyTurnImpact(): TurnImpactSnapshot {
  return { revision: 0, toolsCalled: 0, events: [] };
}
