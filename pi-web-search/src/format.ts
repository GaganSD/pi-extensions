import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import type {
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
export const COVERAGE_HEADING = "## Coverage";

const ProviderSchema = Type.Union([Type.Literal("exa"), Type.Literal("parallel"), Type.Literal("grep"), Type.Literal("github")]);

/** One declared data contract for renderers, scripts, and failure results. */
const DetailsSchema = Type.Object({
	provider: Type.Optional(ProviderSchema),
	providers: Type.Optional(Type.Array(ProviderSchema)),
	requestId: Type.Optional(Type.String()),
	resultCount: Type.Optional(Type.Integer({ minimum: 0 })),
	sources: Type.Optional(Type.Array(Type.Object({ title: Type.String(), url: Type.String() }))),
	searchResults: Type.Optional(Type.Array(Type.Object({
		title: Type.Optional(Type.String()), url: Type.Optional(Type.String()),
		query: Type.Optional(Type.String()), source: Type.Optional(Type.String()),
		pageAge: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		citedText: Type.Optional(Type.String()), status: Type.Optional(Type.String()), type: Type.Optional(Type.String()),
	}))),
	warnings: Type.Optional(Type.Array(Type.String())),
	usage: Type.Optional(Type.Array(Type.Object({ name: Type.String(), count: Type.Number() }))),
	grounded: Type.Optional(Type.Boolean()),
	jev: Type.Optional(Type.Object({
		sufficient: Type.Boolean(), lowConfidence: Type.Boolean(), suppressed: Type.Integer({ minimum: 0 }),
		suppressedUrls: Type.Array(Type.String()),
	})),
	scope: Type.Optional(Type.Union([Type.Literal("web"), Type.Literal("code"), Type.Literal("both")])),
	jevStatus: Type.Optional(Type.Union([Type.Literal("ran"), Type.Literal("disabled"), Type.Literal("unavailable"), Type.Literal("skipped")])),
	error: Type.Optional(Type.Object({
		code: Type.String(), message: Type.String(), status: Type.Optional(Type.Number()),
		rpcCode: Type.Optional(Type.Number()), retryable: Type.Optional(Type.Boolean()), configPath: Type.Optional(Type.String()),
	})),
}, { additionalProperties: false });

export type WebSearchDetails = Static<typeof DetailsSchema>;

export const SearchOutputSchema = Type.Object({
	status: Type.Union([Type.Literal("success"), Type.Literal("error")]),
	text: Type.String(),
	...DetailsSchema.properties,
}, { additionalProperties: false });

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
		structuredContent: JSON.parse(JSON.stringify({
			status: details.error ? "error" : "success",
			text: content + (truncated ? "\n\n[Truncated]" : ""),
			...details,
		})),
		isError: details.error !== undefined,
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
	const coverage = buildCoverageSection(result);
	if (coverage) {
		sections.push(coverage);
	}
	if (result.text.length > 0) {
		sections.push(result.text);
	}
	const results = buildResultsSection(searchResults);
	if (results) {
		sections.push(results);
	}
	const sourcesSection = buildSourcesSection(sources, citedUrls(searchResults));
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
		...(result.providers ? { providers: result.providers } : {}),
		requestId: result.requestId,
		resultCount: searchResults.length || sources.length,
		sources,
		searchResults,
		warnings,
		...(result.usage ? { usage: result.usage } : {}),
		grounded: sources.length > 0,
		...(result.jev ? { jev: result.jev } : {}),
		...(result.scope ? { scope: result.scope } : {}),
		...(result.jevStatus ? { jevStatus: result.jevStatus } : {}),
	}, limits);
}

function buildCoverageSection(result: StreamResult): string {
	if (!result.scope && !result.jevStatus && !result.providers && !result.skipped?.length) {
		return "";
	}
	const lines = [
		result.scope ? `- scope: ${result.scope}` : undefined,
		result.providers?.length
			? `- consulted: ${result.providers.join(", ")}`
			: `- consulted: ${result.providerKind}`,
		result.jevStatus ? `- jev: ${result.jevStatus}` : undefined,
	];
	for (const skipped of result.skipped ?? []) {
		lines.push(`- ${skipped}`);
	}
	return `${COVERAGE_HEADING}\n\n${lines.filter(Boolean).join("\n")}`;
}

function buildResultsSection(results: SearchResultDetail[]): string {
	const entries: string[] = [];
	results.forEach((result, index) => {
		const label = result.title?.trim() || result.url?.trim() || `Result ${index + 1}`;
		const heading = result.url ? `[${label}](${result.url})` : label;
		const excerpt = buildExcerpt(result);
		entries.push(excerpt ? `${index + 1}. ${heading}\n${excerpt}` : `${index + 1}. ${heading}`);
	});
	if (entries.length === 0) {
		return "";
	}
	return `${RESULTS_HEADING}\n\n${entries.join("\n\n")}`;
}

/** URLs already linked inline by the Results section. */
function citedUrls(results: SearchResultDetail[]): Set<string> {
	const urls = new Set<string>();
	for (const result of results) {
		if (result.url) {
			urls.add(result.url);
		}
	}
	return urls;
}

/**
 * Renders a source index once: a source whose URL is already linked in the
 * Results section is not listed again, so the same full list is not emitted
 * twice (evidence stays in Results; this is only the citation index).
 */
function buildSourcesSection(sources: Source[], cited: Set<string>): string {
	const lines = sources
		.filter((source) => !cited.has(source.url))
		.map((source, index) => `${index + 1}. [${source.title}](${source.url})`);
	if (lines.length === 0) {
		return "";
	}
	return `${SOURCES_HEADING}\n\n${lines.join("\n")}`;
}

/** Caps the excerpt. Code keeps newlines; web previews collapse whitespace. */
function buildExcerpt(result: SearchResultDetail): string {
	const citedText = result.citedText;
	if (!citedText) {
		return "";
	}
	const isCode = result.source === "grep" || result.source === "github";
	if (isCode) {
		const clipped = citedText.replace(/\s+$/u, "").slice(0, EXCERPT_MAX_CHARS);
		return clipped.length > 0 ? `\`\`\`\n${clipped}\n\`\`\`` : "";
	}
	const collapsed = citedText.replace(/\s+/g, " ").trim();
	if (collapsed.length === 0) {
		return "";
	}
	return `> ${collapsed.slice(0, EXCERPT_MAX_CHARS)}`;
}
