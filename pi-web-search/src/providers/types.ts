export type ProviderKind = "exa" | "parallel" | "grep" | "github";

/**
 * Sources answer different questions. Exa/Parallel answer web questions;
 * grep.app/GitHub answer code questions. The fallback chain never crosses a
 * boundary, because falling back from a web source to a code source answers a
 * different question than the caller asked.
 */
export type ProviderFamily = "web" | "code";

export const PROVIDER_FAMILY: Record<ProviderKind, ProviderFamily> = {
	exa: "web",
	parallel: "web",
	grep: "code",
	github: "code",
};

export const PROVIDER_KINDS: readonly ProviderKind[] = [
	"exa",
	"parallel",
	"grep",
	"github",
];

/** Default order tried within a family when config does not override it. */
export const DEFAULT_CHAIN: Record<ProviderFamily, ProviderKind[]> = {
	web: ["exa", "parallel"],
	code: ["grep", "github"],
};

export function providerFamily(kind: ProviderKind): ProviderFamily {
	return PROVIDER_FAMILY[kind];
}


export interface Source {
	title: string;
	url: string;
}

export interface SearchResultDetail {
	title?: string;
	url?: string;
	query?: string;
	source?: string;
	pageAge?: string | null;
	citedText?: string;
	status?: string;
	type?: string;
}

export interface StreamResult {
	/** Markdown summary; "" when the provider only returns documents. */
	text: string;
	sources?: Source[];
	providerKind: ProviderKind;
	/** Every provider that contributed, when more than one ran. */
	providers?: ProviderKind[];
	searchResults?: SearchResultDetail[];
	/** Exa requestId or Parallel search_id. Joined when several ran. */
	requestId?: string;
	usage?: { name: string; count: number }[];
	warnings?: string[];
	scope?: "web" | "code" | "both";
	skipped?: string[];
	jevStatus?: "ran" | "disabled" | "unavailable" | "skipped";
	/** Decision-layer audit trail; absent whenever jev did not run. */
	jev?: {
		sufficient: boolean;
		lowConfidence: boolean;
		/** Count withheld as unsafe. */
		suppressed: number;
		/** URLs withheld, so a suppression is never invisible. */
		suppressedUrls: string[];
	};
}

const CODES = [
	"missing_credentials",
	"invalid_config",
	"invalid_arguments",
	"http_error",
	"rate_limited",
	"network_error",
	"timeout",
	"aborted",
	"parse_error",
	"rpc_error",
	"tool_error",
	"unknown",
] as const;

export type ProviderErrorCode = (typeof CODES)[number];

/** Thrown by transports; `code` is stable and used for fallback + error details. */
export interface ProviderError extends Error {
	code: ProviderErrorCode;
	status?: number;
	/** JSON-RPC error code, kept separate from `status` (which is HTTP). */
	rpcCode?: number;
	retryable?: boolean;
}

export interface ProviderErrorOptions {
	status?: number;
	rpcCode?: number;
	retryable?: boolean;
	cause?: unknown;
}

const RETRYABLE_CODES = new Set<ProviderErrorCode>([
	"http_error",
	"rate_limited",
	"network_error",
	"timeout",
]);

/** 4xx client errors are not worth another provider; 5xx usually is. */
function isRetryable(code: ProviderErrorCode, status?: number): boolean {
	if (code === "http_error") {
		return status === undefined || status >= 500;
	}
	return RETRYABLE_CODES.has(code);
}

export function providerError(
	code: ProviderErrorCode,
	message: string,
	opts: ProviderErrorOptions = {},
): ProviderError {
	const error = new Error(message) as ProviderError;
	error.name = "ProviderError";
	error.code = code;
	if (opts.status !== undefined) {
		error.status = opts.status;
	}
	if (opts.rpcCode !== undefined) {
		error.rpcCode = opts.rpcCode;
	}
	error.retryable = opts.retryable ?? isRetryable(code, opts.status);
	if (opts.cause !== undefined) {
		error.cause = opts.cause;
	}
	return error;
}

export function isProviderError(value: unknown): value is ProviderError {
	if (!(value instanceof Error)) {
		return false;
	}
	const code = (value as { code?: unknown }).code;
	return typeof code === "string" && PROVIDER_ERROR_CODES.has(code);
}

const PROVIDER_ERROR_CODES = new Set<string>(CODES);
