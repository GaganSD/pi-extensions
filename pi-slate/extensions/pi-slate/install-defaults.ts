import { SettingsManager } from "@earendil-works/pi-coding-agent";

export const SLATE_THEME = "pi-slate";

export function shouldApplyInstallDefault(applied: boolean | undefined): boolean {
  return applied !== true;
}

export function applySlateTheme(ctx: { ui: { setTheme(theme: string): { success: boolean } } }): boolean {
  return ctx.ui.setTheme(SLATE_THEME).success === true;
}

export function persistFullscreen(
  cwd: string,
  create: (cwd: string) => Pick<SettingsManager, "getTuiMode" | "setTuiMode"> = SettingsManager.create,
): boolean {
  try {
    const settings = create(cwd);
    if (settings.getTuiMode() !== "fullscreen") settings.setTuiMode("fullscreen");
    return true;
  } catch {
    return false;
  }
}

export function persistTheme(
  cwd: string,
  theme: string,
  create: (cwd: string) => Pick<SettingsManager, "getTheme" | "setTheme"> = SettingsManager.create,
): boolean {
  try {
    const settings = create(cwd);
    if (settings.getTheme() !== theme) settings.setTheme(theme);
    return true;
  } catch {
    return false;
  }
}
