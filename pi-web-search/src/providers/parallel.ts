import { createHash } from "node:crypto";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { awaitWithSignal } from "./http.ts";
import type { SearchRequest } from "./index.ts";
import {
	type SearchResultDetail,
	type Source,
	type StreamResult,
	isProviderError,
	providerError,
} from "./types.ts";

export const PARALLEL_MCP_SERVER = "pi_web_search_parallel";
export const PARALLEL_MCP_URL = "https://search.parallel.ai/mcp";
const SEARCH_TOOL = `mcp__${PARALLEL_MCP_SERVER}__web_search`;
const FETCH_TOOL = `mcp__${PARALLEL_MCP_SERVER}__web_fetch`;
const MAX_FETCH_URLS = 20;

/** Pi owns the MCP connection, permissions and lifecycle; this adapter only normalizes evidence. */
export async function parallelSearch(req: SearchRequest): Promise<StreamResult> {
	const runtime = req.runtime;
	if (!runtime || typeof runtime.executeTool !== "function") {
		throw unavailable("No Pi tool context was supplied");
	}
	const metadata = requestMetadata(runtime);
	const searchQueries = [req.query];
	const raw = await callNative(runtime, SEARCH_TOOL, {
		objective: req.query,
		search_queries: searchQueries,
		...metadata,
	}, req.signal);
	const search = readPayload(raw, "web_search");
	const hits = requireResults(search, "web_search").slice(0, req.settings.maxResults);
	const searchResults = hits.map((hit) => toDetail(hit));
	const sources = hits.map(toSource);
	const warnings = normalizeWarnings(search.warnings);

	if (req.urls?.length) {
		try {
			const fetched = readPayload(await callNative(runtime, FETCH_TOOL, {
				urls: req.urls.slice(0, MAX_FETCH_URLS),
				objective: req.query.slice(0, 200),
				search_queries: searchQueries,
				full_content: false,
				...metadata,
			}, req.signal), "web_fetch");
			for (const entry of requireResults(fetched, "web_fetch")) {
				searchResults.push(toDetail(entry, "extract"));
				sources.push(toSource(entry));
			}
			warnings.push(...normalizeWarnings(fetched.warnings), ...normalizeErrorUrls(fetched.errors));
		} catch (error) {
			if (req.signal?.aborted || (isProviderError(error) && error.code === "aborted")) throw error;
			warnings.push(`parallel fetch failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	const usage = normalizeUsage(search.usage);
	return {
		text: "",
		providerKind: "parallel",
		searchResults,
		sources,
		...(typeof search.search_id === "string" && search.search_id ? { requestId: search.search_id } : {}),
		...(usage.length ? { usage } : {}),
		...(warnings.length ? { warnings } : {}),
	};
}

function requestMetadata(runtime: ExtensionToolContext): Record<string, string> {
	const sessionId = runtime.sessionManager?.getSessionId();
	const modelId = runtime.model?.id;
	return {
		...(sessionId ? { session_id: createHash("sha256").update(sessionId).digest("hex") } : {}),
		...(modelId && modelId !== "unknown" && modelId.length <= 100 ? { model_name: modelId } : {}),
	};
}

/** A nested outcome contains a Pi result, whose structuredContent is the MCP CallToolResult. */
async function callNative(
	runtime: ExtensionToolContext,
	name: string,
	args: Record<string, unknown>,
	signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
	if (signal?.aborted) throw abortError(signal);
	const pending = runtime.executeTool(name, args, { signal });
	const outcome = signal ? await awaitWithSignal(pending, signal) : await pending;
	if (signal?.aborted) throw abortError(signal);
	const result = outcome.result;
	const inner = record(result?.structuredContent);
	if (outcome.isError || result?.isError || inner?.isError === true) {
		// Only an MCP CallToolResult that itself declares isError can authorize
		// interpreting its text as a server status. Pi permission hooks and other
		// host failures return arbitrary text without this envelope.
		if (inner?.isError === true && Array.isArray(inner.content)) {
			throw nativeError(name, textBlocks(inner.content) || "no error details");
		}
		const message = (textBlocks(result?.content) || "no error details").slice(0, 500);
		throw providerError("tool_error", `${name} failed in Pi's tool pipeline: ${message}. Check /mcp for ${PARALLEL_MCP_SERVER} and run /reload.`, { retryable: false });
	}
	if (!inner) throw providerError("parse_error", `${name} returned no MCP CallToolResult.`);
	return inner;
}

function abortError(signal: AbortSignal) {
	return isProviderError(signal.reason) ? signal.reason : providerError("aborted", "Parallel search was aborted.");
}

function unavailable(reason: string) {
	return providerError("tool_error", `${reason}. Enable Pi's built-in MCP support, check /mcp for ${PARALLEL_MCP_SERVER} and run /reload.`, { retryable: false });
}

function nativeError(name: string, rawMessage: string) {
	const message = rawMessage.slice(0, 500);
	if (/\b(?:401|403|unauthorized|forbidden|authentication|invalid api key)\b/i.test(message)) {
		return providerError("http_error", `${name}: ${message}`, { status: /\b403\b|forbidden/i.test(message) ? 403 : 401 });
	}
	if (/\b(?:429|rate limit|too many requests)\b/i.test(message)) {
		return providerError("rate_limited", `${name}: ${message}`, { status: 429 });
	}
	const httpStatus = /\bHTTP\s+([45]\d\d)\b/i.exec(message);
	if (httpStatus) return providerError("http_error", `${name}: ${message}`, { status: Number(httpStatus[1]) });
	if (/\b(?:blocked|permission|denied|not approved)\b/i.test(message)) {
		return providerError("tool_error", `${name} was denied: ${message}`, { retryable: false });
	}
	if (/\bnot found\b|\bnot available\b|\bunknown tool\b|\bdisconnected\b|\bfailed to connect\b/i.test(message)) {
		return unavailable(`${name} is not callable (${message})`);
	}
	return providerError("tool_error", `${name} failed: ${message}`, { retryable: true });
}

function readPayload(result: Record<string, unknown>, tool: string): Record<string, unknown> {
	const structured = record(result.structuredContent);
	if (structured && Array.isArray(structured.results)) return structured;
	for (const block of Array.isArray(result.content) ? result.content : []) {
		const text = record(block)?.text;
		if (typeof text !== "string") continue;
		try {
			const parsed = record(JSON.parse(text));
			if (parsed && Array.isArray(parsed.results)) return parsed;
		} catch { /* Prose is not structured source evidence. */ }
	}
	throw providerError("parse_error", `Parallel ${tool} returned no structured results; check /mcp for ${PARALLEL_MCP_SERVER}.`);
}

function requireResults(payload: Record<string, unknown>, tool: string): ParallelResult[] {
	const raw = payload.results as unknown[];
	const valid = normalizeResults(raw);
	if (raw.length > 0 && valid.length === 0) {
		throw providerError("parse_error", `Parallel ${tool} returned no valid result URLs.`);
	}
	return valid;
}

interface ParallelResult {
	url: string;
	title: string | null;
	publish_date: string | null;
	excerpts: string[];
}

function normalizeResults(value: unknown): ParallelResult[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry): ParallelResult[] => {
		const item = record(entry);
		if (!item || typeof item.url !== "string" || !/^https?:\/\//i.test(item.url)) return [];
		return [{
			url: item.url,
			title: typeof item.title === "string" ? item.title : null,
			publish_date: typeof item.publish_date === "string" ? item.publish_date : null,
			excerpts: Array.isArray(item.excerpts) ? item.excerpts.filter((v): v is string => typeof v === "string") : [],
		}];
	});
}

function toDetail(entry: ParallelResult, type?: string): SearchResultDetail {
	return {
		title: entry.title ?? undefined,
		url: entry.url,
		source: "parallel",
		pageAge: entry.publish_date,
		citedText: entry.excerpts.join("\n"),
		...(type ? { type } : {}),
	};
}

function toSource(entry: ParallelResult): Source {
	return { title: entry.title ?? entry.url, url: entry.url };
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function textBlocks(value: unknown): string {
	if (!Array.isArray(value)) return "";
	return value.flatMap((block): string[] => {
		const entry = record(block);
		return entry?.type === "text" && typeof entry.text === "string" ? [entry.text] : [];
	}).join("\n");
}

function normalizeWarnings(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item): string[] => {
		const message = typeof item === "string" ? item : record(item)?.message;
		return typeof message === "string" && message.length ? [message] : [];
	});
}

function normalizeErrorUrls(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item): string[] => {
		const url = record(item)?.url;
		return typeof url === "string" ? [url] : [];
	});
}

function normalizeUsage(value: unknown): { name: string; count: number }[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item): { name: string; count: number }[] => {
		const entry = record(item);
		return typeof entry?.name === "string" && typeof entry.count === "number" && Number.isFinite(entry.count)
			? [{ name: entry.name, count: entry.count }] : [];
	});
}
