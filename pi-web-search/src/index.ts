import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { VERSION } from "@earendil-works/pi-coding-agent";
import {
	handleWebSearchCommand,
	WEB_SEARCH_COMMAND,
	webSearchCompletions,
} from "./command.ts";
import { enableStoredCredentials, parallelApiKey } from "./env.ts";
import { PARALLEL_MCP_SERVER, PARALLEL_MCP_URL } from "./providers/parallel.ts";
import {
	type CodeSearchInput,
	CodeSearchSchema,
	codeSearch,
} from "./code_search.ts";
import { SearchOutputSchema, type WebSearchDetails } from "./format.ts";
import { resolveSettingsSync } from "./providers/config.ts";
import {
	type MultiSearchInput,
	MultiSearchSchema,
	multiSearch,
} from "./multi_search.ts";
import {
	type WebSearchInput,
	WebSearchSchema,
	webSearch,
} from "./web_search.ts";
import { maybeShowWelcome } from "./welcome.ts";
import { evidenceOwner, evidenceStore } from "./evidence.ts";
import { SearchReadSchema, searchRead } from "./search_read.ts";
import { clearRetrievalCache } from "./providers/reuse.ts";

/** Fail closed on unsupported or malformed host versions. */
export function assertSupportedPiVersion(version: string): void {
	const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\w.-]+))?(?:\+[\w.-]+)?$/.exec(version);
	if (!match || (Number(match[1]) === 0 &&
		(Number(match[2]) < 99 || (Number(match[2]) === 99 && Number(match[3]) === 0 && match[4])))) {
		throw new Error("pi-web-search requires Pi >=0.99.0.");
	}
}

