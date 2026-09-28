import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { CustomEditor, ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { installImagePlaceholders } from "../extensions/pi-slate/image-placeholders.ts";
import { ImagePeek } from "../extensions/pi-slate/image-peek.ts";
import {
  formatImageLocation,
  imageTokenAtCursor,
  mimeTypeForImagePath,
  nextImageNumber,
  rewriteClipboardPaths,
  transformSubmittedText,
  type ImageAttachment,
} from "../extensions/pi-slate/placeholders.ts";
import { Sidebar } from "../extensions/pi-slate/sidebar.ts";

const fixtures = mkdtempSync(join(tmpdir(), "pi-slate-images-"));
test.after(() => rmSync(fixtures, { force: true, recursive: true }));

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const OTHER_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

function image(name: string, content: string | Buffer = PNG): string {
  const filePath = join(fixtures, name);
  writeFileSync(filePath, content);
  return filePath;
}

function fakeImage(filePath: string): ImageAttachment {
  return { type: "image", data: `data:${filePath}`, mimeType: mimeTypeForImagePath(filePath) };
}

function loadFixture(filePath: string): ImageAttachment | undefined {
  try {
    return { type: "image", data: readFileSync(filePath).toString("base64"), mimeType: mimeTypeForImagePath(filePath) };
  } catch {
    return undefined;
  }
}

function theme(): Theme {
  return { fg: (_color, text) => text, bold: (text) => text } as Theme;
}

function attachSidebar(): Sidebar {
  const sidebar = new Sidebar();
  sidebar.attach({
    terminal: { columns: 80, rows: 24 },
    requestRender() {},
    showOverlay() { return { hide() {} }; },
  } as unknown as TUI, theme());
  return sidebar;
}

test("numbers placeholders from existing editor text", () => {
  assert.equal(nextImageNumber(""), 1);
  assert.equal(nextImageNumber("see [image 1] and [image-3]"), 4);
});

test("rewrites verified clipboard paths and leaves ordinary text alone", () => {
  const first = image("clipboard.png");
  const second = image("clipboard.jpg");
  const store = new Map<string, string>();
  assert.equal(rewriteClipboardPaths(first, nextImageNumber(""), store), "[image-1]");
  assert.equal(store.get("1"), first);
  assert.equal(rewriteClipboardPaths(second, nextImageNumber("look at [image-1]\n"), store), "[image-2]");
  assert.equal(store.get("2"), second);
  assert.equal(rewriteClipboardPaths("hello", 3, store), "hello");
});

test("preserves literal percent paths before trying one decoded bare-path candidate", () => {
  const literal = image("Screen%20Shot.png", PNG);
  const decoded = image("Screen Shot.png", OTHER_PNG);
  const encodedOnly = image("Encoded Only.png", "encoded-only");
  const store = new Map<string, string>();

  assert.equal(rewriteClipboardPaths(literal, 1, store), "[image-1]");
  assert.equal(store.get("1"), literal);
  assert.equal(rewriteClipboardPaths(encodedOnly.replace(" ", "%20"), 2, store), "[image-2]");
  assert.equal(store.get("2"), encodedOnly);
  assert.equal(rewriteClipboardPaths(pathToFileURL(decoded).href, 3, store), "[image-3]");
  assert.equal(store.get("3"), decoded);

  for (const input of ["[image-1]", literal, `see ${literal}`]) {
    const result = transformSubmittedText(input, store, loadFixture);
    assert.equal(result.images[0]?.data, PNG.toString("base64"));
  }
  const literalOnly = image("Literal%20Only.png");
  assert.equal(rewriteClipboardPaths(literalOnly, 4, store), "[image-4]");
  assert.equal(store.get("4"), literalOnly);
});

test("decodes file URLs once and keeps malformed or literal percent filenames", () => {
  const percentName = image("already%20encoded.png");
  const unicode = image("café image.png");
  const malformed = image("bad%ZZ.png");
  const store = new Map<string, string>();

  assert.equal(rewriteClipboardPaths(pathToFileURL(percentName).href, 1, store), "[image-1]");
  assert.equal(store.get("1"), percentName);
  assert.equal(rewriteClipboardPaths(pathToFileURL(unicode).href, 2, store), "[image-2]");
  assert.equal(store.get("2"), unicode);
  assert.equal(rewriteClipboardPaths(malformed, 3, store), "[image-3]");
  assert.equal(store.get("3"), malformed);
  assert.equal(rewriteClipboardPaths(`file://${fixtures}/bad%ZZ.png`, 4, store), `file://${fixtures}/bad%ZZ.png`);
});

test("rewrites escaped and quoted paths inside text without treating HTTP URLs as files", () => {
  const spaced = image("Screenshot 2026-03-22 at 4.12.00 PM.png");
  const other = image("second.jpeg");
  const escaped = spaced.replace(/ /g, "\\ ");
  const store = new Map<string, string>();

  assert.equal(rewriteClipboardPaths(`see ${escaped} and \`${other}\``, 1, store), "see [image-1] and [image-2]");
  assert.equal(store.get("1"), spaced);
  assert.equal(store.get("2"), other);
  assert.equal(rewriteClipboardPaths(`"${spaced}" '${other}'`, 3, store), "[image-3] [image-4]");
  assert.equal(rewriteClipboardPaths("see https://example.test/image.png", 5, store), "see https://example.test/image.png");
});

test("does not attach local files hidden inside URLs or longer path names", () => {
  const filePath = image("url-target.png");
  for (const input of [
    `https://example.test${filePath}`,
    `see https://example.test${filePath}`,
    `ftp://example.test${filePath}`,
    `relative${filePath}`,
    `${filePath}/extra`,
    `${filePath}.bak`,
    `${filePath}2`,
  ]) {
    const store = new Map<string, string>();
    assert.equal(rewriteClipboardPaths(input, 1, store), input);
    assert.equal(store.size, 0);
    assert.deepEqual(transformSubmittedText(input, store, loadFixture), { text: input, images: [] });
  }
});

test("attaches sentence-final paths without accepting longer filename extensions", () => {
  const filePath = image("sentence.png");
  for (const suffix of [".", ". Next sentence", ".\nNext paragraph"]) {
    const input = `See ${filePath}${suffix}`;
    assert.equal(rewriteClipboardPaths(input, 1, new Map()), `See [image-1]${suffix}`);
    assert.deepEqual(transformSubmittedText(input, new Map(), loadFixture), {
      text: `See [image-1]${suffix}`, images: [loadFixture(filePath)],
    });
  }
  assert.equal(rewriteClipboardPaths(`See ${filePath}.bak`, 1, new Map()), `See ${filePath}.bak`);
});

test("recognizes file URLs and escaped paths in every supported wrapper", () => {
  const filePath = image("wrapped image.png");
  for (const spelling of [filePath, filePath.replace(/ /g, "\\ "), pathToFileURL(filePath).href]) {
    for (const quote of ['"', "'", "`"]) {
      const input = `see ${quote}${spelling}${quote} here`;
      const store = new Map<string, string>();
      assert.equal(rewriteClipboardPaths(input, 1, store), "see [image-1] here");
      assert.equal(store.get("1"), filePath);
      assert.deepEqual(transformSubmittedText(input, new Map(), loadFixture), {
        text: "see [image-1] here", images: [loadFixture(filePath)],
      });
    }
  }
});

test("does not substitute a decoded sibling for an existing unusable literal path", () => {
  const literal = join(fixtures, "directory%20image.png");
  mkdirSync(literal);
  image("directory image.png");
  assert.equal(rewriteClipboardPaths(literal, 1, new Map()), literal);
  assert.deepEqual(transformSubmittedText(literal, new Map(), loadFixture), { text: literal, images: [] });

  const unreadable = image("unreadable%20image.png");
  image("unreadable image.png");
  chmodSync(unreadable, 0);
  try {
    // An injected failure is deterministic even when the tests run as root.
    assert.deepEqual(transformSubmittedText(unreadable, new Map(), () => undefined), { text: unreadable, images: [] });
    const loaded: string[] = [];
    transformSubmittedText(unreadable, new Map(), (candidate) => {
      loaded.push(candidate);
      return candidate === unreadable ? undefined : loadFixture(candidate);
    });
    assert.ok(loaded.every((candidate) => candidate === unreadable));
  } finally {
    chmodSync(unreadable, 0o600);
  }
});

test("does not replace missing, directory, or longer non-image path candidates", () => {
  const prefix = image("photo.png");
  const directory = join(fixtures, "folder.png");
  mkdirSync(directory);
  const store = new Map<string, string>();
  const missing = join(fixtures, "missing.png");

  assert.equal(rewriteClipboardPaths(missing, 1, store), missing);
  assert.equal(rewriteClipboardPaths(directory, 1, store), directory);
  assert.equal(rewriteClipboardPaths(`${prefix}.bak`, 1, store), `${prefix}.bak`);
  assert.equal(store.size, 0);
  const submitted = transformSubmittedText(directory, store, () => undefined);
  assert.equal(submitted.text, directory);
  assert.deepEqual(submitted.images, []);
});

test("attaches mapped images and rewrites verified leftover paths on submit", () => {
  const first = image("first.png");
  const second = image("second.jpg");
  const third = image("third.webp");
  const store = new Map<string, string>([["1", first]]);
  const result = transformSubmittedText(
    `compare [image-1] with ${second} and ${third}`,
    store,
    fakeImage,
  );
  assert.equal(result.text, "compare [image-1] with [image-2] and [image-3]");
  assert.deepEqual(result.images, [fakeImage(first), fakeImage(second), fakeImage(third)]);
  assert.equal(store.get("2"), second);
  assert.equal(store.get("3"), third);
});

test("submits multiple raw paths and reuses tokens without losing their brackets", () => {
  const first = image("raw-first.png");
  const second = image("raw-second.png", OTHER_PNG);
  for (const separator of [" ", "\n"]) {
    const result = transformSubmittedText(`${first}${separator}${second}`, new Map(), loadFixture);
    assert.equal(result.text, `[image-1]${separator}[image-2]`);
    assert.deepEqual(result.images, [loadFixture(first), loadFixture(second)]);
  }
  const store = new Map([["1", first], ["2", second]]);
  const repeated = transformSubmittedText(`${second} ${first} ${second}`, store, loadFixture);
  assert.equal(repeated.text, "[image-1] [image-2] [image-1]");
  assert.deepEqual(repeated.images, [loadFixture(second), loadFixture(first)]);
  assert.equal(store.get("1"), second);
  assert.equal(store.get("2"), first);
  assert.equal(transformSubmittedText(first, new Map([["1", first]]), loadFixture).text, "[image-1]");
});

test("matches repeated clipboard images by bytes and refreshes/disposes the active preview", (t) => {
  const stored = image("stored-screenshot.png", PNG);
  const sameBytes = image("same-screenshot-copy.png", PNG);
  const differentBytes = image("different-screenshot.png", OTHER_PNG);
  const editor = new Editor({} as TUI, {} as EditorTheme);
  const sidebar = attachSidebar();
  const pi = { on() {}, registerMarkdownTransformer() {} } as unknown as ExtensionAPI;
  const placeholders = installImagePlaceholders(pi, sidebar);
  placeholders.attachEditor(editor as unknown as CustomEditor);
  t.after(() => placeholders.dispose());

  editor.insertTextAtCursor(stored);
  assert.equal(editor.getText(), "[image-1]");
  assert.equal(placeholders.matchesImage("1", sameBytes), true);
  assert.equal(placeholders.matchesImage("1", differentBytes), false);
  assert.equal(placeholders.matchesImage("1", join(fixtures, "missing.png")), false);
  assert.equal(sidebar.currentViewId(), `image:1:${stored}`);

  placeholders.detachEditor();
  assert.equal(sidebar.currentViewId(), undefined);
  placeholders.attachEditor(editor as unknown as CustomEditor);
  editor.setText("[image-1]");
  placeholders.refreshEditor();
  assert.equal(sidebar.currentViewId(), `image:1:${stored}`);
});

test("rejects nonregular clipboard image candidates without blocking", (t) => {
  const devicePath = "/dev/zero";
  if (!existsSync(devicePath)) {
    t.skip("requires a Unix character device for the bounded read guard");
    return;
  }
  const stored = image("nonregular-stored.png", PNG);
  const imagePlaceholdersUrl = new URL("../extensions/pi-slate/image-placeholders.ts", import.meta.url).href;
  const source = `
    import { Editor } from "@earendil-works/pi-tui";
    import { installImagePlaceholders } from ${JSON.stringify(imagePlaceholdersUrl)};
    const placeholders = installImagePlaceholders({ on() {}, registerMarkdownTransformer() {} }, {});
    const editor = new Editor({}, {});
    editor.insertTextAtCursor(process.argv[1]);
    const result = placeholders.matchesImage("1", process.argv[2]);
    placeholders.dispose();
    process.stdout.write(String(result));
  `;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source, stored, devicePath], {
    encoding: "utf8",
    timeout: 2000,
  });
  assert.equal(result.error, undefined, result.error?.message ?? "");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "false");
});

