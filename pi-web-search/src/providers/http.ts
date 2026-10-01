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
	/** Present on real `Response` objects; read with a byte cap when available. */
	body?: ReadableStream<Uint8Array> | null;
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
	/** Hard cap on the decoded response body; oversized bodies fail as parse_error. */
	maxResponseBytes?: number;
	/** Selects which SSE JSON-RPC message to resolve with (correlates by id). */
	selectMessage?: (message: unknown) => boolean;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 20000;

/** Bounds the network/memory cost of one response before it is decoded. */
export const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/** POST JSON, parse a JSON body, throw `ProviderError` on any failure. */
export async function postJson<T>(
	url: string,
	options: JsonRequestOptions,
): Promise<T> {
	return send(url, options, (bodyText) => parseJsonBody<T>(url, bodyText));
}

/** GET JSON with the same bounds, cancellation and error handling as POST. */
export async function getJson<T>(
	url: string,
	options: Omit<JsonRequestOptions, "body">,
): Promise<T> {
	return send(url, { ...options, body: undefined }, (text) => parseJsonBody<T>(url, text), "GET");
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
		parseEnvelope<T>(
			url,
			bodyText,
			options.allowEmptyBody === true,
			options.selectMessage,
		),
	);
}

/**
 * Returns the concatenated payloads of an SSE stream, in order.
 *
 * `data:` is the normal framing, but GitHub's MCP server is inconsistent within
 * a single session: `initialize` and `tools/call` use `data:`, while
 * `tools/list` sends a bare JSON line after `event: message`. Ignoring bare
 * lines is fine until it silently is not, so a bare `{`/`[` line is treated as
 * payload too.
 */
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
			continue;
		}
		if (line.startsWith("event:") || line.startsWith("id:") || line.startsWith("retry:")) {
			continue;
		}
		if (line.startsWith("{") || line.startsWith("[")) {
			current.push(line);
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
			abort(reasonFrom(signal));
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
		abort(reasonFrom(signal));
	}
}

/**
 * A caller's abort reason may itself be a `ProviderError` — e.g. a parent
 * operation deadline composed with `withTimeout` aborts with `code: "timeout"`.
 * Preserve that code so an operation timeout is never reported as a user abort.
 */
function reasonFrom(signal: AbortSignal | undefined): ProviderError {
	const reason = signal?.reason;
	return asProviderError(reason) ?? abortedError();
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
	method: "POST" | "GET" = "POST",
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
		if (composed.signal.aborted) throw reasonFrom(composed.signal);
		const response = await awaitWithSignal(doFetch(url, {
			method,
			headers: {
				...(method === "POST" ? { "Content-Type": "application/json" } : {}),
				Accept: "application/json, text/event-stream",
				...options.headers,
			},
			...(method === "POST" ? { body: JSON.stringify(options.body) } : {}),
			signal: composed.signal,
		}), composed.signal);
		options.onResponse?.(response);

		let bodyText: string;
		try {
			bodyText = await awaitWithSignal(readBody(
				response,
				options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
				url,
				composed.signal,
			), composed.signal);
		} catch (error) {
			if (error instanceof Error && isProviderErrorLike(error)) {
				throw error;
			}
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

		if (composed.signal.aborted) throw reasonFrom(composed.signal);
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
	const reason = signal.reason;
	if (asProviderError(reason)) {
		return reason as ProviderError;
	}
	return isProviderErrorWithCode(reason, "timeout")
		? timeoutError(timeoutMs)
		: abortedError();
}

/**
 * Reads the response body, capping decoded bytes so a hostile or oversized
 * upstream response cannot buffer without bound before JSON.parse. The
 * composed request signal stays live here, so the body is also deadline-bound.
 */
async function readBody(
	response: ResponseLike,
	maxBytes: number,
	url: string,
	signal: AbortSignal,
): Promise<string> {
	const stream = response.body;
	if (!stream) {
		const text = await response.text();
		assertBodySize(Buffer.byteLength(text, "utf8"), maxBytes, url);
		return text;
	}

	const reader = stream.getReader();
	const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
	signal.addEventListener("abort", cancel, { once: true });
	if (signal.aborted) cancel();
	const decoder = new TextDecoder();
	let total = 0;
	let text = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			if (value) {
				total += value.byteLength;
				assertBodySize(total, maxBytes, url);
				text += decoder.decode(value, { stream: true });
			}
		}
		text += decoder.decode();
		return text;
	} catch (error) {
		void reader.cancel().catch(() => {});
		throw error;
	} finally {
		signal.removeEventListener("abort", cancel);
		reader.releaseLock();
	}
}

/** Also bound injected transports/body readers that do not honor fetch's signal. */
export function awaitWithSignal<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		void pending.catch(() => {});
		return Promise.reject(reasonFrom(signal));
	}
	return new Promise<T>((resolve, reject) => {
		const abort = () => { signal.removeEventListener("abort", abort); reject(reasonFrom(signal)); };
		signal.addEventListener("abort", abort, { once: true });
		pending.then(
			(value) => { signal.removeEventListener("abort", abort); resolve(value); },
			(error) => { signal.removeEventListener("abort", abort); reject(error); },
		);
	});
}

function assertBodySize(size: number, maxBytes: number, url: string): void {
	if (Number.isFinite(maxBytes) && maxBytes > 0 && size > maxBytes) {
		throw providerError(
			"parse_error",
			`Response from ${url} exceeded the ${maxBytes}-byte response cap.`,
		);
	}
}

function parseEnvelope<T>(
	url: string,
	bodyText: string,
	allowEmptyBody: boolean,
	selectMessage?: (message: unknown) => boolean,
): T {
	if (bodyText.trim().length === 0) {
		if (allowEmptyBody) {
			return undefined as T;
		}
		throw providerError("parse_error", `Empty response body from ${url}.`);
	}
	const trimmed = bodyText.trimStart();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		const message = parseJsonBody<T>(url, bodyText);
		if (selectMessage && !selectMessage(message)) {
			throw providerError("parse_error", `No JSON-RPC response matching the request id in the response from ${url}.`);
		}
		return message;
	}
	const frames = extractSseData(bodyText);
	if (frames.length === 0) {
		throw providerError(
			"parse_error",
			`No SSE data frames in the response from ${url}.`,
		);
	}
	if (!selectMessage) {
		return parseJsonBody<T>(url, frames[frames.length - 1]);
	}
	// JSON-RPC: pick the message whose id matches the outstanding request and
	// tolerate unrelated notifications (progress/log events carry no id).
	for (const frame of frames) {
		let message: unknown;
		try {
			message = JSON.parse(frame);
		} catch {
			continue;
		}
		if (selectMessage(message)) {
			return message as T;
		}
	}
	throw providerError(
		"parse_error",
		`No JSON-RPC response matching the request id in the response from ${url}.`,
	);
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

/** Narrows any value to a `ProviderError` when it carries a stable code. */
function asProviderError(value: unknown): ProviderError | undefined {
	if (
		value instanceof Error &&
		typeof (value as { code?: unknown }).code === "string"
	) {
		return value as ProviderError;
	}
	return undefined;
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
