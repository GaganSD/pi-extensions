import { readFileSync, statSync } from "node:fs";
import type { CustomEditor, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ImagePeek } from "./image-peek.ts";
import {
  mimeTypeForImagePath,
  nextImageNumber,
  rewriteClipboardPaths,
  transformSubmittedText,
  type ImageAttachment,
  type ImagePathStore,
} from "./placeholders.ts";
import type { Sidebar } from "./sidebar.ts";

type PatchableEditor = {
  insertTextAtCursor(text: string): void;
  handlePaste(text: string): void;
};

export type ImagePlaceholders = {
  attachEditor(editor: CustomEditor): void;
  detachEditor(): void;
  dispose(): void;
};

function loadImage(filePath: string): ImageAttachment | undefined {
  try {
    if (!statSync(filePath).isFile()) return undefined;
    return {
      type: "image",
      data: readFileSync(filePath).toString("base64"),
      mimeType: mimeTypeForImagePath(filePath),
    };
  } catch {
    return undefined;
  }
}

function installEditorPatch(
  store: ImagePathStore,
  onInserted: () => void,
  editor: CustomEditor,
): () => void {
  const instance = editor as unknown as PatchableEditor;
  const originalInsert = instance.insertTextAtCursor;
  const originalPaste = instance.handlePaste;
  const rewrite = (editor: CustomEditor, text: string) => rewriteClipboardPaths(text, nextImageNumber(editor.getText()), store);
  function insertPatch(this: CustomEditor, text: string) {
    const result = originalInsert.call(this, rewrite(this, text));
    onInserted();
    return result;
  }
  function pastePatch(this: CustomEditor, text: string) {
    originalPaste.call(this, rewrite(this, text));
    onInserted();
  }
  instance.insertTextAtCursor = insertPatch;
  instance.handlePaste = pastePatch;
  return () => {
    if (instance.insertTextAtCursor === insertPatch) instance.insertTextAtCursor = originalInsert;
    if (instance.handlePaste === pastePatch) instance.handlePaste = originalPaste;
  };
}

export function installImagePlaceholders(
  pi: ExtensionAPI,
  workspace?: Sidebar,
  isActive: () => boolean = () => true,
): ImagePlaceholders {
  const store: ImagePathStore = new Map();
  let peek: ImagePeek | undefined;
  let uninstallEditorPatch: (() => void) | undefined;

  pi.on("input", async (event, ctx) => {
    if (ctx.mode !== "tui" || !uninstallEditorPatch || !isActive()) return;
    peek?.hide();
    const result = transformSubmittedText(event.text, store, loadImage, event.images ?? []);
    if (result.text === event.text && result.images.length === (event.images?.length ?? 0)) {
      return { action: "continue" as const };
    }
    return {
      action: "transform" as const,
      text: result.text,
      images: result.images,
    };
  });

  return {
    attachEditor(editor) {
      this.detachEditor();
      uninstallEditorPatch = installEditorPatch(store, () => peek?.rewrite(), editor);
      peek = new ImagePeek(store, editor, workspace, loadImage);
    },
    detachEditor() {
      peek?.dispose();
      peek = undefined;
      uninstallEditorPatch?.();
      uninstallEditorPatch = undefined;
    },
    dispose() {
      this.detachEditor();
      store.clear();
    },
  };
}
