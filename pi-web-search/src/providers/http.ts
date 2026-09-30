import { type ProviderError, providerError } from "./types.ts";

export type FetchLike = (
	input: string,
	init: RequestInitLike,
) => Promise<ResponseLike>;

export interface ResponseLike {
	ok: boolean;
	status: number;
	headers: { get(name: string): string | null };
	text(): Promise<string>;
}

export interface RequestInitLike {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	signal?: AbortSignal;
}

export interface JsonRequestOptions {
	headers?: Record<string, string>;
	body: unknown;
	signal?: AbortSignal;
	timeoutMs?: number;
	fetchImpl?: FetchLike;
	/** Receives the raw response before the body is read (captures the MCP session id). */
	onResponse?: (response: ResponseLike) => void;
	/** Resolve with `undefined` instead of throwing when the body is empty. */
	allowEmptyBody?: boolean;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 20000;

/** POST JSON, parse a JSON body, throw `ProviderError` on any failure. */
export async function postJson<T>(
	url: string,
	options: JsonRequestOptions,
): Promise<T> {
	return send(url, options, (bodyText) => parseJsonBody<T>(url, bodyText));
}

/**
 * POST JSON to an endpoint answering with the MCP streamable-HTTP envelope
 * (`text/event-stream` framed as `event: message` / `data: {...}`) or with a
 * plain JSON body. Returns the decoded JSON-RPC message.
 */
export async function postSseJson<T>(
	url: string,
	options: JsonRequestOptions,
): Promise<T> {
	return send(url, options, (bodyText) =>
		parseEnvelope<T>(url, bodyText, options.allowEmptyBody === true),
	);
}

/** Returns the concatenated `data:` payloads of an SSE stream, in order. */
export function extractSseData(bodyText: string): string[] {
	const payloads: string[] = [];
	let current: string[] = [];

	const flush = () => {
		if (current.length > 0) {
			payloads.push(current.join("\n"));
		}
		current = [];
	};

	for (const rawLine of bodyText.split("\n")) {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (line.length === 0) {
			flush();
			continue;
		}
		if (line.startsWith(":")) {
			continue;
		}
		if (line.startsWith("data:")) {
			current.push(line.slice("data:".length).trimStart());
		}
	}
	flush();
	return payloads;
}

export function normalizeHttpError(
	response: ResponseLike,
	bodyText: string,
): ProviderError {
	const status = response.status;
	const detail = summarizeBody(bodyText);
	const suffix = detail ? `: ${detail}` : "";
	if (status === 429) {
		return providerError("rate_limited", `HTTP 429 too many requests${suffix}`, {
			status,
			retryable: true,
		});
	}
	return providerError("http_error", `HTTP ${status}${suffix}`, { status });
}

export interface ComposedSignal {
	signal: AbortSignal;
	/** Clears the timer and detaches the caller's abort listener. */
	dispose(): void;
}

/**
 * Composes the caller's signal with a timeout timer so the timer is always
 * cleared and no listener is left behind.
 */
export function withTimeout(
	signal: AbortSignal | undefined,
	timeoutMs: number,
): ComposedSignal {
	const controller = new AbortController();
	const abort = (reason: ProviderError) => {
		if (!controller.signal.aborted) {
			controller.abort(reason);
		}
	};

	if (signal) {
		if (signal.aborted) {
			abort(abortedError());
		} else {
			signal.addEventListener("abort", onCallerAbort, { once: true });
		}
	}

	const timer =
		Number.isFinite(timeoutMs) && timeoutMs > 0
			? setTimeout(() => {
					abort(timeoutError(timeoutMs));
				}, timeoutMs)
			: undefined;
	timer?.unref?.();

	return {
		signal: controller.signal,
		dispose() {
			if (timer !== undefined) {
				clearTimeout(timer);
			}
			signal?.removeEventListener("abort", onCallerAbort);
		},
	};

	function onCallerAbort() {
		abort(abortedError());
	}
}

export function timeoutError(timeoutMs: number): ProviderError {
	return providerError("timeout", `Request timed out after ${timeoutMs}ms.`, {
		retryable: true,
	});
}

export function abortedError(): ProviderError {
	return providerError("aborted", "Request aborted.", { retryable: false });
}

async function send<T>(
	url: string,
	options: JsonRequestOptions,
	decode: (bodyText: string) => T,
): Promise<T> {
	const doFetch = options.fetchImpl ??
		(globalThis.fetch as FetchLike | undefined);
	if (!doFetch) {
		throw providerError(
			"network_error",
			"No fetch implementation is available; pass options.fetchImpl.",
			{ retryable: true },
		);
	}

	const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	const composed = withTimeout(options.signal, timeoutMs);

	try {
		const response = await doFetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				...options.headers,
			},
			body: JSON.stringify(options.body),
			signal: composed.signal,
		});
		options.onResponse?.(response);

		let bodyText: string;
		try {
			bodyText = await response.text();
		} catch (error) {
			throw composed.signal.aborted
				? abortReason(composed.signal, timeoutMs)
				: providerError(
						"network_error",
						`Failed to read response body from ${url}: ${
							error instanceof Error ? error.message : String(error)
						}`,
						{ retryable: true, cause: error },
					);
		}

		if (!response.ok) {
			throw normalizeHttpError(response, bodyText);
		}
		return decode(bodyText);
	} catch (error) {
		throw toProviderError(error, composed.signal, timeoutMs);
	} finally {
		composed.dispose();
	}
}

