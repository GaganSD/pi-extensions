export type ProviderKind = "exa" | "parallel";

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
	searchQueries?: string[];
	searchResults?: SearchResultDetail[];
	/** Exa requestId or Parallel search_id. */
	requestId?: string;
	/** Parallel only. */
	usage?: { name: string; count: number }[];
	/** Parallel only. */
	warnings?: string[];
}

export type ProviderErrorCode =
	| "missing_credentials"
	| "invalid_config"
	| "http_error"
	| "rate_limited"
	| "network_error"
	| "timeout"
	| "aborted"
	| "parse_error"
	| "unknown";

/** Thrown by transports; `code` is stable and used for fallback + error details. */
export interface ProviderError extends Error {
	code: ProviderErrorCode;
	status?: number;
	retryable?: boolean;
}

export interface ProviderErrorOptions {
	status?: number;
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

const PROVIDER_ERROR_CODES = new Set<string>([
	"missing_credentials",
	"invalid_config",
	"http_error",
	"rate_limited",
	"network_error",
	"timeout",
	"aborted",
	"parse_error",
	"unknown",
]);

/** True only for a retryable provider error; aborts are never retryable. */
export function isRetryableProviderError(value: unknown): boolean {
	return isProviderError(value) && value.retryable === true;
}
