import assert from "node:assert/strict";
import test from "node:test";
import { bindSplitHost } from "../extensions/pi-slate/sidebar-split.ts";

type Node = { id: string; child?: Node };

function wrap(pane: string) {
  return (component: Node | undefined): Node | undefined => {
    if (!component) return component;
    const chat = component.child ?? component;
    return { id: pane, child: chat.id === "chat" ? chat : component.child };
  };
}

function unwrap(component: Node | undefined): Node | undefined {
  return component?.child ?? component;
}

function createHost(chat: Node) {
  return {
    layoutRoot: chat as Node | undefined,
    setLayoutRoot(component: Node | undefined) {
      this.layoutRoot = component;
    },
  };
}

test("a later /new remounts the split onto the live pane", () => {
  const chat = { id: "chat" };
  const host = createHost(chat);

  const staleDispose = bindSplitHost(host, wrap("stale"), unwrap);
  assert.equal(host.layoutRoot?.id, "stale");
  assert.equal(host.layoutRoot?.child, chat);

  const liveDispose = bindSplitHost(host, wrap("live"), unwrap);
  assert.equal(host.layoutRoot?.id, "live");
  assert.equal(host.layoutRoot?.child, chat);

  staleDispose();
  assert.equal(host.layoutRoot?.id, "live");
  assert.equal(host.layoutRoot?.child, chat);

  liveDispose();
  assert.equal(host.layoutRoot, chat);
});

test("disposing the current split unwraps the original chat root", () => {
  const chat = { id: "chat" };
  const host = createHost(chat);
  const dispose = bindSplitHost(host, wrap("pane"), unwrap);
  assert.notEqual(host.layoutRoot, chat);
  dispose();
  assert.equal(host.layoutRoot, chat);
});
