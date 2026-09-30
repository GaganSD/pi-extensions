import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import type {
	ProviderErrorCode,
	ProviderKind,
	SearchResultDetail,
	Source,
	StreamResult,
} from "./providers/types.ts";

/** Excerpts are a preview, not the document: keep them short. */
export const EXCERPT_MAX_CHARS = 400;

/** Heading text of each rendered section, exported so tests can assert on them. */
export const RESULTS_HEADING = "## Results";
export const SOURCES_HEADING = "## Sources";
export const WARNINGS_HEADING = "## Warnings";

/**
 * Structured payload returned in `AgentToolResult.details`.
 *
 * `formatWebSearchResult` always populates the result fields; the error fields
 * are set by the failure results in `utils.ts`. `index.ts` treats any result
 * with `error` set as a failure.
 */
export interface WebSearchDetails {
	/** Error class; absent on a successful search. */
	error?: ProviderErrorCode;
	/** Transport error code; equals `error` for provider failures. */
	code?: ProviderErrorCode;
	/** HTTP status, when the provider reported one. */
	status?: number;
	/** Human-readable failure message. */
	message?: string;
	/** Config file path; only for `invalid_config`. */
	configPath?: string;
	/** Actionable next step; only for `missing_credentials`. */
	hint?: string;
	/** Provider that produced the result. */
	provider?: ProviderKind;
	/** Exa requestId or Parallel search_id. */
	requestId?: string;
	/** Number of reported results: search results, or sources when there are none. */
	resultCount?: number;
	sources?: Source[];
	searchResults?: SearchResultDetail[];
	warnings?: string[];
	/** True when the result carries at least one source URL. */
	grounded?: boolean;
	/** Decision-layer verdicts; present only when jev actually ran. */
	jev?: StreamResult["jev"];
}

export interface TruncationLimits {
	maxLines?: number;
	maxBytes?: number;
}

/**
 * Truncates with the agent's shared head limits. `limits` exists so tests can
 * exercise the marker with a small line budget; production callers omit it.
 */
export function formatResult(
	text: string,
	details: WebSearchDetails,
	limits?: TruncationLimits,
): AgentToolResult<WebSearchDetails> {
	const { content, truncated } = truncateHead(text, {
		maxLines: limits?.maxLines ?? DEFAULT_MAX_LINES,
		maxBytes: limits?.maxBytes ?? DEFAULT_MAX_BYTES,
	});
	return {
		content: [
			{ type: "text", text: content + (truncated ? "\n\n[Truncated]" : "") },
		],
		details,
	};
}

/**
 * Renders a provider result as markdown: the provider's own text (when it has
 * any), then `## Results`, `## Sources` and `## Warnings`. A section is only
 * emitted when it has content, so the output never has an orphan header.
 * Deterministic for a given `StreamResult`.
 */
export function formatWebSearchResult(
	result: StreamResult,
	limits?: TruncationLimits,
): AgentToolResult<WebSearchDetails> {
	const sources = result.sources ?? [];
	const searchResults = result.searchResults ?? [];
	const warnings = result.warnings ?? [];

	const sections: string[] = [];
	if (result.text.length > 0) {
		sections.push(result.text);
	}
	const results = buildResultsSection(searchResults);
	if (results) {
		sections.push(results);
	}
	const sourcesSection = buildSourcesSection(sources);
	if (sourcesSection) {
		sections.push(sourcesSection);
	}
	if (warnings.length > 0) {
		sections.push(
			`${WARNINGS_HEADING}\n\n${warnings.map((w) => `- ${w}`).join("\n")}`,
		);
	}

	return formatResult(sections.join("\n\n"), {
		provider: result.providerKind,
		requestId: result.requestId,
		resultCount: searchResults.length || sources.length,
		sources,
		searchResults,
		warnings,
		grounded: sources.length > 0,
		...(result.jev ? { jev: result.jev } : {}),
	}, limits);
}

function buildResultsSection(results: SearchResultDetail[]): string {
	const entries: string[] = [];
	results.forEach((result, index) => {
		const label = result.title?.trim() || result.url?.trim() || `Result ${index + 1}`;
		const heading = result.url ? `[${label}](${result.url})` : label;
		const excerpt = buildExcerpt(result.citedText);
		entries.push(excerpt ? `${index + 1}. ${heading}\n> ${excerpt}` : `${index + 1}. ${heading}`);
	});
	if (entries.length === 0) {
		return "";
	}
	return `${RESULTS_HEADING}\n\n${entries.join("\n\n")}`;
}

function buildSourcesSection(sources: Source[]): string {
	if (sources.length === 0) {
		return "";
	}
	const lines = sources.map(
		(source, index) => `${index + 1}. [${source.title}](${source.url})`,
	);
	return `${SOURCES_HEADING}\n\n${lines.join("\n")}`;
}

/** Collapses whitespace and caps the excerpt; empty input yields no quote. */
function buildExcerpt(citedText: string | undefined): string {
	if (!citedText) {
		return "";
	}
	const collapsed = citedText.replace(/\s+/g, " ").trim();
	if (collapsed.length === 0) {
		return "";
	}
	return collapsed.slice(0, EXCERPT_MAX_CHARS);
}
