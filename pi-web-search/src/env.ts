import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	getAgentDir,
	readStoredCredential,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";

/** Retrieval credentials only. Pi owns all classifier authentication. */
export type CredentialProviderId = "exa" | "parallel" | "github" | "brave";

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
	brave: ["BRAVE_API_KEY", "BRAVE_SEARCH_API_KEY"],
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

export function braveApiKey(options?: CredentialResolverOptions): string | undefined {
	return resolveCredential("brave", options)?.key;
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

export function defaultAuthPath(): string {
	return join(getAgentDir(), "auth.json");
}

/** Merge a literal API key into auth.json. Never logs the key. */
export async function storeApiKey(
	providerId: CredentialProviderId,
	key: string,
	authPath?: string,
): Promise<{ path: string; replaced: boolean }> {
	const trimmed = trim(key);
	if (trimmed === undefined) {
		throw new Error("API key is empty.");
	}
	const result = await mutateAuth(authPath, (current) => {
		const existing = current[providerId];
		const replaced = isPlainObject(existing);
		current[providerId] = { type: "api_key", key: trimmed };
		return { write: true, flag: replaced };
	});
	return { path: result.path, replaced: result.flag };
}

async function mutateAuth(
	authPath: string | undefined,
	mutate: (current: Record<string, unknown>) => { write: boolean; flag: boolean },
): Promise<{ path: string; flag: boolean }> {
	const path = authPath ?? defaultAuthPath();
	const targetPath = await realpath(path).catch((error) => {
		if (isMissingFileError(error)) {
			return path;
		}
		throw error;
	});
	return withFileMutationQueue(targetPath, async () => {
		const current = await readAuthObject(targetPath);
		const { write, flag } = mutate(current);
		if (!write) {
			return { path, flag };
		}
		await mkdir(dirname(targetPath), { recursive: true });
		const temporary = `${targetPath}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, `${JSON.stringify(current, null, 2)}\n`, {
				mode: 0o600,
				flag: "wx",
			});
			await rename(temporary, targetPath);
		} finally {
			await unlink(temporary).catch(() => {});
		}
		return { path, flag };
	});
}

async function readAuthObject(path: string): Promise<Record<string, unknown>> {
	try {
		const raw = await readFile(path, "utf-8");
		const parsed: unknown = JSON.parse(raw);
		if (!isPlainObject(parsed)) {
			throw new Error("auth.json is not a JSON object. It was not changed.");
		}
		return parsed;
	} catch (error) {
		if (isMissingFileError(error)) {
			return {};
		}
		if (error instanceof SyntaxError) {
			throw new Error("auth.json is malformed. It was not changed.", { cause: error });
		}
		throw error;
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
	return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function trim(value: string | undefined): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}
