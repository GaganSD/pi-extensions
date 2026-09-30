import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { WebSearchDetails } from "./format.ts";
import type { InvalidConfigError } from "./providers/config.ts";
import type { ProviderError, ProviderErrorCode, ProviderKind } from "./providers/types.ts";
import { isProviderError } from "./providers/types.ts";

/** Message prefix every failure shares, so the model can pattern-match it. */
function failureMessage(code: ProviderErrorCode, message: string): string {
	return `web_search failed (${code}): ${message}`;
}

function failureResult(
	details: WebSearchDetails,
): AgentToolResult<WebSearchDetails> {
	return {
		content: [{ type: "text", text: details.message ?? "web_search failed" }],
		details,
	};
}

/** Surfaces a malformed or unreadable config file instead of throwing. */
export function invalidConfigResult(
	error: InvalidConfigError,
): AgentToolResult<WebSearchDetails> {
	return failureResult({
		error: "invalid_config",
		code: "invalid_config",
		message: failureMessage("invalid_config", error.message),
		configPath: error.configPath,
	});
}

/** No configured provider had usable credentials. */
export function missingCredentialResult(
	kind: ProviderKind,
	hint: string,
): AgentToolResult<WebSearchDetails> {
	return failureResult({
		error: "missing_credentials",
		code: "missing_credentials",
		message: failureMessage("missing_credentials", `${kind}: ${hint}`),
		provider: kind,
		hint,
	});
}

/**
 * Maps anything thrown during a search onto a tool result. Non-provider values
 * become `unknown` and only their message is kept — never a stack.
 */
export function errorResult(
	e: unknown,
): AgentToolResult<WebSearchDetails> {
	if (isProviderError(e)) {
		return providerFailureResult(e);
	}
	const message = e instanceof Error ? e.message : String(e);
	return failureResult({
		error: "unknown",
		code: "unknown",
		message: failureMessage("unknown", message),
	});
}

function providerFailureResult(
	error: ProviderError,
): AgentToolResult<WebSearchDetails> {
	const details: WebSearchDetails = {
		error: error.code,
		code: error.code,
		message: failureMessage(error.code, error.message),
	};
	if (error.status !== undefined) {
		details.status = error.status;
	}
	return failureResult(details);
}