test("uses one verified path through editor insertion, preview, and submission", async (t) => {
  const filePath = image("integration%20image.png", PNG);
  image("integration image.png", OTHER_PNG);
  const editor = new Editor({} as TUI, {} as EditorTheme);
  const sidebar = attachSidebar();
  let inputHandler: ((event: { text: string; images?: ImageAttachment[] }) => Promise<unknown> | unknown) | undefined;
  const pi = {
    on(event: string, handler: typeof inputHandler) {
      if (event === "input") inputHandler = handler;
    },
    registerMarkdownTransformer() {},
  } as unknown as ExtensionAPI;
  const placeholders = installImagePlaceholders(pi, sidebar);
  placeholders.attachEditor(editor as unknown as CustomEditor);
  t.after(() => placeholders.dispose());

  editor.insertTextAtCursor(filePath);
  assert.equal(editor.getText(), "[image-1]");
  assert.equal(sidebar.currentViewId(), `image:1:${filePath}`);

  const result = await inputHandler?.({ text: editor.getText() });
  assert.deepEqual(result, {
    action: "transform",
    text: "[image-1]",
    images: [{
      type: "image",
      data: PNG.toString("base64"),
      mimeType: "image/png",
    }],
  });

  // The original macOS-style drop also works through the real paste handler.
  const screenshot = image("Screenshot 2026-09-08 at 14.02.06.jpeg");
  editor.setText("");
  editor.handleInput(`\x1b[200~see ${screenshot.replace(/ /g, "\\ ")}\x1b[201~`);
  assert.equal(editor.getText(), "see [image-1]");
  assert.equal(sidebar.currentViewId(), `image:1:${screenshot}`);
  const pasted = await inputHandler?.({ text: editor.getText() });
  assert.deepEqual(pasted, { action: "transform", text: "see [image-1]", images: [loadFixture(screenshot)] });

  // Files removed after tokenization must not crash the production loader.
  rmSync(screenshot);
  assert.deepEqual(await inputHandler?.({ text: editor.getText() }), { action: "continue" });
});

