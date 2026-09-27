import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MODES = new Set(["off", "lite", "full", "ultra", "review"]);
const DEFAULT_MODES = new Set(["off", "lite", "full", "ultra"]);

function readDefaultMode(): string {
  const env = process.env.PONYTAIL_DEFAULT_MODE?.trim().toLowerCase();
  if (env && DEFAULT_MODES.has(env)) return env;

  try {
    const dir = process.env.XDG_CONFIG_HOME
      ? join(process.env.XDG_CONFIG_HOME, "ponytail")
      : join(homedir(), ".config", "ponytail");
    const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8").replace(/^\uFEFF/, ""));
    const mode = String(config.defaultMode || "").toLowerCase();
    if (DEFAULT_MODES.has(mode)) return mode;
  } catch {
    // missing or invalid config — same fallback as ponytail
  }

  return "full";
}

function resolveSessionMode(entries: unknown, fallback: string): string {
  if (!Array.isArray(entries)) return fallback;

  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i] as { type?: string; customType?: string; data?: { mode?: string } };
    if (entry?.type !== "custom" || entry?.customType !== "ponytail-mode") continue;
    const mode = String(entry?.data?.mode || "").toLowerCase();
    if (MODES.has(mode)) return mode;
  }

  return fallback;
}

export default function ponytailStartup(pi: ExtensionAPI) {
  // Silence ponytail's own startup toast (including "Ponytail loaded: off").
  process.env.PONYTAIL_QUIET_STARTUP = "1";

  pi.on("session_start", async (_event, ctx) => {
    const entries = ctx?.sessionManager?.getBranch?.() || ctx?.sessionManager?.getEntries?.() || [];
    const mode = resolveSessionMode(entries, readDefaultMode());
    if (mode !== "off") {
      ctx?.ui?.notify?.("Ponytail loaded: on", "info");
    }
  });
}
