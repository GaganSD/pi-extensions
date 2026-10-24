import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	Theme,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
	CREDENTIAL_ENV_ALIASES,
	CREDENTIAL_PROVIDER_IDS,
	type CredentialProviderId,
	githubToken,
	resolveCredential,
	storeApiKey,
} from "./env.ts";
import {
	configureJudgment,
	parseJudgmentArgs,
	resolveSettings,
	type AvailableClassifier,
	type JudgmentAction,
} from "./providers/config.ts";
import {
	PROVIDER_KINDS,
	type ProviderKind,
} from "./providers/types.ts";
import { awaitWithSignal, withTimeout } from "./providers/http.ts";

export const WEB_SEARCH_USAGE =
	"Usage: /web-search [status|provider [name]|classifier [none|provider/model]]. Keys are never accepted as arguments.";


export const WEB_SEARCH_COMMAND = "web-search";

export type WebSearchAction =
	| { kind: "menu" }
	| { kind: "status" }
	| { kind: "provider"; id?: ProviderKind }
	| { kind: "classifier"; action: JudgmentAction | "pick" }
	| { kind: "usage" };

const PROVIDER_KIND_SET = new Set<string>(PROVIDER_KINDS);

export const PROVIDER_AUTH: Record<
	ProviderKind,
	{ key: "none" | "optional" | "required"; summary: string; keyUrl?: string }
> = {
	exa: { key: "optional", summary: "keyless MCP; key selects REST", keyUrl: "https://dashboard.exa.ai/api-keys" },
	parallel: { key: "optional", summary: "keyless MCP; key raises limits", keyUrl: "https://platform.parallel.ai" },
	grep: { key: "none", summary: "keyless" },
	sourcegraph: { key: "none", summary: "keyless" },
	github: { key: "required", summary: "token or gh auth", keyUrl: "https://github.com/settings/tokens" },
	brave: { key: "required", summary: "REST search; optional provider", keyUrl: "https://api-dashboard.search.brave.com/app/keys" },
};

export function parseWebSearchArgs(args: string): WebSearchAction {
	const trimmed = args.trim();
	if (trimmed.length === 0) {
		return { kind: "menu" };
	}
	const parts = trimmed.split(/\s+/);
	const [head, ...rest] = parts;
	if (head === "status") {
		return { kind: "status" };
	}
	if (head === "provider") {
		if (rest.length === 0) {
			return { kind: "provider" };
		}
		const id = rest[0];
		if (!id || !PROVIDER_KIND_SET.has(id)) {
			return { kind: "usage" };
		}
		if (rest.length === 1) {
			return { kind: "provider", id: id as ProviderKind };
		}
		return { kind: "usage" };
	}
	if (head === "classifier") {
		if (rest.length === 0) {
			return { kind: "classifier", action: "pick" };
		}
		if (rest.length === 1 && rest[0] === "none") {
			return { kind: "classifier", action: "off" };
		}
		const pin = parseJudgmentArgs(rest.join(" "));
		if (pin && pin !== "status" && pin !== "on" && pin !== "off") {
			return { kind: "classifier", action: pin };
		}
		return { kind: "usage" };
	}
	if (trimmed === "on" || trimmed === "off") {
		return { kind: "classifier", action: trimmed };
	}
	return { kind: "usage" };
}

export function webSearchCompletions(prefix: string): { value: string; label: string }[] {
	const trimmed = prefix.trimStart();
	const parts = trimmed.length === 0 ? [""] : trimmed.split(/\s+/);
	const completing = prefix.endsWith(" ") ? "" : (parts.at(-1) ?? "");
	const head = prefix.endsWith(" ") ? (parts[0] ?? "") : (parts.length > 1 ? parts[0] : "");
	if (head === "provider") {
		const tokens = trimmed.split(/\s+/).filter(Boolean);
		return tokens.length === 1 || (tokens.length === 2 && !prefix.endsWith(" "))
			? filterCompletions([...PROVIDER_KINDS], completing)
			: [];
	}
	if (head === "classifier") {
		return filterCompletions(["none"], completing);
	}
	if (parts.length <= 1 && !prefix.endsWith(" ")) {
		return filterCompletions(
			["status", "provider", "classifier", "on", "off"],
			completing,
		);
	}
	return [];
}

function filterCompletions(values: readonly string[], prefix: string) {
	return values
		.filter((value) => value.startsWith(prefix))
		.map((value) => ({ value, label: value }));
}

