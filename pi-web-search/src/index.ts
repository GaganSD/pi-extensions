import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { parallelApiKey } from "./env.ts";
import { PARALLEL_MCP_SERVER, PARALLEL_MCP_URL } from "./providers/parallel.ts";
import {
	type CodeSearchInput,
	CodeSearchSchema,
	codeSearch,
} from "./code_search.ts";
import {
	CREDENTIAL_ENV_ALIASES,
	CREDENTIAL_PROVIDER_IDS,
	enableStoredCredentials,
	githubToken,
	resolveCredential,
} from "./env.ts";
import { SearchOutputSchema, type WebSearchDetails } from "./format.ts";
import {
	configureJev,
	resolveSettings,
	resolveSettingsSync,
} from "./providers/config.ts";
import { JEV_BACKENDS, isJevBackend, resolveJevTarget } from "./jev/model.ts";
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

	pi.registerTool<typeof WebSearchSchema, WebSearchDetails>({
		name: "web_search",
		label: "Web Search",
		description:
			"Search web pages and documentation. Optionally retrieve excerpts from supplied URLs alongside the search.",
		promptSnippet:
			"Search the public web (documentation, prose, current events) and optionally retrieve supplied URLs.",
		promptGuidelines: [
			"Use `web_search` for documentation, prose, and current events on the public web.",
			"Use local `rg`/`grep` for files in the workspace; use `code_search` for literal code across public repositories.",
			"To read a specific web page, call `web_search` with the URL in `urls`; `read` cannot open URLs.",
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
			"Use `code_search` for a literal identifier or code snippet in public repositories, not for prose questions.",
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
			exposure: "codemode-deferred",
			...(key ? { headers: { Authorization: `Bearer ${key}` } } : {}),
		});
	}

	// Tool exposure and execution use the same research.enabled switch.
	if (!("error" in registered) && registered.researchEnabled) {
		pi.registerTool<typeof MultiSearchSchema, WebSearchDetails>({
			name: "multi_search",
			label: "Multi Search",
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

	pi.registerCommand("web-search-settings", {
		description: "Show search settings; use typesafe, vercel, openrouter, or off to configure optional Jev",
		getArgumentCompletions: (prefix) => [...JEV_BACKENDS, "off"].filter((value) => value.startsWith(prefix))
			.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const selection = args.trim();
			let report: string;
			if (selection && selection !== "off" && !isJevBackend(selection)) {
				report = "Usage: /web-search-settings [typesafe|vercel|openrouter|off]. No keys belong in this command.";
			} else {
				try {
					const saved = isJevBackend(selection) || selection === "off" ? await configureJev(selection) : undefined;
					report = (saved ? `Saved search settings to ${saved}. Run /reload to apply tool exposure changes.\n\n` : "") +
						await buildSettingsReport(ctx.modelRegistry);
				} catch {
					report = "Could not update search settings. Check the config file and permissions; malformed configuration is never overwritten.";
				}
			}
			if (ctx.hasUI) {
				ctx.ui.notify(report, "info");
			} else {
				// Do not corrupt JSON/RPC stdout in headless mode.
				pi.sendMessage({ customType: "web-search-settings", content: report, display: true });
			}
		},
	});
}

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

/**
 * Report retrieval credential presence and Pi's classifier auth snapshot, never keys.
 * No classifier requests or credential re-resolution are made here.
 */
async function buildSettingsReport(registry: ExtensionContext["modelRegistry"] | undefined): Promise<string> {
	const resolved = await resolveSettings();
	if ("error" in resolved) {
		return [
			"pi-web-search settings",
			`config: ${resolved.error.configPath}`,
			`error: ${resolved.error.message}`,
			"Fix the file, then run /reload.",
		].join("\n");
	}

	const selected = resolveJevTarget(resolved.jev);
	const list = (kinds: readonly string[]) =>
		kinds.length > 0 ? kinds.join(", ") : "none";
	const lines: string[] = [
		"pi-web-search settings",
		`config: ${resolved.configPath}`,
		`web_search: ${resolved.web.provider} (fallback: ${list(resolved.web.fallback)})`,
		`code_search: ${resolved.code.provider} (fallback: ${list(resolved.code.fallback)})`,
		`multi_search: ${resolved.researchEnabled ? "enabled" : "disabled"}`,
		`jev: ${resolved.jev.enabled ? `enabled (${selected.provider}/${selected.model})` : "disabled"}`,
		"",
		"Search credentials (presence only; keys are never shown):",
	];
	for (const id of CREDENTIAL_PROVIDER_IDS) {
		const found = resolveCredential(id);
		const aliases = CREDENTIAL_ENV_ALIASES[id].join(" or ");
		const viaGh = id === "github" && found === undefined && githubToken() !== undefined;
		lines.push(
			found
				? `- ${id}: present via ${found.source === "env" ? found.name : "auth.json"}`
				: viaGh
					? `- github: present via gh auth`
					: id === "parallel"
					? `- parallel: anonymous MCP needs no key; ${aliases} or auth.json is optional for higher limits`
					: id === "github"
						? `- github: missing — set ${aliases}, run gh auth login, or add "github" to auth.json`
						: `- ${id}: missing — set ${aliases}, or add "${id}" to auth.json`,
		);
	}
	lines.push("", "Classifier authentication (Pi snapshot; not a live credential test):");
	for (const backend of JEV_BACKENDS) {
		const target = resolveJevTarget({ backend });
		if (target.provider === selected.provider) target.model = selected.model;
		const auth = registry?.getProviderAuthStatus(target.provider);
		const registered = registry?.findOfType("classifier", target.provider, target.model);
		lines.push(`- ${target.provider}: ${auth?.configured ? "Pi auth configured" : registry ? "Pi auth not configured" : "Pi auth status unavailable"}; ${registered ? "classifier registered" : "classifier not registered"}. /login ${target.provider} if needed.`);
	}
	lines.push(
		"",
		"Setup:",
		"- Reuse your existing Pi classifier login/key. No separate Jev key is needed; provider billing applies.",
		"- Enable optional Jev: /web-search-settings typesafe, vercel, or openrouter; then /reload.",
		"- Disable judgment: /web-search-settings off. Nonsecret settings live in web-search.json.",
		"- Gateways require explicit selection. auto uses TypeSafe only; no classifier provider fallback.",
		"- Code search is keyless via grep.app and Sourcegraph. GitHub is optional (token or gh auth login).",
		"- Parallel native MCP is keyless by default; check /mcp for connection status or a same-name mcp.json override.",
		"- Run /reload after changing multi_search exposure or a Parallel credential (its MCP header is captured at registration).",
		"- Install from a repository checkout: pi install ./pi-web-search",
		"- After an npm release is available: pi install npm:@gagansd/pi-web-search",
	);
	return lines.join("\n");
}
