import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { configureJev, defaultWebSearchConfigPath } from "./providers/config.ts";

export const KEEP_DEFAULTS = "Keep keyless defaults";
export const ENABLE_JEV = "Enable multi_search + Jev (TypeSafe)";
export const SHOW_SETUP = "Show what I can set up";

export const SETUP_BLURB = [
	"pi-web-search is ready without keys.",
	"Web: Exa → Parallel. Code: grep.app → Sourcegraph → GitHub if you have a token or `gh auth`.",
	"Optional keys: EXA_API_KEY, PARALLEL_API_KEY, GITHUB_TOKEN or GH_TOKEN.",
	"Jev: /web-search-settings typesafe|vercel|openrouter then /reload.",
	"This prompt is shown once. /web-search-settings anytime.",
].join("\n");

export function welcomeStatePath(configPath = defaultWebSearchConfigPath()): string {
	return join(dirname(configPath), "web-search-welcome.json");
}

export async function hasSeenWelcome(path = welcomeStatePath()): Promise<boolean> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf-8"));
		return typeof parsed === "object" && parsed !== null && (parsed as { seen?: unknown }).seen === true;
	} catch {
		return false;
	}
}

export async function markWelcomeSeen(path = welcomeStatePath()): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify({ seen: true }, null, 2)}\n`, { mode: 0o600 });
}

export async function maybeShowWelcome(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI || await hasSeenWelcome()) {
		return;
	}
	let choice: string | undefined;
	try {
		choice = await ctx.ui.select("pi-web-search setup", [KEEP_DEFAULTS, ENABLE_JEV, SHOW_SETUP], {
			timeout: 60_000,
		});
	} catch {
		await markWelcomeSeen().catch(() => {});
		return;
	}
	await markWelcomeSeen().catch(() => {});
	if (choice === ENABLE_JEV) {
		try {
			const saved = await configureJev("typesafe");
			ctx.ui.notify(`Saved ${saved}. Run /reload to expose multi_search.`, "info");
		} catch {
			ctx.ui.notify("Could not save Jev settings. Check web-search.json permissions.", "error");
		}
		return;
	}
	if (choice === SHOW_SETUP) {
		ctx.ui.notify(SETUP_BLURB, "info");
	}
}
