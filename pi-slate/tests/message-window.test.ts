import assert from "node:assert/strict";
import test from "node:test";
import { Container, ScrollView, Text, VStack } from "@earendil-works/pi-tui";
import { MESSAGE_LENGTH_DEFAULT } from "../extensions/pi-slate/layout.ts";
import { findChatContainer, MessageWindow } from "../extensions/pi-slate/message-window.ts";

test("message window keeps the newest messages and restores older ones", () => {
  const chat = new Container();
  const messages = Array.from({ length: 5 }, (_, i) => new Text(`m${i}`, 0, 0));
  for (const message of messages) chat.addChild(message);
  const window = new MessageWindow(chat, 3);
  assert.deepEqual(chat.children, messages.slice(2));
  window.setLimit(5);
  assert.deepEqual(chat.children, messages);
  const extra = new Text("m5", 0, 0);
  chat.addChild(extra);
  assert.deepEqual(chat.children, [...messages.slice(1), extra]);
  window.setLimit(Number.POSITIVE_INFINITY);
  assert.equal(chat.children.length, 6);
  window.dispose();
  chat.addChild(new Text("m6", 0, 0));
  assert.equal(chat.children.length, 7);
});

test("finder uses the last nested container inside the primary scroll view", () => {
  const header = new Container();
  const chat = new Container();
  chat.addChild(new Text("hello", 0, 0));
  const document = new Container();
  document.addChild(header);
  document.addChild(chat);
  const root = new VStack([
    { component: new ScrollView(document, { primary: true }), grow: 1 },
    new Text("editor", 0, 0),
  ]);
  assert.equal(findChatContainer(root), chat);
  assert.equal(findChatContainer(new VStack([new Container(), new Text("footer", 0, 0)])), undefined);
});

test("a live assistant row is not evicted by the next tool child", () => {
  const chat = new Container();
  const assistant = new Text("assistant", 0, 0);
  const tool = new Text("tool", 0, 0);
  chat.addChild(assistant);
  const window = new MessageWindow(chat, 1);
  chat.addChild(tool);
  assert.deepEqual(chat.children, [assistant, tool]);
  window.dispose();
});

test("default visible length stays synced at 100", () => {
  assert.equal(MESSAGE_LENGTH_DEFAULT, 100);
});

test("disposed wrappers retained by successors only delegate, without trimming", () => {
  const chat = new Container(); const items = Array.from({ length: 6 }, (_, i) => new Text(`m${i}`, 0, 0));
  items.slice(0, 3).forEach(item => chat.addChild(item));
  const window = new MessageWindow(chat, 1);
  const add = chat.addChild, remove = chat.removeChild, clear = chat.clear;
  const successorAdd = (item: Text) => add(item);
  chat.addChild = successorAdd; chat.removeChild = item => remove(item); chat.clear = () => clear();
  window.dispose(); window.dispose(); window.setLimit(0);
  assert.equal(chat.addChild, successorAdd);
  items.slice(3).forEach(item => chat.addChild(item)); assert.deepEqual(chat.children, items);
  chat.removeChild(items[1]!); assert.equal(chat.children.length, 5);
  chat.clear(); assert.equal(chat.children.length, 0);
  chat.addChild(items[0]!); assert.deepEqual(chat.children, [items[0]]);
});
