import type {
	AgentToolResult,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { WebSearchDetails } from "./format.ts";
import { type WebSearchInput, WebSearchSchema, webSearch } from "./web_search.ts";

export default function webSearchExtension(pi: ExtensionAPI) {
	pi.registerTool<typeof WebSearchSchema, WebSearchDetails>({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web with the Exa and Parallel search APIs and get ranked results with titles, URLs and short excerpts. Optionally pass up to 20 URLs to analyze alongside the search. No LLM provider is used, so it works with any model.",
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
		renderResult(
			result: AgentToolResult<WebSearchDetails>,
			{ expanded },
			theme,
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
		},
	});
}
