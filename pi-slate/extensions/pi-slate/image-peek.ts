import { homedir } from "node:os";
import type { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import {
  imageTokenAtCursor,
  nextImageNumber,
  rewriteClipboardPaths,
  type ImageAttachment,
  type ImagePathStore,
} from "./placeholders.ts";
import { ImageWorkspaceView } from "./workspace.ts";
import type { Sidebar } from "./sidebar.ts";

export class ImagePeek {
  private shownId?: string;
  private rewriteTimer?: ReturnType<typeof setTimeout>;
  private readonly originalHandleMouse: CustomEditor["handleMouse"];
  private readonly originalHandleInput: CustomEditor["handleInput"];
  private readonly store: ImagePathStore;
  private readonly editor: CustomEditor;
  private readonly workspace: Sidebar;
  private readonly loadImage: (filePath: string) => ImageAttachment | undefined;

  constructor(
    store: ImagePathStore,
    editor: CustomEditor,
    workspace: Sidebar,
    loadImage: (filePath: string) => ImageAttachment | undefined,
  ) {
    this.store = store;
    this.editor = editor;
    this.workspace = workspace;
    this.loadImage = loadImage;
    this.originalHandleMouse = this.editor.handleMouse;
    this.originalHandleInput = this.editor.handleInput;
    this.editor.handleMouse = (event: TuiMouseEvent): TuiMouseEventResult | undefined => {
      clearTimeout(this.rewriteTimer);
      const result = this.originalHandleMouse.call(this.editor, event);
      this.update();
      return result;
    };
    this.editor.handleInput = (data: string): void => {
      const before = this.editor.getText();
      this.originalHandleInput.call(this.editor, data);
      clearTimeout(this.rewriteTimer);
      // Only live-rewrite plain text appended at the end of the composer.
      // Navigation, history recall and undo must not trigger a buffer reset.
      if (data && !/[\x00-\x1f\x7f]/.test(data) && this.editor.getText() === before + data) {
        // ponytail: unbracketed drops have no completion marker. A 50 ms quiet
        // period avoids replacing prefixes during a burst, not a manual pause.
        this.rewriteTimer = setTimeout(() => this.rewrite(), 50);
      }
      this.update();
    };
  }

  rewrite(): void {
    const text = this.editor.getText();
    const lines = text.split("\n");
    const cursor = this.editor.getCursor();
    // setText clears paste bodies and moves the cursor. In these cases leave
    // raw paths intact: the input transform can attach them safely on submit.
    if (this.editor.getExpandedText() !== text || cursor.line !== lines.length - 1 || cursor.col !== lines.at(-1)!.length) {
      this.update();
      return;
    }
    const rewritten = rewriteClipboardPaths(text, nextImageNumber(text), this.store);
    if (rewritten !== text) this.editor.setText(rewritten);
    this.update();
  }

  update(): void {
    const number = imageTokenAtCursor(this.editor.getText(), this.editor.getCursor());
    const filePath = number ? this.store.get(number) : undefined;
    if (!number || !filePath) {
      this.hide();
      return;
    }

    const nextId = `image:${number}:${filePath}`;
    if (this.shownId === nextId && this.workspace.currentViewId() === nextId) return;

    const image = this.loadImage(filePath);
    if (!image) {
      this.hide();
      return;
    }

    this.workspace.setView(
      new ImageWorkspaceView(
        number,
        filePath,
        image,
        this.workspace.requireTheme(),
        homedir(),
      ),
    );
    this.shownId = nextId;
  }

  hide(): void {
    if (!this.shownId) return;
    this.workspace.setView(undefined);
    this.shownId = undefined;
  }

  dispose(): void {
    clearTimeout(this.rewriteTimer);
    this.editor.handleMouse = this.originalHandleMouse;
    this.editor.handleInput = this.originalHandleInput;
    this.hide();
  }
}
