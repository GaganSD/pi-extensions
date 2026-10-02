import { parseCodeQuery } from "./grep.ts";
import { type FetchLike, getText } from "./http.ts";
import type { SearchRequest } from "./index.ts";
import { sourcesFromResults } from "./results.ts";
import { type SearchResultDetail, providerError, type StreamResult } from "./types.ts";

export const SOURCEGRAPH_STREAM_URL = "https://sourcegraph.com/.api/search/stream";

export interface SourcegraphSearchOptions {
	fetchImpl?: FetchLike;
}

export async function sourcegraphSearch(
	req: SearchRequest,
	options: SourcegraphSearchOptions = {},
): Promise<StreamResult> {
	const url = new URL(SOURCEGRAPH_STREAM_URL);
	url.searchParams.set("q", buildSourcegraphQuery(req.query, req.settings.maxResults));
	url.searchParams.set("v", "V3");
	const body = await getText(url.href, {
		headers: {
			Accept: "text/event-stream",
			"User-Agent": "pi-web-search",
		},
		signal: req.signal,
		timeoutMs: req.settings.timeoutMs,
		fetchImpl: options.fetchImpl,
	});
	const { results, warnings, fatal } = parseSourcegraphStream(body, req.settings.maxResults);
	if (fatal !== undefined && results.length === 0) {
		throw providerError("tool_error", fatal, { retryable: true });
	}
	return {
		text: "",
		providerKind: "sourcegraph",
		sources: sourcesFromResults(results),
		searchResults: results,
		requestId: "sourcegraph",
		...(warnings.length > 0 ? { warnings } : {}),
	};
}

export function buildSourcegraphQuery(raw: string, maxResults: number): string {
	const parsed = parseCodeQuery(raw);
	const parts = [parsed.literal];
	if (parsed.repo !== undefined) {
		parts.push(`repo:${toSourcegraphRepo(parsed.repo)}`);
	}
	for (const language of parsed.languages) {
		parts.push(`lang:${language}`);
	}
	parts.push(`count:${maxResults}`);
	return parts.filter((part) => part.length > 0).join(" ");
}

export function toSourcegraphRepo(repo: string): string {
	const trimmed = repo.replace(/^\/+/, "");
	if (/^(github\.com|gitlab\.com|bitbucket\.org)\//.test(trimmed)) {
		return trimmed;
	}
	return /^[^/]+\/[^/]+$/.test(trimmed) ? `github.com/${trimmed}` : trimmed;
}

export function parseSourcegraphStream(
	text: string,
	maxResults: number,
): { results: SearchResultDetail[]; warnings: string[]; fatal?: string } {
	const results: SearchResultDetail[] = [];
	const warnings: string[] = [];
	let fatal: string | undefined;
	let event = "message";
	let data: string[] = [];

	const flush = () => {
		const payload = data.join("\n").trim();
		data = [];
		if (payload.length === 0) {
			event = "message";
			return;
		}
		if (event === "matches") {
			const parsed = parseJson(payload);
			if (Array.isArray(parsed)) {
				for (const item of parsed) {
					const hit = parseMatch(item);
					if (hit) {
						results.push(hit);
						if (results.length >= maxResults) {
							break;
						}
					}
				}
			}
		} else if (event === "alert") {
			const parsed = parseJson(payload);
			if (isRecord(parsed)) {
				const title = readString(parsed, "title");
				const description = readString(parsed, "description");
				const message = [title, description].filter(Boolean).join(": ");
				if (message) {
					warnings.push(message);
				}
			}
		} else if (event === "error") {
			const parsed = parseJson(payload);
			fatal = isRecord(parsed)
				? readString(parsed, "message") ?? "Sourcegraph search failed."
				: "Sourcegraph search failed.";
		}
		event = "message";
	};

	for (const raw of text.split("\n")) {
		const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		if (line.length === 0) {
			flush();
			continue;
		}
		if (line.startsWith("event:")) {
			event = line.slice("event:".length).trim() || "message";
			continue;
		}
		if (line.startsWith("data:")) {
			data.push(line.slice("data:".length).trimStart());
		}
	}
	flush();
	return { results: results.slice(0, maxResults), warnings, fatal };
}

function parseMatch(value: unknown): SearchResultDetail | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const repo = readString(value, "repository");
	const path = readString(value, "path");
	if (!repo || !path) {
		return undefined;
	}
	const commit = readString(value, "commit");
	const lines = Array.isArray(value.lineMatches)
		? value.lineMatches.flatMap((match) =>
			isRecord(match) && typeof match.line === "string" ? [match.line] : [])
		: [];
	return {
		title: `${stripGithubPrefix(repo)}/${path}`,
		url: resultUrl(repo, path, commit),
		source: "sourcegraph",
		type: "content",
		...(lines.length > 0 ? { citedText: lines.join("\n") } : {}),
	};
}

function resultUrl(repo: string, path: string, commit?: string): string {
	if (repo.startsWith("github.com/")) {
		const ref = commit && commit.length > 0 ? commit : "HEAD";
		return `https://github.com/${repo.slice("github.com/".length)}/blob/${encodePath(ref)}/${encodePath(path)}`;
	}
	const ref = commit && commit.length > 0 ? `@${commit}` : "";
	return `https://sourcegraph.com/${repo}${ref}/-/blob/${encodePath(path)}`;
}

function stripGithubPrefix(repo: string): string {
	return repo.startsWith("github.com/") ? repo.slice("github.com/".length) : repo;
}

function encodePath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

function parseJson(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
