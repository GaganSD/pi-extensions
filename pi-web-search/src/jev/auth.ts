import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { readTrimmedEnv } from "../env.ts";

export type JevBackend = "typesafe" | "vercel";
export type JevBackendSetting = "auto" | JevBackend;

export const TYPESAFE_API_URL = "https://api.typesafe.ai/v1/systemone";
export const VERCEL_TYPESAFE_API_URL =
	"https://ai-gateway.vercel.sh/typesafe/v1/systemone";

/** Pinned native model. `jev-latest` moves. */
export const JEV_NATIVE_MODEL = "jev-1.13.0";
/** Vercel AI Gateway catalog id for the same model. */
export const JEV_VERCEL_MODEL = "typesafe-ai/jev";

export interface JevResolvedAuth {
	backend: JevBackend;
	apiKey: string;
	url: string;
	model: string;
}

export interface StoredCredentialLike {
	type?: string;
	key?: string;
}

export interface ResolveJevAuthOptions {
	apiKey?: string;
	backend?: JevBackendSetting;
	/** Configured model; remapped when it does not belong on the chosen backend. */
	model?: string;
	/**
	 * Read Pi's `auth.json`. Off by default so the test suite stays hermetic.
	 * Production search turns this on.
	 */
	usePiAuth?: boolean;
	readCredential?: (providerId: string) => StoredCredentialLike | undefined;
}

const NATIVE_ENV = ["TYPESAFE_API_KEY", "JEV_API_KEY"] as const;
const VERCEL_ENV = ["AI_GATEWAY_API_KEY"] as const;

export function resolveJevAuth(
	options: ResolveJevAuthOptions = {},
): JevResolvedAuth | undefined {
	const backend = options.backend ?? "auto";
	const explicit = trim(options.apiKey);
	if (explicit) {
		const chosen: JevBackend =
			backend === "vercel" || backend === "typesafe" ? backend : "typesafe";
		return pack(chosen, explicit, options.model);
	}

	const nativeEnv = readTrimmedEnv(...NATIVE_ENV);
	const vercelEnv = readTrimmedEnv(...VERCEL_ENV);
	if (backend === "typesafe") {
		return nativeEnv
			? pack("typesafe", nativeEnv, options.model)
			: fromPiAuth("typesafe", options);
	}
	if (backend === "vercel") {
		return vercelEnv
			? pack("vercel", vercelEnv, options.model)
			: fromPiAuth("vercel", options);
	}

	if (nativeEnv) {
		return pack("typesafe", nativeEnv, options.model);
	}
	if (vercelEnv) {
		return pack("vercel", vercelEnv, options.model);
	}

	return fromPiAuth("typesafe", options) ?? fromPiAuth("vercel", options);
}

/** True when any supported Jev credential is resolvable. */
export function hasJevAuth(options: ResolveJevAuthOptions = {}): boolean {
	return resolveJevAuth(options) !== undefined;
}

function fromPiAuth(
	backend: JevBackend,
	options: ResolveJevAuthOptions,
): JevResolvedAuth | undefined {
	if (options.usePiAuth !== true) {
		return undefined;
	}
	const providerId = backend === "typesafe" ? "typesafe" : "vercel-ai-gateway";
	const reader = options.readCredential ?? readPiCredential;
	const stored = reader(providerId);
	const key = trim(stored?.key);
	return key ? pack(backend, key, options.model) : undefined;
}

function readPiCredential(providerId: string): StoredCredentialLike | undefined {
	try {
		return readStoredCredential(providerId);
	} catch {
		return undefined;
	}
}

function pack(
	backend: JevBackend,
	apiKey: string,
	configuredModel?: string,
): JevResolvedAuth {
	return {
		backend,
		apiKey,
		url: backend === "vercel" ? VERCEL_TYPESAFE_API_URL : TYPESAFE_API_URL,
		model: modelFor(backend, configuredModel),
	};
}

/**
 * Each backend has its own catalog name. A pinned native id must not be sent
 * to Vercel, and a gateway id must not be sent to TypeSafe.
 */
export function modelFor(
	backend: JevBackend,
	configured?: string,
): string {
	const model = trim(configured);
	if (!model) {
		return backend === "vercel" ? JEV_VERCEL_MODEL : JEV_NATIVE_MODEL;
	}
	if (backend === "vercel" && (model.startsWith("jev-") || model === "jev-latest")) {
		return JEV_VERCEL_MODEL;
	}
	if (backend === "typesafe" && model.includes("/")) {
		return JEV_NATIVE_MODEL;
	}
	return model;
}

function trim(value: string | undefined): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}