export async function handleWebSearchCommand(
	args: string,
	ctx: Pick<ExtensionCommandContext, "hasUI" | "ui" | "modelRegistry" | "signal">,
	pi: Pick<ExtensionAPI, "sendMessage">,
): Promise<void> {
	const parsed = parseWebSearchArgs(args);
	let report: string | undefined;
	try {
		if (parsed.kind === "usage") {
			report = WEB_SEARCH_USAGE;
		} else if (parsed.kind === "menu") {
			report = ctx.hasUI
				? await runMenu(ctx)
				: await buildSettingsReport(ctx.modelRegistry);
		} else if (parsed.kind === "status") {
			report = await buildSettingsReport(ctx.modelRegistry);
		} else if (parsed.kind === "provider") {
			report = await runProvider(parsed.id, ctx);
		} else {
			report = await runClassifier(parsed.action, ctx);
		}
	} catch (error) {
		report = error instanceof ClassifierDiscoveryError
			? error.message
			: error instanceof Error && /auth\.json|API key is empty|Malformed configuration|Could not update/.test(error.message)
				? error.message
				: parsed.kind === "provider"
					? "Could not update the stored key. Check auth.json and permissions. Malformed files are never overwritten."
					: "Could not update search settings. Check the config file and permissions. Malformed configuration is never overwritten.";
	}
	if (!report) {
		return;
	}
	if (ctx.hasUI) {
		ctx.ui.notify(report, "info");
	} else {
		pi.sendMessage({ customType: WEB_SEARCH_COMMAND, content: report, display: true });
	}
}

async function runMenu(
	ctx: Pick<ExtensionCommandContext, "hasUI" | "ui" | "modelRegistry" | "signal">,
): Promise<string | undefined> {
	const setting = await ctx.ui.select("Web Search", ["Status", "Providers", "Classifier"]);
	if (setting === "Status") {
		return buildSettingsReport(ctx.modelRegistry);
	}
	if (setting === "Providers") {
		return runProvider(undefined, ctx);
	}
	if (setting === "Classifier") {
		return runClassifier("pick", ctx);
	}
	return undefined;
}

async function runProvider(
	id: ProviderKind | undefined,
	ctx: Pick<ExtensionCommandContext, "hasUI" | "ui" | "modelRegistry" | "signal">,
): Promise<string | undefined> {
	const selected = id ?? (ctx.hasUI ? await pickProvider(ctx) : undefined);
	if (!selected) {
		return ctx.hasUI ? undefined : `${WEB_SEARCH_USAGE}\nInteractive Pi can add a key with /web-search provider.`;
	}
	const auth = PROVIDER_AUTH[selected];
	if (auth.key === "none") {
		return `${selected}: keyless.`;
	}
	if (!ctx.hasUI) {
		const source = credentialSource(selected as CredentialProviderId);
		return [
			`${selected}: ${auth.key} key — ${auth.summary}; ${source ? `present (${source})` : "missing"}.`,
			auth.keyUrl ? `Get a key: ${auth.keyUrl}` : undefined,
			"Add or modify a key in interactive Pi with /web-search provider.",
		].filter((line): line is string => line !== undefined).join("\n");
	}
	return addOrModifyApiKey(selected as CredentialProviderId, ctx);
}

async function pickProvider(
	ctx: Pick<ExtensionCommandContext, "ui">,
): Promise<ProviderKind | undefined> {
	const options = PROVIDER_KINDS.map((id) => providerOption(id, ctx.ui.theme));
	const chosen = await ctx.ui.select("Search provider", options);
	if (!chosen) {
		return undefined;
	}
	return PROVIDER_KINDS.find((id) => chosen.startsWith(`${id} `) || chosen === id);
}

function providerOption(id: ProviderKind, theme: Theme | undefined): string {
	const auth = PROVIDER_AUTH[id];
	if (auth.key === "none") {
		return `${id} · ${paint(theme, "muted", "keyless")}`;
	}
	const source = credentialSource(id as CredentialProviderId);
	const state = source
		? paint(theme, "success", `present (${source})`)
		: paint(theme, auth.key === "required" ? "error" : "warning", "missing");
	return `${id} · ${auth.key} · ${state}`;
}

/** Theme-color picker text; plain when the host passes no theme (tests, headless). */
function paint(theme: Theme | undefined, color: ThemeColor, text: string): string {
	return theme ? theme.fg(color, text) : text;
}

/** Where the credential comes from, or undefined when absent. Never the key. */
function credentialSource(id: CredentialProviderId): string | undefined {
	const found = resolveCredential(id);
	if (found) {
		return found.source === "env" ? found.name : "auth.json";
	}
	if (id === "github" && githubToken() !== undefined) {
		return "gh auth";
	}
	return undefined;
}

