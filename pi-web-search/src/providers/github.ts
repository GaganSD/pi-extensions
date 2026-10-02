import { githubToken } from "../env.ts";
import { type FetchLike, getJson } from "./http.ts";
import type { SearchRequest } from "./index.ts";
import { sourcesFromResults } from "./results.ts";
import { type SearchResultDetail, providerError, type StreamResult } from "./types.ts";

export const GITHUB_SEARCH_URL = "https://api.github.com/search/code";

export interface GithubSearchOptions {
	fetchImpl?: FetchLike;
}

export interface GithubCodeParse {
	results: SearchResultDetail[];
	/** Non-public or unverifiable hits withheld without revealing their content. */
	withheldPrivate: number;
}

/**
 * REST retains repository visibility and the upstream browsable URL. GitHub's
 * minimal MCP response omits both, so it cannot enforce this public-only tool's
 * privacy boundary. One REST request also avoids an MCP handshake/teardown.
 */
export async function githubSearch(
	req: SearchRequest,
	options: GithubSearchOptions = {},
): Promise<StreamResult> {
	const token = githubToken();
	if (token === undefined) {
		throw providerError("missing_credentials", "github: set GH_TOKEN, GITHUB_TOKEN, or run gh auth login.");
	}
	const url = new URL(GITHUB_SEARCH_URL);
	url.searchParams.set("q", req.query);
	url.searchParams.set("per_page", String(req.settings.maxResults));
	let requestId: string | undefined;
	const raw = await getJson<unknown>(url.href, {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github.text-match+json",
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": "pi-web-search",
		},
		signal: req.signal,
		timeoutMs: req.settings.timeoutMs,
		fetchImpl: options.fetchImpl,
		onResponse: (response) => {
			requestId = response.headers.get("x-github-request-id") ?? undefined;
		},
	});
	if (!isRecord(raw) || !Array.isArray(raw.items)) {
		throw providerError("parse_error", "GitHub code search response had no items array.");
	}
	const { results, withheldPrivate } = parseGithubResults(raw, req.settings.maxResults);
	const warnings: string[] = [];
	if (withheldPrivate > 0) {
		warnings.push(`GitHub code search withheld ${withheldPrivate} non-public or unverifiable result(s); this tool only returns public code.`);
	}
	if (raw.incomplete_results === true) {
		warnings.push("GitHub code search returned incomplete results; missing matches are inconclusive.");
	}
	return {
		text: "",
		providerKind: "github",
		sources: sourcesFromResults(results),
		searchResults: results,
		requestId,
		...(warnings.length > 0 ? { warnings } : {}),
	};
}

/** Normalize GitHub's REST code-search items; never echo an unfiltered payload. */
export function parseGithubResults(parsed: unknown, maxResults: number): GithubCodeParse {
	if (!isRecord(parsed) || !Array.isArray(parsed.items)) {
		return { results: [], withheldPrivate: 0 };
	}
	const results: SearchResultDetail[] = [];
	let withheldPrivate = 0;
	for (const item of parsed.items) {
		if (!isRecord(item)) continue;
		const repo = item.repository;
		// Unknown visibility is not public. In particular, the minimal MCP's
		// bare repository string must never let private snippets through.
		if (!isRecord(repo) || repo.private === true ||
			(repo.visibility !== undefined && repo.visibility !== "public") ||
			(repo.private !== false && repo.visibility !== "public")) {
			withheldPrivate++;
			continue;
		}
		const fullName = readString(repo, "full_name");
		const path = readString(item, "path");
		if (!fullName || !/^[\w.-]+\/[\w.-]+$/.test(fullName) || !path) continue;
		const htmlUrl = readString(item, "html_url");
		const ref = readString(repo, "default_branch") ?? "HEAD";
		const url = isGithubBlobUrl(htmlUrl, fullName)
			? htmlUrl!
			: `https://github.com/${fullName}/blob/${encodePath(ref)}/${encodePath(path)}`;
		const fragments = Array.isArray(item.text_matches)
			? item.text_matches.flatMap((match) =>
				isRecord(match) && typeof match.fragment === "string" ? [match.fragment] : [])
			: [];
		results.push({
			title: `${fullName}/${path}`,
			url,
			source: "github",
			type: "content",
			...(fragments.length > 0 ? { citedText: fragments.join("\n\n") } : {}),
		});
		if (results.length >= maxResults) break;
	}
	return { results, withheldPrivate };
}

function isGithubBlobUrl(value: string | undefined, fullName: string): boolean {
	if (!value) return false;
	try {
		const url = new URL(value);
		return url.protocol === "https:" && url.hostname === "github.com" &&
			url.pathname.startsWith(`/${fullName}/blob/`) && !url.username && !url.password;
	} catch {
		return false;
	}
}

function encodePath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
