import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	type ProviderError,
	providerError,
	type ProviderKind,
} from "./types.ts";

export const DEFAULT_PROVIDER: ProviderKind = "exa";
export const DEFAULT_FALLBACK: ProviderKind[] = ["parallel"];
export const DEFAULT_TIMEOUT_MS = 20000;
export const DEFAULT_MAX_RESULTS = 8;
export const MIN_MAX_RESULTS = 1;
export const MAX_MAX_RESULTS = 20;

export const CONFIG_FILE_NAME = "web-search.json";
export const CONFIG_PATH_ENV_VAR = "PI_WEB_SEARCH_CONFIG";

export interface ResolvedSettings {
	provider: ProviderKind;
	fallback: ProviderKind[];
	timeoutMs: number;
	maxResults: number;
	configPath: string;
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
}

export type WebSearchConfigResult =
	| { status: "missing"; path: string }
	| { status: "invalid"; path: string; error: InvalidConfigError }
	| { status: "ok"; path: string; config: WebSearchConfig };

const PROVIDER_KINDS = new Set<string>(["exa", "parallel"]);

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
		if (typeof provider !== "string" || !PROVIDER_KINDS.has(provider)) {
			return {
				status: "invalid",
				path: configPath,
				error: invalidConfig(
					configPath,
					`Unknown provider ${JSON.stringify(provider)}; expected "exa" or "parallel".`,
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
					`"fallback" must be an array of "exa" | "parallel".`,
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
	return {
		provider: config.provider ?? DEFAULT_PROVIDER,
		fallback: config.fallback ? [...config.fallback] : [...DEFAULT_FALLBACK],
		timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		maxResults: clampMaxResults(config.maxResults ?? DEFAULT_MAX_RESULTS),
		configPath,
	};
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
		(entry) => typeof entry === "string" && PROVIDER_KINDS.has(entry),
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
