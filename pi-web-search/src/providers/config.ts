import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { JevBackendSetting } from "../jev/model.ts";
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

export interface FamilyChain {
	provider: ProviderKind;
	fallback: ProviderKind[];
}
export const MIN_MAX_RESULTS = 1;
export const MAX_MAX_RESULTS = 20;
/**
 * Hard cap on the model-facing query. The keyless Exa MCP `objective` embeds the
 * query behind a short prefix and the server rejects objectives above 4096
 * characters, so the query itself must stay comfortably below that.
 */
export const MAX_QUERY_CHARS = 4000;

export const CONFIG_FILE_NAME = "web-search.json";
export const CONFIG_PATH_ENV_VAR = "PI_WEB_SEARCH_CONFIG";

export interface JevSettings {
	enabled: boolean;
	model: string;
	/** `auto` prefers an available Pi TypeSafe classifier, then Vercel for the legacy default. */
	backend: JevBackendSetting;
	/** Weights for the ranking nouls. Policy stays in code, tunable here. */
	weights: { answers: number; offtopic: number; selfcontained: number };
	/** Suppress below this safety probability; the mid-band is held, not passed. */
	safetyThreshold: number;
	/** Skip augmentation when the judged set would exceed this many characters. */
	maxStateChars: number;
}

export interface ResolvedSettings {
	timeoutMs: number;
	maxResults: number;
	configPath: string;
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
	timeoutMs?: number;
	maxResults?: number;
	web?: Partial<FamilyChain>;
	code?: Partial<FamilyChain>;
	research?: { enabled?: boolean };
	jev?: Partial<Omit<JevSettings, "weights">> & {
		weights?: Partial<JevSettings["weights"]>;
	};
}

export type WebSearchConfigResult =
	| { status: "missing"; path: string }
	| { status: "invalid"; path: string; error: InvalidConfigError }
	| { status: "ok"; path: string; config: WebSearchConfig };

const PROVIDER_KIND_SET = new Set<string>(PROVIDER_KINDS);
const CONFIG_KEYS = new Set(["web", "code", "research", "jev", "timeoutMs", "maxResults"]);

export const DEFAULT_JEV_SETTINGS: JevSettings = {
	enabled: false,
	// Legacy setting: mapped explicitly to the catalog's jev-latest or typesafe-ai/jev.
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
		return readFailure(configPath, error);
	}
	return parseWebSearchConfigRaw(raw, configPath);
}

/** Sync twin of `readWebSearchConfig`, used at extension registration. */
export function readWebSearchConfigSync(path?: string): WebSearchConfigResult {
	const configPath = path ?? defaultWebSearchConfigPath();
	let raw: string;
	try {
		raw = readFileSync(configPath, "utf-8");
	} catch (error) {
		return readFailure(configPath, error);
	}
	return parseWebSearchConfigRaw(raw, configPath);
}

function readFailure(
	configPath: string,
	error: unknown,
): WebSearchConfigResult {
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

function parseWebSearchConfigRaw(
	raw: string,
	configPath: string,
): WebSearchConfigResult {
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
	return parseWebSearchConfig(parsed, configPath);
}

/**
 * The single parser: raw JSON in, a validated config out. Both file readers and
 * the extension's load-time resolver use it, so tool exposure and execution can
 * never disagree about `research.enabled`.
 */
export function parseWebSearchConfig(
	parsed: unknown,
	configPath: string,
): WebSearchConfigResult {
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
	const unknown = Object.keys(parsed).filter((key) => !CONFIG_KEYS.has(key));
	if (unknown.length > 0) {
		return {
			status: "invalid", path: configPath,
			error: invalidConfig(configPath, `Unsupported configuration keys: ${unknown.join(", ")}. Use web/code provider chains and research.enabled.`),
		};
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

	for (const key of ["web", "code"] as const) {
		if (!(key in parsed)) continue;
		const block = parsed[key];
		if (!isPlainObject(block) ||
			Object.keys(block).some((field) => field !== "provider" && field !== "fallback") ||
			("provider" in block && (typeof block.provider !== "string" || !PROVIDER_KIND_SET.has(block.provider))) ||
			("fallback" in block && (!Array.isArray(block.fallback) || !isProviderKindList(block.fallback)))) {
			return {
				status: "invalid", path: configPath,
				error: invalidConfig(configPath, `"${key}" must contain only a valid provider and/or fallback array: ${quotedList(PROVIDER_KINDS)}.`),
			};
		}
		config[key] = block as Partial<FamilyChain>;
	}

	if ("research" in parsed) {
		const research = parsed.research;
		if (!isPlainObject(research) ||
			Object.keys(research).some((key) => key !== "enabled") ||
			("enabled" in research && typeof research.enabled !== "boolean")) {
			return {
				status: "invalid", path: configPath,
				error: invalidConfig(configPath, '"research" must be an object with an optional boolean "enabled".'),
			};
		}
		config.research = research;
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
		const unknown = Object.keys(jev).filter((key) => !Object.hasOwn(DEFAULT_JEV_SETTINGS, key));
		if (unknown.length > 0) {
			return {
				status: "invalid", path: configPath,
				error: invalidConfig(configPath, `Unsupported jev keys: ${unknown.join(", ")}.`),
			};
		}
		if ("weights" in jev && (!isPlainObject(jev.weights) ||
			Object.keys(jev.weights).some((key) => !Object.hasOwn(DEFAULT_JEV_SETTINGS.weights, key)))) {
			return {
				status: "invalid", path: configPath,
				error: invalidConfig(configPath, '"jev.weights" must contain only answers, offtopic, and selfcontained.'),
			};
		}
		config.jev = jev as WebSearchConfig["jev"];
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

/**
 * Sync twin of `resolveSettings` for load-time decisions such as whether to
 * register `research_search`. It applies the same parser and the same
 * `research.enabled` switch.
 */
export function resolveSettingsSync(
	path?: string,
): ResolvedSettings | { error: InvalidConfigError } {
	const result = readWebSearchConfigSync(path);
	if (result.status === "invalid") {
		return { error: result.error };
	}
	return applyConfig(result.path, result.status === "ok" ? result.config : {});
}

export function applyConfig(
	configPath: string,
	config: WebSearchConfig,
): ResolvedSettings {
	const notices: string[] = [];
	const web = resolveFamilyChain("web", config, notices);
	const code = resolveFamilyChain("code", config, notices);

	return {
		timeoutMs: normalizeTimeoutMs(config.timeoutMs),
		maxResults: clampMaxResults(config.maxResults ?? DEFAULT_MAX_RESULTS),
		configPath,
		web,
		code,
		researchEnabled: config.research?.enabled === true,
		jev: applyJevConfig(config.jev, notices),
		notices,
	};
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

	if (providerFamily(provider) !== family) {
		notices.push(`Ignored ${family}.provider "${provider}": wrong family.`);
		provider = defaults.provider;
	}
	fallback = fallback.filter((kind) => {
		if (providerFamily(kind) === family) {
			return true;
		}
		notices.push(`Ignored ${family} fallback "${kind}": it answers ${providerFamily(kind)} questions.`);
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
	if (jev.enabled === true && (model === undefined || model === "jev-1.13.0")) {
		notices.push("jev model jev-1.13.0 is a legacy direct-API ID; Pi uses typesafe/jev-latest or vercel-ai-gateway/typesafe-ai/jev instead. Set jev.model to a catalog ID to pin an available classifier.");
	}
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
