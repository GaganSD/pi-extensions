import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { JevBackendSetting } from "../jev/auth.ts";
import {
	PROVIDER_KINDS,
	type ProviderError,
	type ProviderFamily,
	providerError,
	type ProviderKind,
	providerFamily,
} from "./types.ts";

export const DEFAULT_PROVIDER: ProviderKind = "exa";
export const DEFAULT_FALLBACK: ProviderKind[] = ["parallel"];
export const DEFAULT_CODE_PROVIDER: ProviderKind = "grep";
export const DEFAULT_CODE_FALLBACK: ProviderKind[] = ["github"];
export const DEFAULT_TIMEOUT_MS = 20000;
export const DEFAULT_MAX_RESULTS = 8;
export const DEFAULT_MODE: SearchMode = "simple";

export type SearchMode = "simple" | "parallel";

export interface FamilyChain {
	provider: ProviderKind;
	fallback: ProviderKind[];
}
export const MIN_MAX_RESULTS = 1;
export const MAX_MAX_RESULTS = 20;

export const CONFIG_FILE_NAME = "web-search.json";
export const CONFIG_PATH_ENV_VAR = "PI_WEB_SEARCH_CONFIG";

export interface JevSettings {
	enabled: boolean;
	model: string;
	/** `auto` prefers a native TypeSafe key, then Vercel AI Gateway. */
	backend: JevBackendSetting;
	/** Weights for the ranking nouls. Policy stays in code, tunable here. */
	weights: { answers: number; offtopic: number; selfcontained: number };
	/** Suppress below this safety probability; the mid-band is held, not passed. */
	safetyThreshold: number;
	/** Skip augmentation when the judged set would exceed this many characters. */
	maxStateChars: number;
}

export interface ResolvedSettings {
	provider: ProviderKind;
	fallback: ProviderKind[];
	timeoutMs: number;
	maxResults: number;
	configPath: string;
	/** Legacy. Ordinary tools ignore this; `parallel` only enables research_search. */
	mode: SearchMode;
	family?: ProviderFamily;
	web: FamilyChain;
	code: FamilyChain;
	researchEnabled: boolean;
	jev: JevSettings;
	/** Non-fatal config problems, surfaced to the model as warnings. */
	notices: string[];
}

/** `invalid_config` never throws raw; it is surfaced through tool details. */
export interface InvalidConfigError extends ProviderError {
	code: "invalid_config";
	configPath: string;
}

export interface WebSearchConfig {
	provider?: ProviderKind;
	fallback?: ProviderKind[];
	timeoutMs?: number;
	maxResults?: number;
	mode?: SearchMode;
	family?: ProviderFamily;
	web?: Partial<FamilyChain>;
	code?: Partial<FamilyChain>;
	research?: { enabled?: boolean };
	jev?: Partial<Omit<JevSettings, "weights">> & {
		weights?: Partial<JevSettings["weights"]>;
	};
	/** Non-fatal parse notes, folded into ResolvedSettings.notices. */
	notices?: string[];
}

export type WebSearchConfigResult =
	| { status: "missing"; path: string }
	| { status: "invalid"; path: string; error: InvalidConfigError }
	| { status: "ok"; path: string; config: WebSearchConfig };

const PROVIDER_KIND_SET = new Set<string>(PROVIDER_KINDS);
const PROVIDER_FAMILIES = new Set<string>(["web", "code"]);

export const DEFAULT_JEV_SETTINGS: JevSettings = {
	enabled: false,
	// Pinned: `jev-latest` moves, and reproducibility beats convenience here.
	model: "jev-1.13.0",
	backend: "auto",
	weights: { answers: 0.45, offtopic: -0.3, selfcontained: 0.25 },
	safetyThreshold: 0.75,
	maxStateChars: 24000,
};

export function defaultWebSearchConfigPath(): string {
	const override = process.env[CONFIG_PATH_ENV_VAR];
	if (override && override.length > 0) {
		return override;
	}
	return join(getAgentDir(), CONFIG_FILE_NAME);
}

