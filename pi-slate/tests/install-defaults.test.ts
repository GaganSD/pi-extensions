import assert from "node:assert/strict";
import test from "node:test";
import {
  applySlateTheme,
  persistFullscreen,
  persistTheme,
  shouldApplyInstallDefault,
  SLATE_THEME,
} from "../extensions/pi-slate/install-defaults.ts";

test("install defaults apply once", () => {
  assert.equal(shouldApplyInstallDefault(undefined), true);
  assert.equal(shouldApplyInstallDefault(false), true);
  assert.equal(shouldApplyInstallDefault(true), false);
});

test("theme selection reports success from the UI", () => {
  assert.equal(applySlateTheme({ ui: { setTheme: (name) => {
    assert.equal(name, SLATE_THEME);
    return { success: true };
  } } }), true);
  assert.equal(applySlateTheme({ ui: { setTheme: () => ({ success: false, error: "missing" }) } }), false);
});

test("theme name is written to Pi settings", () => {
  let theme = "pi-slate";
  assert.equal(persistTheme("/tmp/slate", "catppuccin-mocha-mauve", () => ({
    getTheme: () => theme,
    setTheme: (next) => { theme = next; },
  })), true);
  assert.equal(theme, "catppuccin-mocha-mauve");
  assert.equal(persistTheme("/tmp/slate", "catppuccin-mocha-mauve", () => {
    throw new Error("locked");
  }), false);
});

test("fullscreen is written to Pi settings", () => {
  let mode: "regular" | "fullscreen" = "regular";
  assert.equal(persistFullscreen("/tmp/slate", () => ({
    getTuiMode: () => mode,
    setTuiMode: (next) => { mode = next; },
  })), true);
  assert.equal(mode, "fullscreen");
  assert.equal(persistFullscreen("/tmp/slate", () => {
    throw new Error("locked");
  }), false);
});
