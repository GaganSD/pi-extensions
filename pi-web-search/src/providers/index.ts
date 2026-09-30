import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import { type ResolvedSettings } from "./config.ts";
import {
	type ProviderError,
	type ProviderKind,
	type StreamResult,
	isProviderError,
	providerError,
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
	availability?: Record<ProviderKind, boolean>;
	/** Overrides how the default transports are loaded. */
	loadTransports?: () => Promise<ProviderTransportMap>;
}

export type RunSearchResult =
	| { ok: true; result: StreamResult; provider: ProviderKind }
	| { ok: false; error: ProviderError };

/**
 * Credential knowledge at the registry level. Exa is keyless-capable (hosted
 * MCP), Parallel always needs an API key.
 */
export function providerAvailability(): Record<ProviderKind, boolean> {
	return {
		exa: true,
		parallel: hasParallelKey(),
	};
}

export function resolveProviderChain(
	settings: ResolvedSettings,
	availability: Record<ProviderKind, boolean> = providerAvailability(),
): ProviderKind[] {
	const chain: ProviderKind[] = [];
	for (const kind of [settings.provider, ...settings.fallback]) {
		if (!availability[kind]) {
			continue;
		}
		if (!chain.includes(kind)) {
			chain.push(kind);
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
	const chain = resolveProviderChain(req.settings, options.availability);
	if (chain.length === 0) {
		return {
			ok: false,
			error: missingCredentials(
				req.settings.provider,
				`No configured provider has credentials. Set PARALLEL_API_KEY or add ${req.settings.provider === "parallel" ? "EXA_API_KEY" : "PARALLEL_API_KEY"}.`,
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

function hasParallelKey(): boolean {
	const key = process.env.PARALLEL_API_KEY;
	return typeof key === "string" && key.length > 0;
}

/**
 * Real transports are loaded lazily so the registry stays usable with injected
 * fakes and never forces the MCP/REST modules to load in offline tests. A
 * transport that is missing or throws on import is simply left out of the map,
 * so the chain skips that provider instead of failing the whole search.
 */
async function loadDefaultTransports(): Promise<ProviderTransportMap> {
	const [exa, parallel] = await Promise.all([
		import("./exa.ts").catch(() => undefined),
		import("./parallel.ts").catch(() => undefined),
	]);
	const map: ProviderTransportMap = {};
	const exaSearch = exa?.exaSearch;
	if (typeof exaSearch === "function") {
		map.exa = exaSearch;
	}
	const parallelSearch = parallel?.parallelSearch;
	if (typeof parallelSearch === "function") {
		map.parallel = parallelSearch;
	}
	return map;
}
