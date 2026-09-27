import { Container, ScrollView, isViewportTUI, type Component, type TUI } from "@earendil-works/pi-tui";

export function childComponents(component: Component): Component[] {
  const stack = component as { entries?: Array<{ component?: Component }> };
  if (Array.isArray(stack.entries) && stack.entries.some((entry) => entry?.component)) {
    return stack.entries.flatMap((entry) => (entry.component ? [entry.component] : []));
  }
  const container = component as Container;
  return Array.isArray(container.children) ? container.children : [];
}

export function findPrimaryScrollView(root: Component): ScrollView | undefined {
  const seen = new Set<Component>();
  const queue = [root];
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node || seen.has(node)) continue;
    seen.add(node);
    if (node instanceof ScrollView && node.primary) return node;
    queue.push(...childComponents(node));
  }
  return undefined;
}

export function findChatContainer(root: Component | undefined): Container | undefined {
  if (!root) return undefined;
  const scroll = findPrimaryScrollView(root);
  if (!scroll) return undefined;
  const content = childComponents(scroll)[0];
  if (!content || typeof (content as Container).addChild !== "function") return undefined;
  const nested = childComponents(content).filter((child) => (
    child instanceof Container && !(child instanceof ScrollView)
  ));
  const chat = nested.at(-1) ?? content;
  return typeof (chat as Container).addChild === "function" ? chat as Container : undefined;
}

export function layoutRootOf(tui: TUI | undefined): Component | undefined {
  if (!tui || !isViewportTUI(tui)) return undefined;
  return (tui as TUI & { layoutRoot?: Component }).layoutRoot;
}

export class MessageWindow {
  readonly container: Container;
  private readonly addChild: (component: Component) => void;
  private readonly removeChild: (component: Component) => void;
  private readonly clear: () => void;
  private hidden: Component[] = [];
  private pinned?: Component;
  private limit: number;

  constructor(container: Container, limit: number) {
    this.container = container;
    this.limit = limit;
    this.addChild = container.addChild.bind(container);
    this.removeChild = container.removeChild.bind(container);
    this.clear = container.clear.bind(container);
    container.addChild = (component) => {
      this.pinned = this.container.children.at(-1);
      this.addChild(component);
      this.trim();
    };
    container.removeChild = (component) => {
      const index = this.hidden.indexOf(component);
      if (index >= 0) this.hidden.splice(index, 1);
      if (this.pinned === component) this.pinned = undefined;
      this.removeChild(component);
    };
    container.clear = () => {
      this.hidden = [];
      this.pinned = undefined;
      this.clear();
    };
    this.trim();
  }

  setLimit(limit: number): void {
    if (this.limit === limit) return;
    this.limit = limit;
    this.reveal();
    this.trim();
  }

  dispose(): void {
    this.reveal();
    this.container.addChild = this.addChild;
    this.container.removeChild = this.removeChild;
    this.container.clear = this.clear;
  }

  private reveal(): void {
    if (this.hidden.length === 0) return;
    this.container.children.unshift(...this.hidden);
    this.hidden = [];
  }

  private trim(): void {
    if (!Number.isFinite(this.limit)) return;
    const keep = Math.max(0, Math.floor(this.limit));
    while (this.container.children.length > keep) {
      const oldest = this.container.children[0];
      if (!oldest || oldest === this.pinned) return;
      this.removeChild(oldest);
      this.hidden.push(oldest);
    }
  }
}

export function syncMessageWindow(
  current: MessageWindow | undefined,
  tui: TUI | undefined,
  limit: number,
): MessageWindow | undefined {
  const chat = findChatContainer(layoutRootOf(tui));
  if (!chat) return current;
  if (current?.container === chat) {
    current.setLimit(limit);
    return current;
  }
  current?.dispose();
  return new MessageWindow(chat, limit);
}
