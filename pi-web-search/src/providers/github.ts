import { githubToken } from "../env.ts";
import type { FetchLike } from "./http.ts";
import type { SearchRequest } from "./index.ts";
import { withMcpSession } from "./mcp.ts";
import { sourcesFromResults } from "./results.ts";
import { type SearchResultDetail, providerError, type StreamResult } from "./types.ts";

export const GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/";

const PROVIDER_NAME = "github";
const SEARCH_TOOL = "search_code";
const MAX_PER_PAGE = 20;

/**
 * Only these fields. Omitting `repository`/`text_matches` is what makes these
 * responses enormous, and `sha` is required to build a citable blob URL —
 * without a URL, `grounded` is false and the result is far less useful.
 */
const CODE_SEARCH_FIELDS = ["path", "sha", "repository", "text_matches"];

export interface GithubSearchOptions {
	fetchImpl?: FetchLike;
}

export async function githubSearch(
	req: SearchRequest,
	options: GithubSearchOptions = {},
): Promise<StreamResult> {
	const token = githubToken();
	if (token === undefined) {
		throw providerError(
			"missing_credentials",
			"github: set GITHUB_TOKEN or GH_TOKEN to enable GitHub code search.",
		);
	}
	const raw = await withMcpSession(
		{
			url: GITHUB_MCP_URL,
			fetchImpl: options.fetchImpl,
			timeoutMs: req.settings.timeoutMs,
			signal: req.signal,
			headers: { Authorization: `Bearer ${token}` },
		},
		(client) =>
			client.callTool(SEARCH_TOOL, {
				query: req.query,
				perPage: Math.min(req.settings.maxResults, MAX_PER_PAGE),
				fields: CODE_SEARCH_FIELDS,
			}),
	);

	const results = parseSearchCodeText(raw, req.settings.maxResults);
	const usable = results.length > 0
		? results
		: [{ source: PROVIDER_NAME, citedText: raw, type: "content" }];

	return {
		text: "",
		providerKind: "github",
		sources: sourcesFromResults(usable),
		searchResults: usable,
		requestId: "mcp",
		...(usable.length === 1 && usable[0].citedText === raw
			? { warnings: ["GitHub code search returned no matches for this query."] }
			: {}),
	};
}

/**
 * `search_code` returns JSON wrapped inside a text content block. Items carry
 * `repository`, `path`, `sha` and `text_matches`; the browsable URL is derived,
 * since the API returns only an api.github.com `object_url`.
 */
export function parseSearchCodeText(
	raw: string,
	maxResults: number,
): SearchResultDetail[] {
	const trimmed = raw.trim();
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		// A non-JSON body is the server's own prose (errors, notices); keep it.
		return [];
	}
	if (!isPlainObject(parsed) || !Array.isArray(parsed.items)) {
		return [];
	}

	const results: SearchResultDetail[] = [];
	for (const item of parsed.items) {
		if (!isPlainObject(item)) {
			continue;
		}
		const repository = readString(item, "repository");
		const path = readString(item, "path");
		const sha = readString(item, "sha");
		const url = blobUrl(repository, path, sha);
		const fragments = readFragments(item);
		results.push({
			title: repository && path ? `${repository}/${path}` : (repository ?? path),
			url,
			source: PROVIDER_NAME,
			type: "content",
			...(fragments.length > 0 ? { citedText: fragments.join("\n\n") } : {}),
		});
		if (results.length >= maxResults) {
			break;
		}
	}
	return results;
}

function blobUrl(repository?: string, path?: string, sha?: string): string | undefined {
	if (!repository || !path) {
		return undefined;
	}
	// Without a sha we still cite the default branch, which is stable enough
	// to be worth showing rather than dropping the result entirely.
	const ref = sha && sha.length > 0 ? sha : "HEAD";
	return `https://github.com/${repository}/blob/${ref}/${path}`;
}

function readFragments(item: Record<string, unknown>): string[] {
	const matches = item.text_matches;
	if (!Array.isArray(matches)) {
		return [];
	}
	const fragments: string[] = [];
	for (const match of matches) {
		if (isPlainObject(match) && typeof match.fragment === "string") {
			fragments.push(match.fragment);
		}
	}
	return fragments;
}

function readString(item: Record<string, unknown>, key: string): string | undefined {
	const value = item[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
