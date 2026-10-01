import type { FetchLike } from "./http.ts";
import type { SearchRequest } from "./index.ts";
import { withMcpSession } from "./mcp.ts";
import { sourcesFromResults } from "./results.ts";
import type { SearchResultDetail, StreamResult } from "./types.ts";

export const GREP_MCP_URL = "https://mcp.grep.app";

const PROVIDER_NAME = "grep";
const SEARCH_TOOL = "searchGitHub";
const SNIPPET_MARKER = "--- Snippet";

export interface GrepSearchOptions {
	fetchImpl?: FetchLike;
}

export async function grepSearch(
	req: SearchRequest,
	options: GrepSearchOptions = {},
): Promise<StreamResult> {
	const warnings = languageFilterWarning(req.query);

	// grep.app's `language` filter is nondeterministically broken (verified
	// 2026-09-30: identical queries returned 504, empty, then 504). Passing it
	// silently turns a flaky upstream into a confidently wrong "no such code
	// exists" answer, so only an explicit `language:` qualifier in the query
	// triggers it, and that path always warns.
	const args: Record<string, unknown> = {
		query: req.query,
	};
	const repo = extractQualifier(req.query, "repo");
	if (repo !== undefined) {
		args.repo = repo;
	}
	const language = extractQualifier(req.query, "language");
	if (language !== undefined) {
		args.language = [language];
	}

	const text = await withMcpSession(
		{
			url: GREP_MCP_URL,
			fetchImpl: options.fetchImpl,
			timeoutMs: req.settings.timeoutMs,
			signal: req.signal,
		},
		(client) => client.callTool(SEARCH_TOOL, args),
	);

	const results = parseGrepSearchText(text, req.settings.maxResults);
	const usable = results.length > 0
		? results
		: [{ source: PROVIDER_NAME, citedText: text, type: "content" }];

	const allWarnings = [
		...warnings,
		...(usable.length === 1 && usable[0].citedText === text
			? ["grep.app returned no usable matches for this query."]
			: []),
	];

	return {
		text: "",
		providerKind: "grep",
		sources: sourcesFromResults(usable),
		searchResults: usable,
		requestId: "mcp",
		...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
	};
}

interface GrepHit {
	repo?: string;
	path?: string;
	url?: string;
	license?: string;
	snippets: string[];
}

/**
 * Grep returns plain text: `Repository:`/`Path:`/`URL:`/`License:` groups, each
 * followed by `--- Snippet N (Line X) ---` bodies.
 *
 * Snippet boundaries are the `--- Snippet` markers and the next `Repository:`,
 * never a blank line. Code routinely contains blank lines, and treating one as
 * a boundary truncated real snippets mid-function. Inside a snippet block every
 * line is content — including blank lines and lines that happen to start with
 * `Path:` or `Repository:` — which is what keeps a config literal or a
 * `Repository:` string inside source code from fabricating a new hit.
 */
export function parseGrepSearchText(text: string, maxResults: number): SearchResultDetail[] {
	const hits: GrepHit[] = [];
	let current: GrepHit | undefined;
	let snippetLines: string[] | undefined;

	const flushSnippet = () => {
		const body = snippetLines?.join("\n").replace(/\s+$/, "");
		if (current && body) {
			current.snippets.push(body);
		}
		snippetLines = undefined;
	};

	const flushHit = () => {
		flushSnippet();
		if (current && (current.repo || current.path || current.url)) {
			hits.push(current);
		}
		current = undefined;
	};

	for (const raw of text.split("\n")) {
		const line = raw.trimEnd();

		if (line.trimStart().startsWith(SNIPPET_MARKER)) {
			snippetLines = snippetLines ?? [];
			continue;
		}
		if (snippetLines !== undefined) {
			// Inside a snippet: a Repository: line ends the hit, everything else
			// is content.
			if (raw.trimStart().startsWith("Repository:") && !/^\s/.test(raw)) {
				flushHit();
				current = { repo: readValue(raw), snippets: [] };
				continue;
			}
			snippetLines.push(raw);
			continue;
		}
		if (line.trimStart().startsWith("Snippets:")) {
			continue;
		}
		const trimmed = line.trimStart();
		if (trimmed.startsWith("Repository:")) {
			flushHit();
			current = { repo: readValue(trimmed), snippets: [] };
			continue;
		}
		if (!current) {
			continue;
		}
		if (trimmed.startsWith("Path:")) {
			current.path = readValue(trimmed);
		} else if (trimmed.startsWith("URL:")) {
			current.url = readValue(trimmed);
		} else if (trimmed.startsWith("License:")) {
			current.license = readValue(trimmed);
		}
	}
	flushHit();

	return hits
		.slice(0, maxResults)
		.map((hit) => ({
			title: hit.repo && hit.path ? `${hit.repo}/${hit.path}` : (hit.repo ?? hit.path),
			url: hit.url,
			source: PROVIDER_NAME,
			type: "content",
			...(hit.license ? { query: hit.license } : {}),
			...(hit.snippets.length > 0 ? { citedText: hit.snippets.join("\n\n") } : {}),
		}));
}

function readValue(line: string): string {
	const index = line.indexOf(":");
	return index === -1 ? "" : line.slice(index + 1).trim();
}

/** Pulls a `key:value` qualifier out of a query, code-side and deterministic. */
function extractQualifier(query: string, key: string): string | undefined {
	const match = new RegExp(`(?:^|\\s)${key}:(\\S+)`, "i").exec(query);
	return match?.[1];
}

function languageFilterWarning(query: string): string[] {
	if (extractQualifier(query, "language") === undefined) {
		return [];
	}
	return [
		"grep.app's language filter is unreliable and may have returned no matches; treat zero results with a language filter as inconclusive.",
	];
}