async function addOrModifyApiKey(
	id: CredentialProviderId,
	ctx: Pick<ExtensionCommandContext, "ui">,
): Promise<string | undefined> {
	const url = PROVIDER_AUTH[id].keyUrl;
	if (url) {
		ctx.ui.notify(`Get a ${id} API key: ${url}`, "info");
	}
	const key = await ctx.ui.input(
		url ? `Add or modify ${id} API key — ${url}` : `Add or modify ${id} API key`,
	);
	if (key === undefined) {
		return undefined;
	}
	if (key.trim().length === 0) {
		return "API key is empty. Nothing was stored.";
	}
	if (!await ctx.ui.confirm(`Save ${id} API key?`, "The key is written to auth.json and will not be shown again.")) {
		return undefined;
	}
	await storeApiKey(id, key);
	const env = resolveCredential(id, { env: process.env, readCredential: () => undefined });
	const lines = [
		`Saved ${id} API key.`,
		id === "parallel" ? "Run /reload so Parallel MCP picks up the new header." : undefined,
		env ? `${env.name} is set and still takes precedence until you unset it.` : undefined,
	].filter((line): line is string => line !== undefined);
	return lines.join("\n");
}

async function runClassifier(
	action: JudgmentAction | "pick",
	ctx: Pick<ExtensionCommandContext, "hasUI" | "ui" | "modelRegistry" | "signal">,
): Promise<string | undefined> {
	const selection = action === "pick"
		? await pickClassifier(ctx)
		: action;
	if (selection === undefined) {
		return ctx.hasUI ? undefined : `${WEB_SEARCH_USAGE}\nInteractive Pi can pick a classifier with /web-search classifier.`;
	}
	// Auth lookup runs before the write so a failure cannot misreport a saved pin.
	const pinned = typeof selection === "object" ? selection : undefined;
	const auth = pinned ? ctx.modelRegistry?.getProviderAuthStatus?.(pinned.provider) : undefined;
	const saved = await configureJudgment(
		selection,
		selection === "on" ? () => availableClassifiers(ctx.modelRegistry, ctx.signal) : [],
	);
	const what = selection === "off"
		? "Classifier disabled"
		: pinned
			? `Classifier pinned: ${pinned.provider}/${pinned.id}`
			: "Classifier enabled";
	const login = pinned && auth && !auth.configured
		? `\nPi has no ${pinned.provider} credentials. Run /login ${pinned.provider}, then /reload.`
		: "";
	return `${what}. Saved to ${saved.path} — run /reload to apply.${login}${saved.note ? `\n${saved.note}` : ""}`;
}

