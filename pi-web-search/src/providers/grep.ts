import type { FetchLike } from "./http.ts";
import type { SearchRequest } from "./index.ts";
import { withMcpSession } from "./mcp.ts";
import { sourcesFromResults } from "./results.ts";
import { isProviderError, type SearchResultDetail, type StreamResult } from "./types.ts";

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
	const parsed = parseCodeQuery(req.query);
	const warnings = parsed.languages.length > 0 ? [LANGUAGE_FILTER_WARNING] : [];

	// grep.app's `language` filter is nondeterministically broken (verified
	// 2026-09-30: identical queries returned 504, empty, then 504). Passing it
	// silently turns a flaky upstream into a confidently wrong "no such code
	// exists" answer, so only an explicit `language:` qualifier in the query
	// triggers it, and that path always warns.
	//
	// `query` is a *literal code pattern* for grep.app, so extracted qualifiers
	// are removed from it. Leaving `repo:facebook/react` in the pattern would
	// search for that whole string instead of the code the caller asked for.
	const args: Record<string, unknown> = {
		query: parsed.literal,
	};
	if (parsed.repo !== undefined) {
		args.repo = parsed.repo;
	}
	if (parsed.languages.length > 0) {
		args.language = parsed.languages;
	}

	let text: string;
	try {
		text = await withMcpSession(
			{
				url: GREP_MCP_URL,
				fetchImpl: options.fetchImpl,
				timeoutMs: req.settings.timeoutMs,
				signal: req.signal,
			},
			(client) => client.callTool(SEARCH_TOOL, args),
		);
	} catch (error) {
		if (isNoMatchToolError(error)) {
			return emptyGrepResult(parsed, warnings);
		}
		throw error;
	}

	const results = parseGrepSearchText(text, req.settings.maxResults);
	// Zero hits are a real answer, not a result to render: wrapping
	// grep.app's "No results found" text as a hit made an empty search look
	// like one result and said nothing about why. An empty parse is not
	// always a no-match though, so the warning distinguishes the cases rather
	// than asserting a negative the tool cannot know.
	const upstream = text.trim();
	const noMatchWarnings =
		results.length > 0
			? []
			: upstream.length === 0
				? ["grep.app returned an empty reply."]
				: /no results found/i.test(upstream)
					? [
						parsed.repo !== undefined
							? `grep.app found no matches in repo:${parsed.repo}. That repository may not be indexed; retry without the repo: qualifier, or with a shorter literal identifier.`
							: "grep.app found no matches. Retry with a shorter literal identifier (not a sentence), or drop repo:/language: qualifiers.",
					]
					: [`grep.app replied with content this tool could not parse: ${excerpt(upstream)}`];

	const allWarnings = [...warnings, ...noMatchWarnings];

	return {
		text: "",
		providerKind: "grep",
		sources: sourcesFromResults(results),
		searchResults: results,
		requestId: "mcp",
		...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
	};
}

function isNoMatchToolError(error: unknown): boolean {
	return isProviderError(error) && error.code === "tool_error" && /no results found/i.test(error.message);
}

function emptyGrepResult(parsed: ParsedCodeQuery, warnings: string[]): StreamResult {
	const hint = parsed.repo !== undefined
		? `grep.app found no matches in repo:${parsed.repo}. That repository may not be indexed; retry without the repo: qualifier, or with a shorter literal identifier.`
		: "grep.app found no matches. Retry with a shorter literal identifier (not a sentence), or drop repo:/language: qualifiers.";
	return {
		text: "",
		providerKind: "grep",
		sources: [],
		searchResults: [],
		requestId: "mcp",
		warnings: [...warnings, hint],
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

			...(hit.snippets.length > 0 ? { citedText: hit.snippets.join("\n\n") } : {}),
		}));
}

function readValue(line: string): string {
	const index = line.indexOf(":");
	return index === -1 ? "" : line.slice(index + 1).trim();
}

export interface ParsedCodeQuery {
	/** The literal code pattern, with supported qualifiers removed. */
	literal: string;
	repo?: string;
	languages: string[];
}

const QUALIFIER = /^(repo|language):(.*)$/i;

/**
 * Splits GitHub-style `repo:`/`language:` qualifiers out of a code query.
 *
 * grep.app treats `query` as a literal code pattern, so a qualifier left in it
 * becomes part of the searched text. Tokenization respects quotes, so a code
 * literal such as `"repo:x"` is never mistaken for a filter.
 */
export function parseCodeQuery(query: string): ParsedCodeQuery {
	const kept: string[] = [];
	let repo: string | undefined;
	const languages: string[] = [];
	for (const token of splitRespectingQuotes(query)) {
		const match = QUALIFIER.exec(token);
		if (!match) {
			kept.push(token);
			continue;
		}
		const value = unquote(match[2]);
		if (value.length === 0) {
			kept.push(token);
			continue;
		}
		if (match[1].toLowerCase() === "repo") {
			repo ??= value;
			continue;
		}
		if (!languages.includes(value)) {
			languages.push(value);
		}
	}
	// A query made only of qualifiers has no literal pattern; keep the original
	// text so an empty required `query` is never sent upstream.
	const literal = kept.length > 0 ? kept.join(" ").trim() : query.trim();
	return { literal, repo, languages };
}

/** Splits on whitespace, keeping quoted spans (and their quotes) intact. */
function splitRespectingQuotes(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: string | undefined;
	for (const ch of input) {
		if (quote !== undefined) {
			current += ch;
			if (ch === quote) {
				quote = undefined;
			}
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			quote = ch;
			current += ch;
			continue;
		}
		if (/\s/.test(ch)) {
			if (current.length > 0) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}
	if (current.length > 0) {
		tokens.push(current);
	}
	return tokens;
}

/** Strips one matching pair of surrounding quotes, if present. */
function unquote(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length >= 2) {
		const first = trimmed[0];
		if (
			(first === '"' || first === "'" || first === "`") &&
			trimmed.endsWith(first)
		) {
			return trimmed.slice(1, -1);
		}
	}
	return trimmed;
}

const LANGUAGE_FILTER_WARNING =
	"grep.app's language filter is unreliable and may have returned no matches; treat zero results with a language filter as inconclusive.";

/** One bounded single-line excerpt: upstream errors carry newlines and control bytes. */
function excerpt(text: string, max = 200): string {
	const flat = Array.from(
		text.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim(),
	);
	return flat.length > max ? `${flat.slice(0, max).join("")}\u2026` : flat.join("");
}
