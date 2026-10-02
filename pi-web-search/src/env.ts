import { join } from "node:path";
import {
	getAgentDir,
	readStoredCredential,
} from "@earendil-works/pi-coding-agent";

/** Retrieval credentials only. Pi owns all classifier authentication. */
export type CredentialProviderId = "exa" | "parallel" | "github";

/**
 * Environment aliases per credential, highest precedence first. Every nonblank
 * alias beats the current auth.json value, so rotating or removing a stored key
 * is observed by the next operation without reloading the extension.
 */
export const CREDENTIAL_ENV_ALIASES: Record<
	CredentialProviderId,
	readonly string[]
> = {
	exa: ["EXA_API_KEY"],
	parallel: ["PARALLEL_API_KEY"],
	github: ["GITHUB_TOKEN", "GH_TOKEN"],
};

export const CREDENTIAL_PROVIDER_IDS = Object.keys(
	CREDENTIAL_ENV_ALIASES,
) as CredentialProviderId[];

export interface StoredCredentialLike {
	type?: string;
	key?: string;
}

export type CredentialSource = "env" | "auth";

export interface ResolvedCredential {
	key: string;
	/** Where the key came from. Only for diagnostics; never the key itself. */
	source: CredentialSource;
	/** The env var or provider id that supplied the key. */
	name: string;
}

export type CredentialReader = (
	providerId: CredentialProviderId,
) => StoredCredentialLike | undefined;

export interface CredentialResolverOptions {
	/** Env source; defaults to `process.env`. Injected by tests. */
	env?: NodeJS.ProcessEnv;
	/** Fully replaces the stored-credential source. Injected by tests. */
	readCredential?: CredentialReader;
	/** auth.json path; read fresh on each call. Injected by tests. */
	authPath?: string;
}

let storedReader: CredentialReader | undefined;

/**
 * Read stored credentials from Pi's auth.json. Called once by the extension
 * entrypoint. Until it is called, stored credentials are absent, so a bare
 * import of the tools (or the test suite) never touches the operator's secrets.
 * The reader reads the file on every call: no immortal secret cache.
 */
export function enableStoredCredentials(authPath?: string): void {
	storedReader = readerForPath(authPath ?? join(getAgentDir(), "auth.json"));
}

/** Restores the default "no stored credentials" state. */
export function disableStoredCredentials(): void {
	storedReader = undefined;
}

/**
 * The single credential resolver. It evaluates every nonblank env alias first,
 * then reads the current stored value. Nothing is cached across calls, so a
 * rotated or removed auth.json key takes effect on the next operation.
 */
export function resolveCredential(
	providerId: CredentialProviderId,
	options: CredentialResolverOptions = {},
): ResolvedCredential | undefined {
	const env = options.env ?? process.env;
	for (const name of CREDENTIAL_ENV_ALIASES[providerId]) {
		const value = trim(env[name]);
		if (value !== undefined) {
			return { key: value, source: "env", name };
		}
	}
	const reader = options.readCredential ??
		(options.authPath !== undefined
			? readerForPath(options.authPath)
			: storedReader);
	const key = trim(reader?.(providerId)?.key);
	return key === undefined ? undefined : { key, source: "auth", name: providerId };
}

export function exaApiKey(
	options?: CredentialResolverOptions,
): string | undefined {
	return resolveCredential("exa", options)?.key;
}

export function parallelApiKey(
	options?: CredentialResolverOptions,
): string | undefined {
	return resolveCredential("parallel", options)?.key;
}

export function githubToken(
	options?: CredentialResolverOptions,
): string | undefined {
	return resolveCredential("github", options)?.key;
}

function readerForPath(authPath: string): CredentialReader {
	return (providerId) => {
		try {
			return readStoredCredential(providerId, authPath);
		} catch {
			// auth.json is optional and may be malformed; a missing key is absent.
			return undefined;
		}
	};
}

function trim(value: string | undefined): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}
