import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import { githubToken, parallelApiKey } from "../env.ts";
import { type ResolvedSettings } from "./config.ts";
import { mergeStreamResults } from "./results.ts";
import {
	DEFAULT_CHAIN,
	PROVIDER_KINDS,
	type ProviderError,
	type ProviderFamily,
	type ProviderKind,
	type StreamResult,
	isProviderError,
	providerError,
	providerFamily,
} from "./types.ts";

export interface SearchRequest {
	query: string;
	urls?: string[];
	signal?: AbortSignal;
	onUpdate?: AgentToolUpdateCallback;
	settings: ResolvedSettings;
}

/** What a transport gets; identical to SearchRequest so transports stay thin. */
export type SearchTransport = (req: SearchRequest) => Promise<StreamResult>;

export type ProviderTransportMap = Partial<Record<ProviderKind, SearchTransport>>;

export interface RunSearchOptions {
	/** Injected transports win over the default Exa/Parallel ones. */
	transports?: ProviderTransportMap;
	/** Injected credential knowledge wins over `providerAvailability()`. */
	availability?: Partial<Record<ProviderKind, boolean>>;
	/** Overrides how the default transports are loaded. */
	loadTransports?: () => Promise<ProviderTransportMap>;
	/** Set by the Jev router. Confines the chain to one family. */
	family?: ProviderFamily;
}

export type RunSearchResult =
	| { ok: true; result: StreamResult; provider: ProviderKind }
	| { ok: false; error: ProviderError };

/**
 * Credential knowledge at the registry level. Exa and grep.app are keyless
 * (hosted MCP). Parallel and GitHub always need an API key.
 */
export function providerAvailability(): Record<ProviderKind, boolean> {
	return {
		exa: true,
		parallel: hasParallelKey(),
		grep: true,
		github: hasGitHubToken(),
	};
}

/**
 * Providers that will actually run. `family` confines the set; without it
 * every available source is eligible. Config order wins, then family defaults.
 */
export function listRunnableProviders(
	settings: ResolvedSettings,
	availability: Partial<Record<ProviderKind, boolean>> = providerAvailability(),
	family?: ProviderFamily,
): ProviderKind[] {
	const target = family ?? settings.family;
	const preferred = [settings.provider, ...settings.fallback, ...PROVIDER_KINDS];
	const chain: ProviderKind[] = [];
	for (const kind of preferred) {
		if (
			availability[kind] === true &&
			!chain.includes(kind) &&
			(target === undefined || providerFamily(kind) === target)
		) {
			chain.push(kind);
		}
	}
	if (chain.length === 0 && target !== undefined) {
		for (const kind of DEFAULT_CHAIN[target]) {
			if (availability[kind] === true && !chain.includes(kind)) {
				chain.push(kind);
			}
		}
	}
	return chain;
}

/**
 * The chain is confined to one family. Config order wins when it yields a
 * usable provider in that family; otherwise the family default is used, so
 * routing to `code` still works for an operator who only ever configured `exa`.
 */
export function resolveProviderChain(
	settings: ResolvedSettings,
	availability: Partial<Record<ProviderKind, boolean>> = providerAvailability(),
	family?: ProviderFamily,
): ProviderKind[] {
	const target = family ?? settings.family ?? providerFamily(settings.provider);
	const chain: ProviderKind[] = [];
	const add = (kind: ProviderKind) => {
		if (
			providerFamily(kind) === target &&
			availability[kind] === true &&
			!chain.includes(kind)
		) {
			chain.push(kind);
		}
	};

	for (const kind of [settings.provider, ...settings.fallback]) {
		add(kind);
	}
	if (chain.length === 0) {
		for (const kind of DEFAULT_CHAIN[target]) {
			add(kind);
		}
	}
	return chain;
}

/**
 * Walks the chain in order. Retryable errors continue to the next entry;
 * a non-retryable error (including `missing_credentials` and `aborted`)
 * propagates immediately. The last error is what surfaces.
 */
export async function runSearch(
	req: SearchRequest,
	options: RunSearchOptions = {},
): Promise<StreamResult> {
	const attempt = await tryRunSearch(req, options);
	if (attempt.ok) {
		return attempt.result;
	}
	throw attempt.error;
}

/** Same walk as `runSearch`, but reports the provider that produced the result. */
export async function tryRunSearch(
	req: SearchRequest,
	options: RunSearchOptions = {},
): Promise<RunSearchResult> {
	const chain = resolveProviderChain(
		req.settings,
		options.availability,
		options.family,
	);
	if (chain.length === 0) {
		return {
			ok: false,
			error: missingCredentials(
				req.settings.provider,
				describeNoCredentials(req.settings, options.family),
			),
		};
	}

	const loadTransports = options.loadTransports ?? loadDefaultTransports;
	// A loader failure must degrade to "no transports", never throw out of here.
	const transports = options.transports ??
		(await loadTransports().catch(() => ({} as ProviderTransportMap)));
	let lastError: ProviderError = missingCredentials(
		chain[0],
		`No transport registered for ${chain[0]}.`,
	);

	for (const kind of chain) {
		if (req.signal?.aborted === true) {
			return { ok: false, error: aborted(req.signal.reason) };
		}
		const transport = transports[kind];
		if (!transport) {
			lastError = missingCredentials(
				kind,
				`No transport is registered for ${kind}.`,
			);
			continue;
		}
		try {
			const result = await transport(req);
			return { ok: true, result, provider: kind };
		} catch (error) {
			const providerErr = toProviderError(error);
			if (providerErr.code === "aborted" || providerErr.retryable !== true) {
				return { ok: false, error: providerErr };
			}
			lastError = providerErr;
		}
	}

	return { ok: false, error: lastError };
}

