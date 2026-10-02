import type { AgentToolUpdateCallback, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { githubToken, parallelApiKey } from "../env.ts";
import { type ResolvedSettings } from "./config.ts";
import { awaitWithSignal } from "./http.ts";
import { mergeStreamResults } from "./results.ts";
import {
	DEFAULT_CHAIN,
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
	/** Present only for registered Pi tools; forwarded per operation, never cached. */
	runtime?: ExtensionToolContext;
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
	/** The tool scope; omitted only for cross-family research. */
	family?: ProviderFamily;
}

/**
 * Capability knowledge at the registry level. Parallel's native MCP server
 * is anonymous by default; connection errors surface from the host call.
 */
export function providerAvailability(): Record<ProviderKind, boolean> {
	return {
		exa: true,
		parallel: true,
		grep: true,
		sourcegraph: true,
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
	const families = family ? [family] : ["web", "code"] as const;
	const preferred = families.flatMap((scope) => [settings[scope].provider, ...settings[scope].fallback, ...DEFAULT_CHAIN[scope]]);
	const chain: ProviderKind[] = [];
	for (const kind of preferred) {
		if (
			availability[kind] === true &&
			!chain.includes(kind)
		) {
			chain.push(kind);
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
	family: ProviderFamily = "web",
): ProviderKind[] {
	const configured = settings[family];
	const chain: ProviderKind[] = [];
	const add = (kind: ProviderKind) => {
		if (
			providerFamily(kind) === family &&
			availability[kind] === true &&
			!chain.includes(kind)
		) {
			chain.push(kind);
		}
	};

	for (const kind of [configured.provider, ...configured.fallback]) {
		add(kind);
	}
	if (chain.length === 0) {
		for (const kind of DEFAULT_CHAIN[family]) {
			add(kind);
		}
	}
	return chain;
}

/**
 * Walks the chain in order. Retryable errors continue to the next entry;
 * a non-retryable error (including `missing_credentials` and `aborted`)
 * propagates immediately. The last error is what surfaces.
 *
 * A parent operation abort (e.g. a deadline signal composed with `withTimeout`)
 * stops the walk immediately, so a stage timeout stays retryable while an
 * operation timeout is never mistaken for a user abort.
 */
export async function runSearch(
	req: SearchRequest,
	options: RunSearchOptions = {},
): Promise<StreamResult> {
	if (isAborted(req.signal)) throw abortReason(req.signal?.reason);
	const chain = resolveProviderChain(req.settings, options.availability, options.family);
	if (chain.length === 0) {
		throw missingCredentials(req.settings[options.family ?? "web"].provider, describeNoCredentials(options.family));
	}

	const transports = await searchTransports(req, options);
	let lastError: ProviderError = missingCredentials(
		chain[0],
		`No transport registered for ${chain[0]}.`,
	);
	const notes: string[] = [];
	let lastEmpty: StreamResult | undefined;

	for (let i = 0; i < chain.length; i++) {
		const kind = chain[i];
		if (isAborted(req.signal)) {
			throw abortReason(req.signal?.reason);
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
			const result = await runTransport(transport, req);
			const hits = result.searchResults?.length ?? 0;
			const more = i < chain.length - 1 && options.family === "code";
			if (hits === 0 && more) {
				notes.push(`${kind} returned no results.`);
				lastEmpty = withNotes(result, notes);
				continue;
			}
			return notes.length > 0 ? withNotes(result, notes) : result;
		} catch (error) {
			if (isAborted(req.signal)) {
				throw abortReason(req.signal?.reason);
			}
			const providerErr = toProviderError(error);
			if (providerErr.code === "aborted" || providerErr.retryable !== true) {
				throw providerErr;
			}
			lastError = providerErr;
			notes.push(`${kind} failed (${providerErr.code}): ${providerErr.message}`);
		}
	}

	if (lastEmpty) {
		return withNotes(lastEmpty, notes);
	}
	throw lastError;
}

function withNotes(result: StreamResult, notes: string[]): StreamResult {
	const extra = notes.filter((note) => !(result.warnings ?? []).includes(note));
	return extra.length === 0 ? result : {
		...result,
		warnings: [...(result.warnings ?? []), ...extra],
	};
}

/** Loader failures skip transports, but operation cancellation must not degrade. */
async function searchTransports(req: SearchRequest, options: RunSearchOptions): Promise<ProviderTransportMap> {
	if (isAborted(req.signal)) throw abortReason(req.signal?.reason);
	const pending = options.transports
		? Promise.resolve(options.transports)
		: Promise.resolve().then(options.loadTransports ?? loadDefaultTransports).catch(() => ({} as ProviderTransportMap));
	const transports = req.signal ? await awaitWithSignal(pending, req.signal) : await pending;
	if (isAborted(req.signal)) throw abortReason(req.signal?.reason);
	return transports;
}

/** Bound even signal-ignoring transports and stop their late progress updates. */
async function runTransport(transport: SearchTransport, req: SearchRequest): Promise<StreamResult> {
	let active = true;
	try {
		const pending = Promise.resolve().then(() => {
			if (isAborted(req.signal)) throw abortReason(req.signal?.reason);
			return transport({
				...req,
				onUpdate: req.onUpdate ? (partial) => {
					if (!active || isAborted(req.signal)) return;
					try { req.onUpdate?.(partial); } catch { /* Progress is advisory. */ }
				} : undefined,
			});
		});
		const result = req.signal ? await awaitWithSignal(pending, req.signal) : await pending;
		if (isAborted(req.signal)) throw abortReason(req.signal?.reason);
		return result;
	} finally {
		active = false;
	}
}

function missingCredentials(kind: ProviderKind, message: string): ProviderError {
	return providerError("missing_credentials", `${kind}: ${message}`);
}

function isAborted(signal: AbortSignal | undefined): boolean {
	return signal !== undefined && signal.aborted;
}

function abortReason(reason: unknown): ProviderError {
	// Preserve any ProviderError, including `timeout` from a parent deadline:
	// an operation timeout must never be reported as a user abort.
	if (isProviderError(reason)) {
		return reason;
	}
	return providerError("aborted", "search was aborted.");
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
	if (isAborted(req.signal)) {
		throw abortReason(req.signal?.reason);
	}

	const availability = options.availability ?? providerAvailability();
	const requested =
		options.family === undefined
			? [...DEFAULT_CHAIN.web, ...DEFAULT_CHAIN.code]
			: DEFAULT_CHAIN[options.family];
	const kinds = listRunnableProviders(
		req.settings,
		availability,
		options.family,
	);
	const skipNotes = requested
		.filter((kind) => availability[kind] !== true)
		.map((kind) => `${kind} skipped: not available.`);
	if (kinds.length === 0) {
		throw missingCredentials(req.settings[options.family ?? "web"].provider, describeNoCredentials(options.family));
	}

	const transports = await searchTransports(req, options);

	const warnings: string[] = [...skipNotes];
	const runnable: ProviderKind[] = [];
	for (const kind of kinds) {
		if (!transports[kind]) {
			warnings.push(`No transport is registered for ${kind}.`);
			continue;
		}
		runnable.push(kind);
	}
	if (runnable.length === 0) {
		throw missingCredentials(
			kinds[0],
			`No transport registered for ${kinds.join(", ")}.`,
		);
	}

	const settled = await Promise.allSettled(
		runnable.map(async (kind) => {
			const transport = transports[kind];
			if (!transport) {
				throw missingCredentials(kind, `No transport is registered for ${kind}.`);
			}
			return { kind, result: await runTransport(transport, req) };
		}),
	);

	if (isAborted(req.signal)) {
		throw abortReason(req.signal?.reason);
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
			throw err;
		}
		lastError = err;
		warnings.push(`${kind} failed (${err.code}): ${err.message}`);
	}

	if (successes.length === 0) {
		throw lastError ??
			missingCredentials(runnable[0], "Every parallel provider failed.");
	}

	return mergeStreamResults(successes, warnings);
}

/** Names the credential that would actually unlock the family in question. */
function describeNoCredentials(target: ProviderFamily = "web"): string {
	const hint = target === "code"
		? "Set GITHUB_TOKEN or run gh auth login for GitHub; grep.app and Sourcegraph need no key."
		: "Enable Parallel's native MCP server in Pi (/mcp), or configure Exa.";
	return target === "web"
		? `No web provider is available. ${hint}`
		: `No code provider has credentials. ${hint}`;
}

/**
 * Real transports are loaded lazily so the registry stays usable with injected
 * fakes and never forces the provider modules to load in offline tests. A
 * transport that is missing or throws on import is simply left out of the map,
 * so the chain skips that provider instead of failing the whole search.
 */
async function loadDefaultTransports(): Promise<ProviderTransportMap> {
	const [exa, parallel, grep, sourcegraph, github] = await Promise.all([
		import("./exa.ts").catch(() => undefined),
		import("./parallel.ts").catch(() => undefined),
		import("./grep.ts").catch(() => undefined),
		import("./sourcegraph.ts").catch(() => undefined),
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
	assign("sourcegraph", sourcegraph?.sourcegraphSearch);
	assign("github", github?.githubSearch);
	return map;
}