test("waits for complete character-by-character drops", async (t) => {
  const prefix = image("typed.png");
  const editor = new Editor({} as TUI, {} as EditorTheme);
  const sidebar = attachSidebar();
  const pi = { on() {}, registerMarkdownTransformer() {} } as unknown as ExtensionAPI;
  const placeholders = installImagePlaceholders(pi, sidebar);
  placeholders.attachEditor(editor as unknown as CustomEditor);
  t.after(() => placeholders.dispose());

  for (const char of `${prefix}.bak`) editor.handleInput(char);
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(editor.getText(), `${prefix}.bak`);
  assert.equal(sidebar.currentViewId(), undefined);

  editor.setText("");
  for (const char of prefix) editor.handleInput(char);
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(editor.getText(), "[image-1]");
  assert.equal(sidebar.currentViewId(), `image:1:${prefix}`);

});

test("keeps collapsed paste contents when a screenshot arrives as characters", async (t) => {
  const filePath = image("with-stacktrace.png");
  const editor = new Editor({} as TUI, {} as EditorTheme);
  const store = new Map<string, string>();
  const peek = new ImagePeek(store, editor as unknown as CustomEditor, attachSidebar(), loadFixture);
  t.after(() => peek.dispose());
  const pasted = "stack trace line\n".repeat(20);
  editor.handleInput(`\x1b[200~${pasted}\x1b[201~`);
  assert.match(editor.getText(), /^\[paste #/);
  for (const char of ` ${filePath}`) editor.handleInput(char);
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(editor.getExpandedText(), `${pasted} ${filePath}`);

  let submitted = "";
  editor.onSubmit = (text) => { submitted = text; };
  editor.handleInput("\r");
  assert.equal(submitted, `${pasted} ${filePath}`);
  assert.deepEqual(transformSubmittedText(submitted, store, loadFixture), {
    text: `${pasted} [image-1]`, images: [loadFixture(filePath)],
  });
});

test("history navigation keeps the draft and does not schedule a rewrite", async (t) => {
  const filePath = image("history.png");
  const editor = new Editor({} as TUI, {} as EditorTheme);
  editor.addToHistory(`${filePath} please review`);
  editor.setText("my unsent draft");
  const peek = new ImagePeek(new Map(), editor as unknown as CustomEditor, attachSidebar(), loadFixture);
  t.after(() => peek.dispose());
  editor.handleInput("\x01");
  editor.handleInput("\x1b[A");
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(editor.getText(), `${filePath} please review`);
  editor.handleInput("\x05");
  editor.handleInput("\x1b[B");
  assert.equal(editor.getText(), "my unsent draft");
});

test("editing away from the end and navigating during a drop preserve the caret", async (t) => {
  const filePath = image("caret.png");
  const editor = new Editor({} as TUI, {} as EditorTheme);
  editor.setText(`check ${filePath} tomorrow`);
  const peek = new ImagePeek(new Map(), editor as unknown as CustomEditor, attachSidebar(), loadFixture);
  t.after(() => peek.dispose());
  editor.handleInput("\x01");
  editor.handleInput("X");
  peek.rewrite();
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(editor.getText(), `Xcheck ${filePath} tomorrow`);
  assert.deepEqual(editor.getCursor(), { line: 0, col: 1 });

  editor.setText("");
  for (const char of filePath) editor.handleInput(char);
  editor.handleInput("\x01");
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(editor.getText(), filePath);
  assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
});

test("does not emit legacy rewrite notices during ordinary typing or navigation", async (t) => {
  const editor = new Editor({} as TUI, {} as EditorTheme);
  const sidebar = attachSidebar();
  const pi = { on() {}, registerMarkdownTransformer() {} } as unknown as ExtensionAPI;
  const notices: string[] = [];
  // Exercise the former callback argument to make this fail on the merged PR.
  const placeholders = Reflect.apply(installImagePlaceholders, undefined, [
    pi, sidebar, (notice: string) => notices.push(notice),
  ]) as ReturnType<typeof installImagePlaceholders>;
  placeholders.attachEditor(editor as unknown as CustomEditor);
  t.after(() => placeholders.dispose());

  for (const char of "ordinary typing without an image") editor.handleInput(char);
  for (let i = 0; i < 20; i += 1) editor.handleInput("\x1b[D");
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(editor.getText(), "ordinary typing without an image");
  assert.equal(sidebar.currentViewId(), undefined);
  assert.deepEqual(notices, []);
});

test("formats clipboard image location details", () => {
  const path = "/var/folders/T/pi-clipboard-a.png";
  const location = formatImageLocation(path, "/Users/gagan", "1");
  assert.equal(location.name, "image-1.png");
  assert.equal(location.directory, "/var/folders/T");
  assert.equal(location.kind, "PNG");
  assert.equal(location.source, "Clipboard");
  const ordinary = formatImageLocation("/tmp/screenshot.jpg", "/Users/gagan");
  assert.equal(ordinary.name, "screenshot.jpg");
  assert.equal(ordinary.kind, "JPEG");
  assert.equal(ordinary.source, "File");
  assert.equal(formatImageLocation("/tmp/pi-clipboard-b.jpg", "/Users/gagan", "2").name, "image-2.jpg");
});

test("finds the image token under the caret", () => {
  const text = "see [image-1] and [image-2]";
  assert.equal(imageTokenAtCursor(text, { line: 0, col: 4 }), "1");
  assert.equal(imageTokenAtCursor(text, { line: 0, col: 12 }), "1");
  assert.equal(imageTokenAtCursor(text, { line: 0, col: 13 }), "1");
  assert.equal(imageTokenAtCursor(text, { line: 0, col: 14 }), undefined);
  assert.equal(imageTokenAtCursor(text, { line: 0, col: 18 }), "2");
  assert.equal(imageTokenAtCursor("look\n[image-3]", { line: 1, col: 0 }), "3");
  assert.equal(imageTokenAtCursor("look\n[image-3]", { line: 0, col: 1 }), undefined);
  assert.equal(imageTokenAtCursor("old [image 1]", { line: 0, col: 5 }), "1");
});

test("skips stale mapped files without dropping their token", () => {
  const missing = join(fixtures, "stale.png");
  const store = new Map<string, string>([["1", missing]]);
  const result = transformSubmittedText("[image-1]", store, () => undefined);
  assert.equal(result.text, "[image-1]");
  assert.deepEqual(result.images, []);
});
