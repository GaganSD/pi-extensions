import type {
	AgentToolResult,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	type CodeSearchInput,
	CodeSearchSchema,
	codeSearch,
} from "./code_search.ts";
import type { WebSearchDetails } from "./format.ts";
import { peekResearchEnabled } from "./providers/config.ts";
import {
	type ResearchSearchInput,
	ResearchSearchSchema,
	researchSearch,
} from "./research_search.ts";
import {
	type WebSearchInput,
	WebSearchSchema,
	webSearch,
} from "./web_search.ts";

export default function webSearchExtension(pi: ExtensionAPI) {
	pi.registerTool<typeof WebSearchSchema, WebSearchDetails>({
		name: "web_search",
		label: "Web Search",
		description:
			"Search web pages and documentation. Optionally retrieve excerpts from supplied URLs alongside the search.",
		parameters: WebSearchSchema,
		execute: (toolCallId, params, signal, onUpdate, ctx) =>
			webSearch(toolCallId, params, signal, onUpdate, ctx),
		renderCall(args: WebSearchInput, theme) {
			const query = args.query || "…";
			const urlCount = args.urls?.length ?? 0;
			const urls =
				urlCount > 0
					? theme.fg("muted", ` + ${urlCount} URL${urlCount === 1 ? "" : "s"}`)
					: "";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("web_search"))} ${theme.fg("accent", query)}${urls}`,
				0,
				0,
			);
		},
		renderResult,
	});

	pi.registerTool<typeof CodeSearchSchema, WebSearchDetails>({
		name: "code_search",
		label: "Code Search",
		description:
			"Search public source code for identifiers or code snippets. Use web_search for documentation and explanatory prose.",
		parameters: CodeSearchSchema,
		execute: (toolCallId, params, signal, onUpdate, ctx) =>
			codeSearch(toolCallId, params, signal, onUpdate, ctx),
		renderCall(args: CodeSearchInput, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("code_search"))} ${theme.fg("accent", args.query || "…")}`,
				0,
				0,
			);
		},
		renderResult,
	});

	if (peekResearchEnabled()) {
		pi.registerTool<typeof ResearchSearchSchema, WebSearchDetails>({
			name: "research_search",
			label: "Research Search",
			description:
				"Cross-check a query across available sources in an explicit scope. Slower than ordinary search; may apply optional ranking and safety judgments.",
			parameters: ResearchSearchSchema,
			execute: (toolCallId, params, signal, onUpdate, ctx) =>
				researchSearch(toolCallId, params, signal, onUpdate, ctx),
			renderCall(args: ResearchSearchInput, theme) {
				const query = `${args.query || "…"} [${args.scope}]`;
				return new Text(
					`${theme.fg("toolTitle", theme.bold("research_search"))} ${theme.fg("accent", query)}`,
					0,
					0,
				);
			},
			renderResult,
		});
	}
}

function renderResult(
	result: AgentToolResult<WebSearchDetails>,
	{ expanded }: { expanded: boolean },
	theme: { fg: (color: "error" | "toolOutput", text: string) => string },
) {
	const output = result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	const isError = Boolean(result.details?.error);
	if (!expanded && !isError) {
		return new Text("", 0, 0);
	}
	return new Text(theme.fg(isError ? "error" : "toolOutput", output), 0, 0);
}