export default function webSearchExtension(pi: ExtensionAPI) {
	assertSupportedPiVersion(VERSION);

	// Pi's auth.json is the one secret store. Enabling it here (not at import)
	// keeps a bare import of the tools, and the test suite, off the operator's
	// secrets; every read still goes to the current file.
	enableStoredCredentials();

	pi.on("session_start", async (event, ctx) => {
		if (event.reason === "fork") {
			return;
		}
		await maybeShowWelcome(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		const owner = evidenceOwner(ctx);
		if (owner) { evidenceStore.clear(owner); clearRetrievalCache(owner); }
	});

	// Stable, script-discoverable continuation: no extra default tool declaration.
	pi.registerTool({
		name: "search_read", label: "Read Search Evidence",
		description: "Read stored search evidence locally: omit index to list; select index and offset or find to read passages. No network requests. Handles expire after 10 minutes or reload.",
		parameters: SearchReadSchema, outputSchema: SearchOutputSchema,
		exposure: "codemode",
		namespace: { name: "search", description: "Cited public web and code retrieval." },
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		execute: async (_id, params, signal, _update, ctx) => searchRead(params, ctx, signal),
	});

	pi.registerTool<typeof WebSearchSchema, WebSearchDetails>({
		name: "web_search",
		label: "Web Search",
		reachesTools: () => [`mcp__${PARALLEL_MCP_SERVER}`],
		description:
			"Search web pages, or fetch supplied URLs without a query. Returns cited previews and a handle for more evidence.",
		promptSnippet:
			"Search the public web (documentation, prose, current events) and optionally retrieve supplied URLs.",
		promptGuidelines: [
			"Use local `rg`/`grep` for files in the workspace; use `code_search` for literal code across public repositories.",
			"For a known page, call `web_search` with `urls` only; omit `query` to skip search. More evidence is available through codemode's `search_read` using the returned resultId.",
		],
		parameters: WebSearchSchema,
		outputSchema: SearchOutputSchema,
		namespace: { name: "search", description: "Cited public web and code retrieval." },
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
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
		promptSnippet:
			"Search public source code for a literal identifier or snippet; supports repo:/language: qualifiers.",
		promptGuidelines: [
			"`code_search` understands `repo:<owner/name>` and `language:<name>`; other GitHub-specific qualifiers are provider-dependent and are not translated into grep.app filters.",
		],
		parameters: CodeSearchSchema,
		outputSchema: SearchOutputSchema,
		namespace: { name: "search", description: "Cited public web and code retrieval." },
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
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

	// Pi gives an explicit same-name mcp.json entry precedence over this registration.
	// Register at load time only when the configured web/research policy can use it.
	const registered = resolveSettingsSync();
	if (!("error" in registered) &&
		(registered.web.provider === "parallel" || registered.web.fallback.includes("parallel") || registered.researchEnabled)) {
		const key = parallelApiKey();
		pi.registerMcpServer(PARALLEL_MCP_SERVER, {
			url: PARALLEL_MCP_URL,
			exposure: "codemode",
			...(key ? { headers: { Authorization: `Bearer ${key}` } } : {}),
		});
	}

	// Tool exposure and execution use the same research.enabled switch.
	if (!("error" in registered) && registered.researchEnabled) {
		pi.registerTool<typeof MultiSearchSchema, WebSearchDetails>({
			name: "multi_search",
			label: "Multi Search",
			reachesTools: (input) => input.scope === "code" ? [] : [`mcp__${PARALLEL_MCP_SERVER}`],
			description:
				"Search multiple available sources concurrently in an explicit scope. May apply optional ranking and safety classification.",
			promptSnippet:
				"Opt-in multi-source search over web and/or code with an explicit scope; optional ranking and safety classification.",
			promptGuidelines: [
				"Use `multi_search` when you need retrieval from multiple sources; it is slower than `web_search`.",
				"`multi_search` takes an explicit `scope`: `web`, `code`, or `both`.",
			],
			parameters: MultiSearchSchema,
			outputSchema: SearchOutputSchema,
			namespace: { name: "search", description: "Cited public web and code retrieval." },
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
			execute: (toolCallId, params, signal, onUpdate, ctx) =>
				multiSearch(toolCallId, params, signal, onUpdate, ctx),
			renderCall(args: MultiSearchInput, theme) {
				const query = `${args.query || "…"} [${args.scope}]`;
				return new Text(
					`${theme.fg("toolTitle", theme.bold("multi_search"))} ${theme.fg("accent", query)}`,
					0,
					0,
				);
			},
			renderResult,
		});
	}

	const command = {
		description: "Search settings, provider keys, or classifier pin",
		getArgumentCompletions: webSearchCompletions,
		handler: (args: string, ctx: ExtensionContext) => handleWebSearchCommand(args, ctx, pi),
	};
	pi.registerCommand(WEB_SEARCH_COMMAND, command);
}

export { availableClassifiers } from "./command.ts";

type RenderTheme = {
	fg: (color: "error" | "toolOutput" | "muted", text: string) => string;
};

function renderResult(
	result: AgentToolResult<WebSearchDetails>,
	{ expanded }: { expanded: boolean },
	theme: RenderTheme,
	context: { isError: boolean },
) {
	const output = result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	const isError = context.isError;
	if (!expanded) {
		// A collapsed successful search still shows a compact count, so a run is
		// never an unexplained blank row.
		const collapsed = isError ? output : result.details?.provider ? compactSummary(result.details) : output;
		return new Text(theme.fg(isError ? "error" : "muted", collapsed), 0, 0);
	}
	return new Text(theme.fg(isError ? "error" : "toolOutput", output), 0, 0);
}

function compactSummary(details: WebSearchDetails | undefined): string {
	if (!details) {
		return "";
	}
	const parts: string[] = [];
	const provider = details.providers?.length
		? details.providers.join(", ")
		: details.provider;
	if (provider) {
		parts.push(provider);
	}
	const count = details.resultCount ?? 0;
	parts.push(`${count} result${count === 1 ? "" : "s"}`);
	const warningCount = details.warnings?.length ?? 0;
	if (warningCount > 0) {
		parts.push(`${warningCount} warning${warningCount === 1 ? "" : "s"}`);
	}
	if (details.scope) {
		parts.push(details.scope);
	}
	if (details.jevStatus && details.jevStatus !== "disabled") {
		parts.push(`jev ${details.jevStatus}`);
	}
	return parts.join(" · ");
}
