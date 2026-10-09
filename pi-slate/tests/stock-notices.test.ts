import assert from "node:assert/strict";
import test from "node:test";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { MessageWindow } from "../extensions/pi-slate/message-window.ts";
import {
  installNewSessionNoticeFilter,
  isStockNewSessionNotice,
  renderedPlain,
  sweepStockUpdateNotices,
} from "../extensions/pi-slate/stock-notices.ts";

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

// Core handleClearCommand adds Spacer(1) then ThemedText themed via accent.
function addStockNewSessionBanner(chat: Container): void {
  chat.addChild(new Spacer(1));
  chat.addChild(new Text("\x1b[38;5;1m✓ New session started\x1b[0m", 1, 1));
}

test("matches the stock new-session notice but not ordinary chat", () => {
  assert.equal(isStockNewSessionNotice(new Text("\x1b[38;5;1m✓ New session started\x1b[0m", 1, 1)), true);
  assert.equal(isStockNewSessionNotice(new Text("✓ New session started", 0, 0)), true);
  assert.equal(isStockNewSessionNotice(new Text("I typed ✓ New session started myself", 0, 0)), false);
  assert.equal(isStockNewSessionNotice(new Text("New session started", 0, 0)), false);
  assert.equal(isStockNewSessionNotice(new Spacer(1)), false);
});

test("filter suppresses the stock new-session banner and its padding spacer", () => {
  const chat = new Container();
  const keep = new Text("hello", 0, 0);
  chat.addChild(keep);
  installNewSessionNoticeFilter(chat);
  addStockNewSessionBanner(chat);
  assert.deepEqual(chat.children, [keep]);
  // A banner without its spacer is rejected without touching neighbors.
  chat.addChild(new Text("✓ New session started", 1, 1));
  assert.deepEqual(chat.children, [keep]);
});

test("filter keeps unrelated text and update cards, and installs once", () => {
  const chat = new Container();
  installNewSessionNoticeFilter(chat);
  const wrapped = chat.addChild;
  installNewSessionNoticeFilter(chat);
  assert.equal(chat.addChild, wrapped);
  const mention = new Text("notes about ✓ New session started", 0, 0);
  chat.addChild(mention);
  addPiCard(chat, "0.99.2");
  assert.equal(chat.children.length, 6);
  assert.equal(chat.children[0], mention);
  assert.match(chat.children.map((child) => renderedPlain(child)).join("\n"), /Update Available/);
});

test("filter composes with the message window in either install order", () => {
  // Filter first, then MessageWindow wraps it.
  const first = new Container();
  installNewSessionNoticeFilter(first);
  const window = new MessageWindow(first, 100);
  addStockNewSessionBanner(first);
  const reply = new Text("answer", 0, 0);
  first.addChild(reply);
  assert.deepEqual(first.children, [reply]);
  window.dispose();
  // The filter survives MessageWindow disposal.
  addStockNewSessionBanner(first);
  assert.deepEqual(first.children, [reply]);

  // MessageWindow first, then the filter wraps it.
  const second = new Container();
  const early = new MessageWindow(second, 100);
  installNewSessionNoticeFilter(second);
  addStockNewSessionBanner(second);
  const other = new Text("user", 0, 0);
  second.addChild(other);
  assert.deepEqual(second.children, [other]);
  early.dispose();
});
