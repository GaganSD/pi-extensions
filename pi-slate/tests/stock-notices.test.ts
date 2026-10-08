import assert from "node:assert/strict";
import test from "node:test";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { MessageWindow } from "../extensions/pi-slate/message-window.ts";
import { sweepStockUpdateNotices } from "../extensions/pi-slate/stock-notices.ts";

class Hairline {
  invalidate(): void {}
  render(width: number): string[] {
    return ["─".repeat(Math.max(1, width))];
  }
}

function addPackageCard(chat: Container, name: string): void {
  chat.addChild(new Spacer(1));
  chat.addChild(new Hairline());
  chat.addChild(new Text(
    `Package Updates Available\nPackage updates are available. Run pi update --extensions\nPackages:\n- ${name}`,
    1,
    0,
  ));
  chat.addChild(new Hairline());
}

function addPiCard(chat: Container, version: string): void {
  chat.addChild(new Spacer(1));
  chat.addChild(new Hairline());
  chat.addChild(new Text(
    `Update Available\nNew version ${version} is available. Run pi update`,
    1,
    0,
  ));
  chat.addChild(new Text("Changelog: https://pi.dev/changelog", 1, 0));
  chat.addChild(new Hairline());
}

test("sweeps complete package and pi update cards, waits for the closing rule", () => {
  const chat = new Container();
  const keep = new Text("hello", 0, 0);
  chat.addChild(keep);
  chat.addChild(new Spacer(1));
  chat.addChild(new Hairline());
  chat.addChild(new Text("Package Updates Available\nRun pi update --extensions", 1, 0));
  assert.equal(chat.children.length, 4);
  assert.equal(sweepStockUpdateNotices(chat), false);
  chat.addChild(new Hairline());
  assert.equal(sweepStockUpdateNotices(chat), true);
  assert.deepEqual(chat.children, [keep]);

  addPiCard(chat, "0.99.2");
  assert.equal(sweepStockUpdateNotices(chat), true);
  assert.deepEqual(chat.children, [keep]);
});

test("message window preserves stock notices as they are added",  () => {
  const chat = new Container();
  const keep = new Text("user", 0, 0);
  chat.addChild(keep);
  const window = new MessageWindow(chat, 100);
  addPackageCard(chat, "@dev.fast/pi-whiteboard");
  addPiCard(chat, "0.99.2");
  const all = [...chat.children];
  assert.equal(all.length, 10);
  assert.equal(all[0], keep);
  window.dispose();
  assert.deepEqual(chat.children, all);
});

test("does not remove ordinary chat that mentions updates", () => {
  const chat = new Container();
  const note = new Text("I saw an Update Available banner yesterday", 0, 0);
  chat.addChild(note);
  assert.equal(sweepStockUpdateNotices(chat), false);
  assert.deepEqual(chat.children, [note]);
});
