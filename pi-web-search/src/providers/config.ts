import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_CHAIN,
	PROVIDER_KINDS,
	type ProviderError,
	type ProviderFamily,
	providerError,
	type ProviderKind,
	providerFamily,
} from "./types.ts";

export const DEFAULT_PROVIDER: ProviderKind = "exa";
export const DEFAULT_FALLBACK: ProviderKind[] = ["parallel"];
export const DEFAULT_TIMEOUT_MS = 20000;
export const DEFAULT_MAX_RESULTS = 8;
export const MIN_MAX_RESULTS = 1;
export const MAX_MAX_RESULTS = 20;

export const CONFIG_FILE_NAME = "web-search.json";
export const CONFIG_PATH_ENV_VAR = "PI_WEB_SEARCH_CONFIG";

export interface JevSettings {
	enabled: boolean;
	model: string;
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
	/** Pins the family, skipping Jev routing entirely when set. */
	family?: ProviderFamily;
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
	family?: ProviderFamily;
	jev?: Partial<Omit<JevSettings, "weights">> & {
		weights?: Partial<JevSettings["weights"]>;
	};
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
	// Unknown keys are ignored, not rejected.
	if ("provider" in parsed) {
		const provider = parsed.provider;
		if (typeof provider !== "string" || !PROVIDER_KIND_SET.has(provider)) {
			return {
				status: "invalid",
				path: configPath,
				error: invalidConfig(
					configPath,
					`Unknown provider ${JSON.stringify(provider)}; expected ${quotedList(PROVIDER_KINDS)}.`,
				),
			};
		}
		config.provider = provider as ProviderKind;
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
	const provider = config.provider ?? DEFAULT_PROVIDER;
	const family = config.family ?? providerFamily(provider);
	const notices: string[] = [];

	// A fallback may never cross a family boundary. Dropping it silently would
	// leave the operator believing a fallback exists when none does.
	const configuredFallback = config.fallback ?? [...DEFAULT_FALLBACK];
	const fallback = configuredFallback.filter((kind) => {
		if (providerFamily(kind) === family) {
			return true;
		}
		notices.push(
			`Ignored fallback "${kind}": it answers ${providerFamily(kind)} questions, but this search is scoped to ${family}.`,
		);
		return false;
	});

	return {
		provider,
		fallback,
		timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		maxResults: clampMaxResults(config.maxResults ?? DEFAULT_MAX_RESULTS),
		configPath,
		...(config.family ? { family } : {}),
		jev: applyJevConfig(config.jev, notices),
		notices,
	};
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
	return {
		enabled: jev.enabled === true,
		model: typeof model === "string" && model.length > 0
			? model
			: DEFAULT_JEV_SETTINGS.model,
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
