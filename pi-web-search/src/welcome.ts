import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type CredentialResolverOptions,
	githubToken,
	resolveCredential,
} from "./env.ts";
import {
	defaultWebSearchConfigPath,
	readWebSearchConfig,
} from "./providers/config.ts";

export const CONTINUE = "Continue with detected providers";
export const SHOW_SETUP = "Show what I can set up";

export interface WelcomeSnapshot {
	/** How the Exa key was found; omitted when keyless MCP will be used. */
	exa?: string;
	/** How the Parallel key was found; omitted when anonymous MCP will be used. */
	parallel?: string;
	/** How the GitHub token was found; omitted when GitHub is unavailable. */
	github?: string;
	configExists: boolean;
}

export interface DetectWelcomeOptions {
	credentials?: CredentialResolverOptions;
	snapshot?: WelcomeSnapshot;
}

export function welcomeGaps(snap: WelcomeSnapshot): string[] {
	const gaps: string[] = [];
	if (!snap.exa) {
		gaps.push('Optional Exa REST: set EXA_API_KEY or add "exa" to auth.json.');
	}
	if (!snap.parallel) {
		gaps.push('Optional Parallel key for higher limits: set PARALLEL_API_KEY or add "parallel" to auth.json.');
	}
	if (!snap.github) {
		gaps.push("Optional GitHub: set GITHUB_TOKEN or GH_TOKEN, run gh auth login, or add \"github\" to auth.json.");
	}
	return gaps;
}

export function welcomeOptions(snap: WelcomeSnapshot): string[] {
	const options = [CONTINUE];
	if (welcomeGaps(snap).length > 0) {
		options.push(SHOW_SETUP);
	}
	return options;
}

export function formatWelcomeStatus(snap: WelcomeSnapshot): string {
	return [
		`Exa: ${snap.exa ?? "keyless MCP"}`,
		`Parallel: ${snap.parallel ?? "keyless MCP"}`,
		`GitHub: ${snap.github ?? "missing"}`,
		`Config: ${snap.configExists ? "existing" : "defaults"}`,
	].join(" · ");
}

export function setupBlurb(snap: WelcomeSnapshot): string {
	return [
		...welcomeGaps(snap),
		"Existing Exa, GitHub, and Parallel credentials are reused. No second login.",
		"Optional judgment: /web-search-settings on after a Pi classifier is available.",
		"This prompt is shown once. /web-search-settings anytime.",
	].join("\n");
}

export async function detectWelcome(
	_ctx: Pick<ExtensionContext, "modelRegistry">,
	options: DetectWelcomeOptions = {},
): Promise<WelcomeSnapshot> {
	if (options.snapshot) {
		return options.snapshot;
	}
	const result = await readWebSearchConfig();
	return {
		...present("exa", viaLabel(resolvePresent("exa", options.credentials))),
		...present("parallel", viaLabel(resolvePresent("parallel", options.credentials))),
		...present("github", detectGithub(options.credentials)),
		configExists: result.status !== "missing",
	};
}

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

export async function maybeShowWelcome(
	ctx: ExtensionContext,
	options: DetectWelcomeOptions = {},
): Promise<void> {
	if (ctx.mode !== "tui" || !ctx.hasUI || await hasSeenWelcome()) {
		return;
	}
	const snap = await detectWelcome(ctx, options);
	let choice: string | undefined;
	try {
		ctx.ui.notify(formatWelcomeStatus(snap), "info");
		choice = await ctx.ui.select("pi-web-search setup", welcomeOptions(snap), {
			timeout: 60_000,
		});
	} catch {
		await markWelcomeSeen().catch(() => {});
		return;
	}
	await markWelcomeSeen().catch(() => {});
	if (choice === SHOW_SETUP) {
		ctx.ui.notify(setupBlurb(snap), "info");
	}
}

function resolvePresent(
	id: "exa" | "parallel" | "github",
	credentials?: CredentialResolverOptions,
) {
	return credentials ? resolveCredential(id, credentials) : resolveCredential(id);
}

function present<K extends "exa" | "parallel" | "github">(
	key: K,
	value: string | undefined,
): Partial<Pick<WelcomeSnapshot, K>> {
	return value === undefined ? {} : { [key]: value } as Pick<WelcomeSnapshot, K>;
}

function viaLabel(
	resolved: ReturnType<typeof resolveCredential>,
): string | undefined {
	if (!resolved) {
		return undefined;
	}
	return resolved.source === "env" ? resolved.name : "auth.json";
}

function detectGithub(credentials?: CredentialResolverOptions): string | undefined {
	const labeled = viaLabel(resolvePresent("github", credentials));
	if (labeled !== undefined) {
		return labeled;
	}
	const token = credentials ? githubToken(credentials) : githubToken();
	return token === undefined ? undefined : "gh auth";
}