async function pickClassifier(
	ctx: Pick<ExtensionCommandContext, "hasUI" | "ui" | "modelRegistry" | "signal">,
): Promise<JudgmentAction | undefined> {
	if (!ctx.hasUI) {
		return undefined;
	}
	const resolved = await resolveSettings();
	const current = !("error" in resolved) && resolved.jev.provider && resolved.jev.model
		? `${resolved.jev.provider}/${resolved.jev.model}`
		: undefined;
	const models = await listSupportedClassifiers(ctx.modelRegistry, ctx.signal);
	// Available classifiers first, current pin at the very top; stable otherwise.
	models.sort((a, b) => Number(b.available === true) - Number(a.available === true));
	const currentIndex = models.findIndex((model) => `${model.provider}/${model.id}` === current);
	if (currentIndex > 0) {
		models.unshift(...models.splice(currentIndex, 1));
	}
	const options = [
		"None",
		...models.map((model) => classifierOption(model, current, ctx.ui.theme)),
	];
	const chosen = await ctx.ui.select("Classifier", options);
	if (!chosen) {
		return undefined;
	}
	const plain = chosen.replace(/\x1b\[[0-9;]*m/g, "");
	if (plain === "None") {
		return "off";
	}
	const unprefixed = plain.startsWith(CURRENT_PREFIX) ? plain.slice(CURRENT_PREFIX.length) : plain;
	const match = models.find((model) => unprefixed.startsWith(`${model.provider}/${model.id} `) || unprefixed === `${model.provider}/${model.id}`);
	return match;
}

const CURRENT_PREFIX = "[current] ";

function classifierOption(model: ListedClassifier, current: string | undefined, theme: Theme | undefined): string {
	const pin = `${model.provider}/${model.id}`;
	const name = current === pin ? `${paint(theme, "accent", "[current]")} ${pin}` : pin;
	// Available classifiers are the default case: bare pin, no suffix noise.
	if (model.available === true) {
		return name;
	}
	const state = model.available === false
		? paint(theme, "warning", "login required")
		: paint(theme, "muted", "untested");
	return `${name} · ${state}`;
}

interface ListedClassifier extends AvailableClassifier {
	available?: boolean;
}

export async function listSupportedClassifiers(
	registry: ExtensionContext["modelRegistry"] | undefined,
	signal?: AbortSignal,
): Promise<ListedClassifier[]> {
	if (!registry) {
		return [];
	}
	const known = (registry.getModelsOfType?.("classifier") ?? []).map((model) => ({
		provider: model.provider,
		id: model.id,
	}));
	let available: AvailableClassifier[] | undefined;
	try {
		available = await availableClassifiers(registry, signal);
	} catch {
		// Discovery failed (timeout, abort, network): availability is unknown, not missing.
		available = undefined;
	}
	const ready = new Set((available ?? []).map((model) => `${model.provider}/${model.id}`));
	const listed = known.map((model) => ({
		...model,
		available: available === undefined ? undefined : ready.has(`${model.provider}/${model.id}`),
	}));
	if (listed.length > 0) {
		return listed;
	}
	return (available ?? []).map((model) => ({ ...model, available: true }));
}

/**
 * Report retrieval credential presence and Pi's classifier auth snapshot, never keys.
 * No classifier requests or credential re-resolution are made here.
 */
export async function buildSettingsReport(registry: ExtensionContext["modelRegistry"] | undefined): Promise<string> {
	const resolved = await resolveSettings();
	if ("error" in resolved) {
		return [
			"pi-web-search settings",
			`config: ${resolved.error.configPath}`,
			`error: ${resolved.error.message}`,
			"Fix the file, then run /reload.",
		].join("\n");
	}

	const pin = resolved.jev.provider && resolved.jev.model
		? `${resolved.jev.provider}/${resolved.jev.model}`
		: "unpinned";
	const list = (kinds: readonly string[]) =>
		kinds.length > 0 ? kinds.join(", ") : "none";
	const lines: string[] = [
		"pi-web-search settings",
		`config: ${resolved.configPath}`,
		`web_search: ${resolved.web.provider} (fallback: ${list(resolved.web.fallback)})`,
		`code_search: ${resolved.code.provider} (fallback: ${list(resolved.code.fallback)})`,
		`multi_search: ${resolved.researchEnabled ? "enabled" : "disabled"}`,
		`jev: ${resolved.jev.enabled ? `enabled (${pin})` : "disabled"}`,
		"",
		"Search credentials (presence only; keys are never shown):",
	];
	for (const id of PROVIDER_KINDS) {
		const auth = PROVIDER_AUTH[id];
		if (auth.key === "none") {
			lines.push(`- ${id}: keyless`);
			continue;
		}
		const source = credentialSource(id as CredentialProviderId);
		lines.push(`- ${id}: ${source ? `present (${source})` : `missing (${auth.key} key)`}`);
	}
	if (resolved.jev.provider && resolved.jev.model) {
		const auth = registry?.getProviderAuthStatus?.(resolved.jev.provider);
		const registered = registry?.findOfType?.("classifier", resolved.jev.provider, resolved.jev.model);
		const authText = auth === undefined
			? "auth status unknown"
			: auth.configured
				? "credentials configured"
				: `no credentials — run /login ${resolved.jev.provider}`;
		lines.push(
			"",
			"Pinned classifier (Pi auth snapshot, not a live test):",
			`- ${resolved.jev.provider}/${resolved.jev.model}: ${authText}; ${registered === undefined ? "registration unknown" : registered ? "registered" : "not registered"}.`,
		);
	}
	const envNames = CREDENTIAL_PROVIDER_IDS
		.map((id) => CREDENTIAL_ENV_ALIASES[id].join("/"))
		.join(", ");
	lines.push(
		"",
		"Setup:",
		`- /web-search provider <name>: add or modify a key in auth.json. Env vars also work: ${envNames}.`,
		"- /web-search classifier: pick a Pi classifier, or none to disable. /model does not list classifiers; the pinned provider's billing applies.",
		"- Nonsecret settings live in web-search.json.",
		"- Run /reload after changing multi_search or a Parallel key (its MCP header is captured at registration).",
		"- Install: pi install ./pi-web-search (checkout) or pi install npm:@gagansd/pi-web-search (release).",
	);
	return lines.join("\n");
}

export class ClassifierDiscoveryError extends Error {}

export async function availableClassifiers(
	registry: ExtensionContext["modelRegistry"] | undefined,
	signal?: AbortSignal,
	timeoutMs = 3_000,
) {
	if (!registry) return [];
	const deadline = withTimeout(signal, timeoutMs);
	try {
		if (deadline.signal.aborted) throw deadline.signal.reason;
		const models = await awaitWithSignal(
			registry.getAvailableOfType("classifier", undefined, { signal: deadline.signal }),
			deadline.signal,
		);
		return models.map((model) => ({ provider: model.provider, id: model.id }));
	} catch {
		throw new ClassifierDiscoveryError(
			"Classifier discovery failed or stopped. Settings did not change. Use /web-search classifier provider/model to select a classifier directly.",
		);
	} finally {
		deadline.dispose();
	}
}
