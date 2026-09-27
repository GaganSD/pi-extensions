import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Text,
  TuiAltScreen,
  type OverlayHandle,
  type OverlayOptions,
  type TUI,
  type Terminal,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { isSidebarResizeHandle, percentFromColumns, sidebarWidthFromScreenX, workspaceColumnWidth } from "../extensions/pi-slate/layout.ts";
import { Sidebar } from "../extensions/pi-slate/sidebar.ts";
import type { FileChange } from "../extensions/pi-slate/files-modified.ts";

function theme(): Theme {
  return {
    fg: (color, text) => `[${color}]${text}`,
    bold: (text) => text,
  } as Theme;
}

function mouse(partial: Partial<TuiMouseEvent> & Pick<TuiMouseEvent, "type">): TuiMouseEvent {
  return {
    button: "left",
    x: 0,
    y: 3,
    screenX: 112,
    screenY: 3,
    width: 28,
    height: 24,
    shift: false,
    alt: false,
    ctrl: false,
    ...partial,
  };
}

function attachSidebar(columns = 140) {
  const overlays: OverlayOptions[] = [];
  const hidden: OverlayHandle[] = [];
  const sidebar = new Sidebar();
  const tui = {
    terminal: { rows: 24, columns },
    requestRender() {},
    showOverlay(_component: unknown, options: OverlayOptions) {
      overlays.push(options);
      const handle = {
        hide() {
          hidden.push(handle);
        },
      } as OverlayHandle;
      return handle;
    },
  } as unknown as TUI;
  sidebar.attach(tui, theme());
  return { sidebar, overlays, hidden, tui };
}

test("the resize handle is the sidebar gutter, not file rows", () => {
  assert.equal(isSidebarResizeHandle({ button: "left", x: 0 }), true);
  assert.equal(isSidebarResizeHandle({ button: "left", x: 1 }), true);
  assert.equal(isSidebarResizeHandle({ button: "left", x: 2 }), false);
  assert.equal(isSidebarResizeHandle({ button: "right", x: 0 }), false);
});

test("dragging the gutter moves a ghost guide and only commits width on release", () => {
  const { sidebar, overlays, hidden } = attachSidebar();
  const persisted: number[] = [];
  sidebar.setActions({
    copy() {},
    openFile() {},
    selectFile() {},
    persistWidth: (columns) => {
      if (columns !== undefined) persisted.push(columns);
    },
  });
  sidebar.render(28);
  assert.equal(overlays[0]?.width, 28);

  assert.deepEqual(sidebar.handleMouse(mouse({ type: "press", screenX: 112 })), {
    handled: true,
    capture: true,
    render: true,
  });
  assert.equal(sidebar.preferredWidth, undefined);
  assert.equal(persisted.length, 0);
  assert.equal(overlays[0]?.width, 28);
  assert.equal(overlays.at(-1)?.col, 112);

  assert.deepEqual(sidebar.handleMouse(mouse({ type: "drag", x: -20, screenX: 92 })), {
    handled: true,
    render: true,
  });
  assert.equal(sidebar.preferredWidth, undefined);
  assert.equal(persisted.length, 0);
  assert.equal(overlays[0]?.width, 28);
  assert.equal(overlays.at(-1)?.col, 92);

  assert.deepEqual(sidebar.handleMouse(mouse({ type: "release", x: -20, screenX: 92 })), {
    handled: true,
    render: true,
  });
  assert.equal(sidebar.preferredWidth, percentFromColumns(140, sidebarWidthFromScreenX(140, 92)));
  assert.deepEqual(persisted, [sidebar.preferredWidth]);
  assert.equal(hidden.length, 1);
});

test("releasing the gutter on the current width does not persist", () => {
  const { sidebar } = attachSidebar();
  const persisted: number[] = [];
  sidebar.setActions({
    copy() {},
    openFile() {},
    selectFile() {},
    persistWidth: (columns) => {
      if (columns !== undefined) persisted.push(columns);
    },
  });
  sidebar.handleMouse(mouse({ type: "press", screenX: 112 }));
  sidebar.handleMouse(mouse({ type: "release", screenX: 112 }));
  assert.equal(sidebar.preferredWidth, undefined);
  assert.deepEqual(persisted, []);
});

test("a stationary press on the inner handle column does not persist", () => {
  const { sidebar, overlays } = attachSidebar();
  const persisted: number[] = [];
  sidebar.setPreferredWidth(29);
  sidebar.setActions({
    copy() {},
    openFile() {},
    selectFile() {},
    persistWidth: (columns) => {
      if (columns !== undefined) persisted.push(columns);
    },
  });
  sidebar.render(workspaceColumnWidth(140, 29));
  assert.equal(overlays[0]?.width, workspaceColumnWidth(140, 29));
  sidebar.handleMouse(mouse({ type: "press", x: 1, screenX: 101 }));
  assert.equal(overlays.at(-1)?.col, 100);
  sidebar.handleMouse(mouse({ type: "release", x: 1, screenX: 101 }));
  assert.equal(sidebar.preferredWidth, 29);
  assert.deepEqual(persisted, []);
});

test("clicking the gutter does not select a changed file", () => {
  const { sidebar } = attachSidebar();
  const selected: FileChange[] = [];
  sidebar.setActions({
    copy() {},
    openFile() {},
    selectFile: (file) => selected.push(file),
  });
  sidebar.setFiles([{ index: " ", worktree: "M", path: "src/a.ts" }]);
  sidebar.render(40);
  assert.deepEqual(sidebar.handleMouse(mouse({ type: "click", x: 0, y: 3 })), { handled: true });
  assert.deepEqual(selected, []);
});

class MouseTerminal implements Terminal {
  columns = 140;
  rows = 24;
  kittyProtocolActive = false;
  private input?: (data: string) => void;
  start(input: (data: string) => void): void {
    this.input = input;
  }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(_data: string): void {}
  moveBy(_lines: number): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(_title: string): void {}
  setProgress(_active: boolean): void {}
  send(data: string): void {
    this.input?.(data);
  }
}

function sgr(button: number, x: number, y: number, release = false): string {
  return `\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`;
}

test("fullscreen mouse drag from the chat side of the divider commits once", (t) => {
  const terminal = new MouseTerminal();
  const tui = new TuiAltScreen(terminal);
  const sidebar = new Sidebar();
  const persisted: number[] = [];
  tui.setLayoutRoot(new Text("chat", 0, 0));
  sidebar.attach(tui, theme());
  sidebar.setActions({
    copy() {},
    openFile() {},
    selectFile() {},
    persistWidth: (columns) => {
      if (columns !== undefined) persisted.push(columns);
    },
  });
  t.after(() => {
    tui.stop({ preserveScreen: true });
    sidebar.dispose();
  });
  tui.start();
  tui.renderNow();
  assert.equal(sidebar.splitActive, true);

  const divider = terminal.columns - workspaceColumnWidth(terminal.columns);
  terminal.send(sgr(0, divider - 1, 2));
  terminal.send(sgr(32, divider - 21, 2));
  terminal.send(sgr(0, divider - 21, 2, true));
  tui.renderNow();

  assert.equal(
    sidebar.preferredWidth,
    percentFromColumns(terminal.columns, workspaceColumnWidth(terminal.columns) + 20),
  );
  assert.deepEqual(persisted, [sidebar.preferredWidth]);
});
