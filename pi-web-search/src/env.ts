import { spawnSync } from "node:child_process";
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
	/** Last-resort GitHub CLI token. Injected by tests; never logged. */
	readGhToken?: () => string | undefined;
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
	const resolved = resolveCredential("github", options);
	if (resolved !== undefined) {
		return resolved.key;
	}
	if (options?.readGhToken) {
		return trim(options.readGhToken());
	}
	// Explicit test resolvers must not spawn `gh` on the operator machine.
	if (options !== undefined) {
		return undefined;
	}
	return trim(readGhCliToken());
}

/** Always github.com — never the CLI default host, which may be Enterprise. */
export const GH_CLI_TOKEN_ARGS = ["auth", "token", "--hostname", "github.com"] as const;

let ghCliCache: { value: string | undefined; at: number } | undefined;
const GH_CLI_CACHE_MS = 30_000;

/**
 * Uses an already-authenticated github.com CLI login. Disabled under `node:test`
 * so suite machines with `gh auth` do not silently change availability.
 */
export function readGhCliToken(
	spawn: typeof spawnSync = spawnSync,
): string | undefined {
	if (process.env.NODE_TEST_CONTEXT) {
		return undefined;
	}
	const now = Date.now();
	if (ghCliCache && now - ghCliCache.at < GH_CLI_CACHE_MS) {
		return ghCliCache.value;
	}
	try {
		const result = spawn("gh", [...GH_CLI_TOKEN_ARGS], {
			encoding: "utf8",
			timeout: 2000,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const value = result.status === 0 && typeof result.stdout === "string"
			? result.stdout
			: undefined;
		ghCliCache = { value, at: now };
		return value;
	} catch {
		ghCliCache = { value: undefined, at: now };
		return undefined;
	}
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
