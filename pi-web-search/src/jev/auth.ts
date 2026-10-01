import {
	type CredentialProviderId,
	type StoredCredentialLike,
	resolveCredential,
} from "../env.ts";

export type JevBackend = "typesafe" | "vercel";
export type JevBackendSetting = "auto" | JevBackend;

export const TYPESAFE_API_URL = "https://api.typesafe.ai/v1/systemone";
export const VERCEL_TYPESAFE_API_URL =
	"https://ai-gateway.vercel.sh/typesafe/v1/systemone";

/** Pinned native model. `jev-latest` moves. */
export const JEV_NATIVE_MODEL = "jev-1.13.0";
/** Vercel AI Gateway catalog id for the same model. */
export const JEV_VERCEL_MODEL = "typesafe-ai/jev";

/** Credential ids Jev can resolve through the one shared resolver in env.ts. */
const NATIVE_PROVIDER: CredentialProviderId = "typesafe";
const VERCEL_PROVIDER: CredentialProviderId = "vercel-ai-gateway";

export interface JevResolvedAuth {
	backend: JevBackend;
	apiKey: string;
	url: string;
	model: string;
}

export type { StoredCredentialLike };

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
	readCredential?: (providerId: CredentialProviderId) => StoredCredentialLike | undefined;
	/** Env source; defaults to `process.env`. Injected by tests. */
	env?: NodeJS.ProcessEnv;
	/** auth.json path; read fresh on each call. Injected by tests. */
	authPath?: string;
}

/**
 * Resolves a Jev credential through the same alias table and precedence rule as
 * every search provider (see `env.ts`): all env aliases first, then the current
 * stored value. There is no Jev-specific secret store or env list.
 */
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

	const nativeEnv = envKey(NATIVE_PROVIDER, options);
	const vercelEnv = envKey(VERCEL_PROVIDER, options);
	if (backend === "typesafe") {
		return nativeEnv
			? pack("typesafe", nativeEnv, options.model)
			: stored("typesafe", options);
	}
	if (backend === "vercel") {
		return vercelEnv
			? pack("vercel", vercelEnv, options.model)
			: stored("vercel", options);
	}

	if (nativeEnv) {
		return pack("typesafe", nativeEnv, options.model);
	}
	if (vercelEnv) {
		return pack("vercel", vercelEnv, options.model);
	}

	return stored("typesafe", options) ?? stored("vercel", options);
}

/** True when any supported Jev credential is resolvable. */
export function hasJevAuth(options: ResolveJevAuthOptions = {}): boolean {
	return resolveJevAuth(options) !== undefined;
}

/** Env-only lookup; the shared resolver owns the alias table and precedence. */
function envKey(
	providerId: CredentialProviderId,
	options: ResolveJevAuthOptions,
): string | undefined {
	return resolveCredential(providerId, {
		env: options.env,
		// Env is handled here; the stored value is a separate, gated step.
		readCredential: () => undefined,
	})?.key;
}

/**
 * Stored-credential lookup, gated on `usePiAuth` so a bare import never reads
 * the operator's secrets. Delegates to the shared resolver, so rotating or
 * removing a key in auth.json is observed on the next call.
 */
function stored(
	backend: JevBackend,
	options: ResolveJevAuthOptions,
): JevResolvedAuth | undefined {
	if (options.usePiAuth !== true) {
		return undefined;
	}
	const providerId = backend === "typesafe" ? NATIVE_PROVIDER : VERCEL_PROVIDER;
	const key = resolveCredential(providerId, {
		env: {},
		readCredential: options.readCredential,
		authPath: options.authPath,
	})?.key;
	return key ? pack(backend, key, options.model) : undefined;
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