function missingCredentials(kind: ProviderKind, message: string): ProviderError {
	return providerError("missing_credentials", `${kind}: ${message}`);
}

function isAborted(signal: AbortSignal | undefined): boolean {
	return signal !== undefined && signal.aborted;
}

function aborted(reason: unknown): ProviderError {
	if (isProviderError(reason) && reason.code === "aborted") {
		return reason;
	}
	return providerError("aborted", "web_search was aborted.");
}

function toProviderError(error: unknown): ProviderError {
	if (isProviderError(error)) {
		return error;
	}
	const message = error instanceof Error ? error.message : String(error);
	return providerError("unknown", message);
}

/**
 * Trimmed: the transports trim before use, so an untrimmed check would treat a
 * whitespace-only key as present and then fail non-retryably, which suppresses
 * the fallback it was supposed to enable.
 */
export function hasParallelKey(): boolean {
	return parallelApiKey() !== undefined;
}

export function hasGitHubToken(): boolean {
	return githubToken() !== undefined;
}

/**
 * Runs every available provider at once and merges what comes back.
 *
 * Edge cases:
 * - missing credentials skip that source with a warning
 * - a missing transport skips that source with a warning
 * - one provider failing does not fail the search
 * - empty hits are kept as a warning, not an error
 * - user abort cancels the whole fan-out and is never treated as partial success
 * - if every provider fails, the last error surfaces
 */
export async function runParallelSearch(
	req: SearchRequest,
	options: RunSearchOptions = {},
): Promise<StreamResult> {
	const attempt = await tryRunParallelSearch(req, options);
	if (attempt.ok) {
		return attempt.result;
	}
	throw attempt.error;
}

export async function tryRunParallelSearch(
	req: SearchRequest,
	options: RunSearchOptions = {},
): Promise<RunSearchResult> {
	if (isAborted(req.signal)) {
		return { ok: false, error: aborted(req.signal?.reason) };
	}

	const kinds = listRunnableProviders(
		req.settings,
		options.availability,
		options.family,
	);
	if (kinds.length === 0) {
		return {
			ok: false,
			error: missingCredentials(
				req.settings.provider,
				describeNoCredentials(req.settings, options.family),
			),
		};
	}

	const loadTransports = options.loadTransports ?? loadDefaultTransports;
	const transports =
		options.transports ??
		(await loadTransports().catch(() => ({} as ProviderTransportMap)));

	const warnings: string[] = [];
	const runnable: ProviderKind[] = [];
	for (const kind of kinds) {
		if (!transports[kind]) {
			warnings.push(`No transport is registered for ${kind}.`);
			continue;
		}
		runnable.push(kind);
	}
	if (runnable.length === 0) {
		return {
			ok: false,
			error: missingCredentials(
				kinds[0],
				`No transport registered for ${kinds.join(", ")}.`,
			),
		};
	}

	const settled = await Promise.allSettled(
		runnable.map(async (kind) => {
			const transport = transports[kind];
			if (!transport) {
				throw missingCredentials(kind, `No transport is registered for ${kind}.`);
			}
			return { kind, result: await transport(req) };
		}),
	);

	if (isAborted(req.signal)) {
		return { ok: false, error: aborted(req.signal?.reason) };
	}

	const successes: { kind: ProviderKind; result: StreamResult }[] = [];
	let lastError: ProviderError | undefined;
	for (let i = 0; i < settled.length; i++) {
		const kind = runnable[i];
		const item = settled[i];
		if (item.status === "fulfilled") {
			const { result } = item.value;
			const hits = result.searchResults?.length ?? 0;
			if (hits === 0) {
				warnings.push(`${kind} returned no results.`);
			}
			successes.push(item.value);
			continue;
		}
		const err = toProviderError(item.reason);
		if (err.code === "aborted") {
			return { ok: false, error: err };
		}
		lastError = err;
		warnings.push(`${kind} failed (${err.code}): ${err.message}`);
	}

	if (successes.length === 0) {
		return {
			ok: false,
			error:
				lastError ??
				missingCredentials(runnable[0], "Every parallel provider failed."),
		};
	}

	const merged = mergeStreamResults(successes, warnings);
	return { ok: true, result: merged, provider: successes[0].kind };
}

/** Names the credential that would actually unlock the family in question. */
function describeNoCredentials(
	settings: ResolvedSettings,
	family?: ProviderFamily,
): string {
	const target = family ?? settings.family ?? providerFamily(settings.provider);
	const hint = target === "code"
		? "Set GITHUB_TOKEN to enable the GitHub code-search fallback."
		: "Set PARALLEL_API_KEY for the Parallel web fallback, or EXA_API_KEY for keyed Exa.";
	return `No ${target} provider has credentials. ${hint}`;
}

/**
 * Real transports are loaded lazily so the registry stays usable with injected
 * fakes and never forces the MCP/REST modules to load in offline tests. A
 * transport that is missing or throws on import is simply left out of the map,
 * so the chain skips that provider instead of failing the whole search.
 */
async function loadDefaultTransports(): Promise<ProviderTransportMap> {
	const [exa, parallel, grep, github] = await Promise.all([
		import("./exa.ts").catch(() => undefined),
		import("./parallel.ts").catch(() => undefined),
		import("./grep.ts").catch(() => undefined),
		import("./github.ts").catch(() => undefined),
	]);
	const map: ProviderTransportMap = {};
	const assign = (kind: ProviderKind, fn: unknown) => {
		if (typeof fn === "function") {
			map[kind] = fn as SearchTransport;
		}
	};
	assign("exa", exa?.exaSearch);
	assign("parallel", parallel?.parallelSearch);
	assign("grep", grep?.grepSearch);
	assign("github", github?.githubSearch);
	return map;
}
