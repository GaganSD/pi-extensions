import {
  HStack,
  isViewportTUI,
  type Component,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
  SIDEBAR_MIN_WIDTH,
  workspaceColumnWidth,
} from "./layout.ts";

const SIDEBAR_SPLIT = Symbol.for("pi-slate.sidebar-split");
const ORIGINAL_SET_LAYOUT_ROOT = Symbol.for("pi-slate.setLayoutRoot");
const SPLIT_OWNER = Symbol.for("pi-slate.sidebar-split-owner");

type SplitHost<T> = {
  layoutRoot?: T;
  setLayoutRoot(component: T | undefined): void;
  [ORIGINAL_SET_LAYOUT_ROOT]?: (component: T | undefined) => void;
  [SPLIT_OWNER]?: object;
};

export function bindSplitHost<T>(
  host: SplitHost<T>,
  wrap: (component: T | undefined) => T | undefined,
  unwrap: (component: T | undefined) => T | undefined,
): () => void {
  const originalSet = host[ORIGINAL_SET_LAYOUT_ROOT] ?? host.setLayoutRoot.bind(host);
  const owner = {};
  host[ORIGINAL_SET_LAYOUT_ROOT] = originalSet;
  host[SPLIT_OWNER] = owner;
  const mounted = wrap(host.layoutRoot);
  const yieldRoot = (component: T | undefined): void => {
    // A later writer wins. Stop intercepting, rather than wrapping its root forever.
    if (host[SPLIT_OWNER] === owner) {
      if (host.setLayoutRoot === yieldRoot) host.setLayoutRoot = originalSet;
      delete host[ORIGINAL_SET_LAYOUT_ROOT];
      delete host[SPLIT_OWNER];
    }
    originalSet(component);
  };
  host.setLayoutRoot = yieldRoot;
  if (host.layoutRoot !== undefined) originalSet(mounted);

  return () => {
    if (host[SPLIT_OWNER] !== owner) return;
    if (host.setLayoutRoot === yieldRoot) host.setLayoutRoot = originalSet;
    delete host[ORIGINAL_SET_LAYOUT_ROOT];
    delete host[SPLIT_OWNER];
    if (host.layoutRoot === mounted) originalSet(unwrap(mounted));
  };
}

type SplitMousePane = Component & {
  handleSplitMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
};

export class SidebarSplit extends HStack {
  private readonly pane: SplitMousePane;
  private readonly originalChat: Component;
  private chatLease = 0;

  chat(): Component { return this.originalChat; }

  /** Lend only our owned main slot. Keep the original chat/editor objects alive. */
  replaceChat(view: Component): () => void {
    const entry = this.entries[0]!;
    if (entry.component !== this.originalChat) throw new Error("Slate conversation slot is already in use");
    const lease = ++this.chatLease;
    entry.component = view;
    this.children[0] = view;
    return () => {
      if (this.chatLease !== lease || entry.component !== view) return;
      entry.component = this.originalChat;
      this.children[0] = this.originalChat;
    };
  }

  override handleMouse(event: TuiMouseEvent) {
    const result = this.pane.handleSplitMouse?.(event);
    if (!result?.handled && !result?.capture && !result?.focus) return undefined;
    return {
      ...result,
      handled: true as const,
      target: {
        component: this,
        originX: event.screenX - event.x,
        originY: event.screenY - event.y,
        width: event.width,
        height: event.height,
      },
    };
  }

  constructor(chat: Component, pane: Component, preferredWidth?: () => number | undefined) {
    super([
      // Skip full-width intrinsic measurement: switching widths thrashes leaf render caches.
      { component: chat, basis: 0, grow: 1, shrink: 1, minSize: 1 },
      {
        component: pane,
        grow: 0,
        shrink: 0,
        minSize: SIDEBAR_MIN_WIDTH,
        basis: SIDEBAR_MIN_WIDTH,
        visible: (viewport) => {
          const width = workspaceColumnWidth(viewport.width, preferredWidth?.());
          const entry = this.entries[1];
          if (entry && entry.basis !== width) entry.basis = Math.max(SIDEBAR_MIN_WIDTH, width);
          return width > 0;
        },
      },
    ]);
    this.pane = pane;
    this.originalChat = chat;
    Object.assign(this, { [SIDEBAR_SPLIT]: true });
  }
}

function isSplit(component: Component | undefined): component is SidebarSplit {
  return Boolean(component && (component as { [SIDEBAR_SPLIT]?: boolean })[SIDEBAR_SPLIT]);
}

export function splitChat(component: Component | undefined): Component | undefined {
  if (!component) return undefined;
  if (!isSplit(component)) return component;
  return component.chat();
}

export type SidebarSplitLease = (() => void) & { replaceChat(view: Component): (() => void) | undefined; ownsFocus(component: Component): boolean };

export function installSidebarSplit(
  tui: TUI,
  pane: Component,
  preferredWidth?: () => number | undefined,
): SidebarSplitLease | undefined {
  if (!isViewportTUI(tui) || !(tui as TUI & { layoutRoot?: Component }).layoutRoot) return undefined;

  let split: SidebarSplit | undefined;
  const dispose = bindSplitHost(
    tui,
    (component) => {
      const chat = splitChat(component);
      if (chat) split = new SidebarSplit(chat, pane, preferredWidth);
      return split ?? component;
    },
    splitChat,
  );
  return Object.assign(dispose, {
    ownsFocus(component: Component) { return component === split && (tui as TUI & { layoutRoot?: Component }).layoutRoot === split; },
    replaceChat(view: Component) {
      // A later layout owner wins; never resurrect a stale slot.
      if (!split || (tui as TUI & { layoutRoot?: Component }).layoutRoot !== split) return undefined;
      return split.replaceChat(view);
    },
  });
}
