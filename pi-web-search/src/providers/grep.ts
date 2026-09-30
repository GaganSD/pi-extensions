import type { SearchRequest } from "./index.ts";
import { createMcpClient, type McpClient } from "./mcp.ts";
import type { SearchResultDetail, StreamResult } from "./types.ts";

export const GREP_MCP_URL = "https://mcp.grep.app";

/** MCP `searchGitHub` caps results well below this; page size stays modest. */
const MAX_RESULTS_CAP = 20;

const PROVIDER_NAME = "grep";
const SEARCH_TOOL = "searchGitHub";

export interface GrepSearchOptions {
	fetchImpl?: FetchLike;
}

type FetchLike = typeof globalThis.fetch;

export async function grepSearch(
	req: SearchRequest,
	options: GrepSearchOptions = {},
): Promise<StreamResult> {
	const warnings = new LanguageFilterWarning(req.query);

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

	const text = await withMcpSession(req, options, (client) =>
		client.callTool(SEARCH_TOOL, args));

	const results = parseGrepSearchText(text, req.settings.maxResults);
	const usable = results.length > 0
		? results
		: [{ source: PROVIDER_NAME, citedText: text, type: "content" }];

	const allWarnings = [
		...warnings.messages(),
		...(usable.length === 1 && usable[0].citedText === text
			? ["grep.app returned no usable matches for this query."]
			: []),
	];

	return {
		text: "",
		providerKind: "grep",
		sources: usable
			.map((result) => ({ title: result.title ?? "", url: result.url ?? "" }))
			.filter((source) => source.url.length > 0),
		searchResults: usable,
		requestId: "mcp",
		...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
	};
}

/**
 * Runs `body` against a fresh MCP session and always tears it down. grep.app
 * does not return a session id today, so `close()` is a no-op there; it stays
 * so this stays correct if that changes.
 */
async function withMcpSession<T>(
	req: SearchRequest,
	options: GrepSearchOptions,
	body: (client: McpClient) => Promise<T>,
): Promise<T> {
	const client = createMcpClient({
		url: GREP_MCP_URL,
		fetchImpl: options.fetchImpl,
		timeoutMs: req.settings.timeoutMs,
		signal: req.signal,
	});
	try {
		await client.initialize();
		return await body(client);
	} finally {
		await client.close().catch(() => {});
	}
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
 * followed by `--- Snippet N (Line X) ---` bodies. A blank line separates
 * groups, which is what ends the previous one — the same rule the Exa parser
 * needs, and the reason anchors are only matched outside a snippet block.
 */
export function parseGrepSearchText(text: string, maxResults: number): SearchResultDetail[] {
	const hits: GrepHit[] = [];
	let current: GrepHit | undefined;
	let inSnippets = false;
	let snippetLines: string[] = [];
	let inSnippet = false;

	const endSnippet = () => {
		if (inSnippet && current) {
			const body = snippetLines.join("\n").trim();
			if (body.length > 0) {
				current.snippets.push(body);
			}
		}
		snippetLines = [];
		inSnippet = false;
	};

	const endGroup = () => {
		endSnippet();
		if (current?.repo || current?.path || current?.url) {
			hits.push(current);
		}
		current = undefined;
		inSnippets = false;
	};

	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line.length === 0) {
			// A blank line closes the snippet block, and the next structural
			// anchor opens a new hit.
			endSnippet();
			inSnippets = false;
			continue;
		}
		if (inSnippet) {
			if (line.startsWith("--- Snippet")) {
				endSnippet();
				inSnippet = true;
				continue;
			}
			snippetLines.push(raw);
			continue;
		}
		if (line.startsWith("--- Snippet")) {
			inSnippets = true;
			inSnippet = true;
			continue;
		}
		if (inSnippets) {
			continue;
		}
		if (line.startsWith("Snippets:")) {
			inSnippets = true;
			continue;
		}
		const field = readField(line, "Repository");
		if (field !== undefined) {
			endGroup();
			current = { ...field, snippets: [] };
			continue;
		}
		if (current && line.startsWith("Path:")) {
			current.path = readValue(line);
		} else if (current && line.startsWith("URL:")) {
			current.url = readValue(line);
		} else if (current && line.startsWith("License:")) {
			current.license = readValue(line);
		}
	}
	endGroup();

	return hits
		.slice(0, Math.min(maxResults, MAX_RESULTS_CAP))
		.map((hit) => ({
			title: hit.repo && hit.path ? `${hit.repo}/${hit.path}` : hit.repo ?? hit.path,
			url: hit.url,
			source: PROVIDER_NAME,
			type: "content",
			...(hit.license ? { query: hit.license } : {}),
			...(hit.snippets.length > 0 ? { citedText: hit.snippets.join("\n\n") } : {}),
		}));
}

function readField(line: string, label: string): { repo: string } | undefined {
	if (!line.startsWith(`${label}:`)) {
		return undefined;
	}
	const value = readValue(line);
	return value ? { repo: value } : undefined;
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

class LanguageFilterWarning {
	private readonly used: boolean;

	constructor(query: string) {
		this.used = extractQualifier(query, "language") !== undefined;
	}

	messages(): string[] {
		if (!this.used) {
			return [];
		}
		return [
			"grep.app's language filter is unreliable and may have returned no matches; treat zero results with a language filter as inconclusive.",
		];
	}
}