function toProviderError(
	error: unknown,
	signal: AbortSignal,
	timeoutMs: number,
): ProviderError {
	if (error instanceof Error && isProviderErrorLike(error)) {
		return error;
	}
	if (signal.aborted) {
		return abortReason(signal, timeoutMs);
	}
	if (isAbortLikeError(error)) {
		return abortedError();
	}
	const message = error instanceof Error ? error.message : String(error);
	return providerError("network_error", `Request failed: ${message}`, {
		retryable: true,
		cause: error,
	});
}

function abortReason(signal: AbortSignal, timeoutMs: number): ProviderError {
	return isProviderErrorWithCode(signal.reason, "timeout")
		? timeoutError(timeoutMs)
		: abortedError();
}

function parseEnvelope<T>(
	url: string,
	bodyText: string,
	allowEmptyBody: boolean,
): T {
	if (bodyText.trim().length === 0) {
		if (allowEmptyBody) {
			return undefined as T;
		}
		throw providerError("parse_error", `Empty response body from ${url}.`);
	}
	const trimmed = bodyText.trimStart();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		return parseJsonBody<T>(url, bodyText);
	}
	const frames = extractSseData(bodyText);
	if (frames.length === 0) {
		throw providerError(
			"parse_error",
			`No SSE data frames in the response from ${url}.`,
		);
	}
	return parseJsonBody<T>(url, frames[frames.length - 1]);
}

function parseJsonBody<T>(url: string, bodyText: string): T {
	try {
		return JSON.parse(bodyText) as T;
	} catch (error) {
		throw providerError(
			"parse_error",
			`Response from ${url} was not valid JSON: ${
				error instanceof Error ? error.message : String(error)
			}`,
			{ cause: error },
		);
	}
}

function isProviderErrorLike(error: Error): error is ProviderError {
	return typeof (error as { code?: unknown }).code === "string";
}

function isProviderErrorWithCode(value: unknown, code: string): boolean {
	return (
		!!value &&
		typeof value === "object" &&
		"code" in value &&
		(value as { code?: unknown }).code === code
	);
}

function isAbortLikeError(error: unknown): boolean {
	return (
		!!error &&
		typeof error === "object" &&
		"name" in error &&
		(error as { name?: unknown }).name === "AbortError"
	);
}

function summarizeBody(bodyText: string): string {
	const collapsed = bodyText.replace(/\s+/g, " ").trim();
	if (collapsed.length === 0) {
		return "";
	}
	return collapsed.length > 300
		? `${collapsed.slice(0, 300)}…`
		: collapsed;
}
