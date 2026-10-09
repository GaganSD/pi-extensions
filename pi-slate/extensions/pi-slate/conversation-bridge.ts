import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { ComposerEditor } from "./composer.ts";

/** Versioned, synchronous capability handshake. No session/authority transfer. */
export function installConversationBridge(pi: ExtensionAPI, source: {
  context(): ExtensionContext | undefined;
  editor(): ComposerEditor | undefined;
  tui(): TUI | undefined;
  canMount?(): boolean;
  workspaceFocus?(component: Component): boolean;
  replaceChat(view: Component): (() => void) | undefined;
}): { close(): void; dispose(): void } {
  const leases = new Set<() => void>();
  const unsubscribe = pi.events.on("subagent:ui-host-request", (request: unknown) => {
    const value = request as { version?: number; owner?: string; accept?: (host: unknown) => void } | undefined;
    const ctx = source.context(), editor = source.editor(), tui = source.tui();
    if (value?.version !== 1 || typeof value.accept !== "function" || !ctx || ctx.mode !== "tui"
      || value.owner !== ctx.sessionManager.getSessionId() || !editor || !tui) return;
    let returnFocus = true;
    value.accept({
      version: 1,
      isActive: () => source.editor() === editor && source.tui() === tui,
      canFocusRoster: () => returnFocus,
      focusEditor(data?: string) {
        if (source.editor() !== editor) return;
        tui.setFocus(editor);
        if (data) editor.handleInput(data);
      },
      bindDown(handler: () => void) {
        const previous = editor.onDownBoundary;
        editor.onDownBoundary = handler;
        const release = () => {
          if (editor.onDownBoundary === handler) editor.onDownBoundary = previous;
          leases.delete(release);
        };
        leases.add(release);
        return release;
      },
      ...(source.canMount?.() === false ? {} : { mount(view: Component & { dispose?(): void }) {
        if (source.editor() !== editor || source.tui() !== tui) return undefined;
        const restore = source.replaceChat(view);
        if (!restore) return undefined;
        let active = true, queued = false;
        const originalRender = view.render;
        const foreignFocus = () => {
          const focus = (tui as TUI & { getFocusedComponent?(): Component | null }).getFocusedComponent?.();
          return focus && focus !== view && focus !== editor && !source.workspaceFocus?.(focus);
        };
        const guardedRender = (width: number) => {
          if (!queued && foreignFocus()) {
            queued = true;
            queueMicrotask(() => { queued = false; if (active && foreignFocus()) close(); });
          }
          return originalRender.call(view, width);
        };
        view.render = guardedRender;
        const release = () => {
          if (!active) return;
          active = false; returnFocus = !foreignFocus();
          if (view.render === guardedRender) view.render = originalRender;
          restore(); leases.delete(close); tui.requestRender(true);
        };
        const close = () => { release(); view.dispose?.(); };
        leases.add(close);
        tui.setFocus(view);
        tui.requestRender(true);
        return release;
      } }),
    });
  });
  const close = () => { for (const release of [...leases]) { try { release(); } catch { /* Release all leases even if a view fails. */ } } };
  return { close, dispose() { close(); unsubscribe(); } };
}