export async function readWebSearchConfig(
	path?: string,
): Promise<WebSearchConfigResult> {
	const configPath = path ?? defaultWebSearchConfigPath();

	let raw: string;
	try {
		raw = await readFile(configPath, "utf-8");
	} catch (error) {
		if (isMissingFileError(error)) {
			return { status: "missing", path: configPath };
		}
		return {
			status: "invalid",
			path: configPath,
			error: invalidConfig(
				configPath,
				`Could not read ${configPath}: ${errorMessage(error)}`,
			),
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return {
			status: "invalid",
			path: configPath,
			error: invalidConfig(
				configPath,
				`${configPath} is not valid JSON: ${errorMessage(error)}`,
			),
		};
	}

	if (!isPlainObject(parsed)) {
		return {
			status: "invalid",
			path: configPath,
			error: invalidConfig(
				configPath,
				`${configPath} must contain a JSON object.`,
			),
		};
	}

	const config: WebSearchConfig = {};
	const notices: string[] = [];
	// Unknown keys are ignored, not rejected. An unknown `provider` is also
	// ignored: the third-party pi-web-search file used LLM vendor names here,
	// and rejecting the whole file takes search down on install.
	if ("provider" in parsed) {
		const provider = parsed.provider;
		if (typeof provider === "string" && PROVIDER_KIND_SET.has(provider)) {
			config.provider = provider as ProviderKind;
		} else {
			notices.push(
				`Ignored provider ${JSON.stringify(provider)}; expected ${quotedList(PROVIDER_KINDS)}. Using "${DEFAULT_PROVIDER}".`,
			);
		}
	}

	if ("fallback" in parsed) {
		const fallback = parsed.fallback;
		if (!Array.isArray(fallback) || !isProviderKindList(fallback)) {
			return {
				status: "invalid",
				path: configPath,
				error: invalidConfig(
					configPath,
					`"fallback" must be an array of ${quotedList(PROVIDER_KINDS)}.`,
				),
			};
		}
		config.fallback = [...(fallback as ProviderKind[])];
	}

	for (const key of ["timeoutMs", "maxResults"] as const) {
		if (!(key in parsed)) {
			continue;
		}
		const value = parsed[key];
		if (typeof value !== "number" || !Number.isFinite(value)) {
			return {
				status: "invalid",
				path: configPath,
				error: invalidConfig(
					configPath,
					`"${key}" must be a finite number.`,
				),
			};
		}
		config[key] = value;
	}

	if ("mode" in parsed) {
		const mode = parsed.mode;
		if (mode === "simple" || mode === "parallel") {
			config.mode = mode;
		} else {
			notices.push(`Ignored mode ${JSON.stringify(mode)}; expected "simple" | "parallel".`);
		}
	}

	if ("family" in parsed) {
		const family = parsed.family;
		if (typeof family !== "string" || !PROVIDER_FAMILIES.has(family)) {
			return {
				status: "invalid",
				path: configPath,
				error: invalidConfig(configPath, `"family" must be "web" or "code".`),
			};
		}
		config.family = family as ProviderFamily;
	}

	if ("web" in parsed || "code" in parsed) {
		for (const key of ["web", "code"] as const) {
			if (!(key in parsed)) {
				continue;
			}
			const block = parsed[key];
			if (!isPlainObject(block)) {
				notices.push(`Ignored ${key}: expected an object.`);
				continue;
			}
			const chain: Partial<FamilyChain> = {};
			if (typeof block.provider === "string" && PROVIDER_KIND_SET.has(block.provider)) {
				chain.provider = block.provider as ProviderKind;
			}
			if (Array.isArray(block.fallback) && isProviderKindList(block.fallback)) {
				chain.fallback = [...(block.fallback as ProviderKind[])];
			}
			config[key] = chain;
		}
	}

	if ("research" in parsed) {
		const research = parsed.research;
		if (isPlainObject(research)) {
			config.research = { enabled: research.enabled === true };
		} else {
			notices.push(`Ignored research: expected an object.`);
		}
	}

	if ("jev" in parsed) {
		const jev = parsed.jev;
		if (!isPlainObject(jev)) {
			return {
				status: "invalid",
				path: configPath,
				error: invalidConfig(configPath, `"jev" must be an object.`),
			};
		}
		config.jev = jev as WebSearchConfig["jev"];
	}

	if (notices.length > 0) {
		config.notices = notices;
	}

	return { status: "ok", path: configPath, config };
}

export async function resolveSettings(
	path?: string,
): Promise<ResolvedSettings | { error: InvalidConfigError }> {
	const result = await readWebSearchConfig(path);
	if (result.status === "invalid") {
		return { error: result.error };
	}
	return applyConfig(result.path, result.status === "ok" ? result.config : {});
}

export function applyConfig(
	configPath: string,
	config: WebSearchConfig,
): ResolvedSettings {
	const notices: string[] = [...(config.notices ?? [])];
	const web = resolveFamilyChain("web", config, notices);
	const code = resolveFamilyChain("code", config, notices);

	// Legacy top-level provider/fallback still populate the matching family
	// and remain on ResolvedSettings so existing registry tests stay valid.
	const provider = config.provider ?? web.provider;
	const family = config.family ?? providerFamily(provider);
	const configuredFallback = config.fallback ??
		(providerFamily(provider) === "code" ? [...DEFAULT_CODE_FALLBACK] : [...DEFAULT_FALLBACK]);
	const fallback = configuredFallback.filter((kind) => {
		if (providerFamily(kind) === family) {
			return true;
		}
		notices.push(
			`Ignored fallback "${kind}": it answers ${providerFamily(kind)} questions, but this search is scoped to ${family}.`,
		);
		return false;
	});

	if (config.provider && providerFamily(config.provider) === "code") {
		notices.push(
			`Mapped provider "${config.provider}" to code_search. web_search is web-only now.`,
		);
	}
	if (config.family === "code") {
		notices.push(`Legacy family "code" is ignored. Use code_search.`);
	}

	const researchEnabled =
		config.research?.enabled === true ||
		(config.mode === "parallel" && config.research?.enabled !== false);
	if (config.mode === "parallel" && config.research?.enabled !== true) {
		notices.push(
			`Legacy mode "parallel" enables research_search; web_search no longer fans out.`,
		);
	}

	return {
		provider,
		fallback,
		timeoutMs: normalizeTimeoutMs(config.timeoutMs),
		maxResults: clampMaxResults(config.maxResults ?? DEFAULT_MAX_RESULTS),
		configPath,
		mode: config.mode ?? DEFAULT_MODE,
		...(config.family ? { family } : {}),
		web,
		code,
		researchEnabled,
		jev: applyJevConfig(config.jev, notices),
		notices,
	};
}

/** Sync peek used at extension load to decide whether to register research_search. */
export function peekResearchEnabled(path?: string): boolean {
	try {
		const raw = readFileSync(path ?? defaultWebSearchConfigPath(), "utf-8");
		const parsed: unknown = JSON.parse(raw);
		if (!isPlainObject(parsed)) {
			return false;
		}
		if (isPlainObject(parsed.research) && parsed.research.enabled === true) {
			return true;
		}
		return parsed.mode === "parallel";
	} catch {
		return false;
	}
}

function resolveFamilyChain(
	family: ProviderFamily,
	config: WebSearchConfig,
	notices: string[],
): FamilyChain {
	const defaults: FamilyChain = family === "web"
		? { provider: DEFAULT_PROVIDER, fallback: [...DEFAULT_FALLBACK] }
		: { provider: DEFAULT_CODE_PROVIDER, fallback: [...DEFAULT_CODE_FALLBACK] };
	const scoped = family === "web" ? config.web : config.code;
	let provider = scoped?.provider ?? defaults.provider;
	let fallback = scoped?.fallback ?? defaults.fallback;

	if (config.provider && providerFamily(config.provider) === family && !scoped?.provider) {
		provider = config.provider;
	}
	if (config.fallback && providerFamily(provider) === family && !scoped?.fallback) {
		fallback = config.fallback.filter((kind) => providerFamily(kind) === family);
	}

	if (providerFamily(provider) !== family) {
		notices.push(`Ignored ${family}.provider "${provider}": wrong family.`);
		provider = defaults.provider;
	}
	fallback = fallback.filter((kind) => {
		if (providerFamily(kind) === family) {
			return true;
		}
		notices.push(`Ignored ${family} fallback "${kind}": wrong family.`);
		return false;
	});
	return { provider, fallback };
}

function applyJevConfig(
	jev: WebSearchConfig["jev"],
	notices: string[],
): JevSettings {
	if (!isPlainObject(jev)) {
		return { ...DEFAULT_JEV_SETTINGS };
	}
	const numeric = (key: keyof JevSettings, fallback: number): number => {
		const value = jev[key];
		if (value === undefined) {
			return fallback;
		}
		if (typeof value !== "number" || !Number.isFinite(value)) {
			notices.push(`Ignored jev.${key}: not a finite number.`);
			return fallback;
		}
		return value;
	};
	const model = jev.model;
	if (model !== undefined && (typeof model !== "string" || model.length === 0)) {
		notices.push("Ignored jev.model: expected a non-empty string.");
	}
	const backend = jev.backend;
	if (
		backend !== undefined &&
		backend !== "auto" &&
		backend !== "typesafe" &&
		backend !== "vercel"
	) {
		notices.push(`Ignored jev.backend: expected "auto" | "typesafe" | "vercel".`);
	}
	return {
		enabled: jev.enabled === true,
		model: typeof model === "string" && model.length > 0
			? model
			: DEFAULT_JEV_SETTINGS.model,
		backend:
			backend === "auto" || backend === "typesafe" || backend === "vercel"
				? backend
				: DEFAULT_JEV_SETTINGS.backend,
		weights: {
			answers: numericWeight(jev, "answers", notices),
			offtopic: numericWeight(jev, "offtopic", notices),
			selfcontained: numericWeight(jev, "selfcontained", notices),
		},
		safetyThreshold: numeric("safetyThreshold", DEFAULT_JEV_SETTINGS.safetyThreshold),
		maxStateChars: numeric("maxStateChars", DEFAULT_JEV_SETTINGS.maxStateChars),
	};
}

function numericWeight(
	jev: NonNullable<WebSearchConfig["jev"]>,
	key: keyof JevSettings["weights"],
	notices: string[],
): number {
	const value = jev.weights?.[key];
	if (value === undefined) {
		return DEFAULT_JEV_SETTINGS.weights[key];
	}
	if (typeof value !== "number" || !Number.isFinite(value)) {
		notices.push(`Ignored jev.weights.${key}: not a finite number.`);
		return DEFAULT_JEV_SETTINGS.weights[key];
	}
	return value;
}

function quotedList(values: readonly string[]): string {
	return values.map((value) => `"${value}"`).join(" | ");
}

export const MIN_TIMEOUT_MS = 1000;

export function normalizeTimeoutMs(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value) || value <= 0) {
		return DEFAULT_TIMEOUT_MS;
	}
	return Math.max(MIN_TIMEOUT_MS, Math.trunc(value));
}

export function clampMaxResults(value: number): number {
	return Math.min(MAX_MAX_RESULTS, Math.max(MIN_MAX_RESULTS, Math.trunc(value)));
}

function invalidConfig(
	configPath: string,
	message: string,
): InvalidConfigError {
	const error = providerError("invalid_config", message) as InvalidConfigError;
	error.configPath = configPath;
	return error;
}

function isProviderKindList(value: unknown[]): boolean {
	return value.every(
		(entry) => typeof entry === "string" && PROVIDER_KIND_SET.has(entry),
	);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
	return (
		!!error &&
		typeof error === "object" &&
		"code" in error &&
		error.code === "ENOENT"
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
