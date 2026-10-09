import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { getKeybindings, matchesKey } from "@earendil-works/pi-tui";

/** Own only the plain Pi editor; never wrap or replace another extension\u0027s editor. */
export class BoundaryEditor extends CustomEditor {
  onDownBoundary?: () => void;
  override handleInput(data: string): void {
    const canLeave = matchesKey(data, "down") && getKeybindings().matches(data, "tui.editor.cursorDown")
      && this.focused && !this.isShowingAutocomplete();
    const before = canLeave ? this.getCursor() : undefined;
    const text = canLeave ? this.getText() : undefined;
    super.handleInput(data);
    if (before && this.focused && !this.isShowingAutocomplete()) {
      const after = this.getCursor();
      if (after.line === before.line && after.col === before.col && this.getText() === text) this.onDownBoundary?.();
    }
  }
}
