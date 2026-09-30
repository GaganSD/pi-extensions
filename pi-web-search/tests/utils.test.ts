import assert from "node:assert/strict";
import test from "node:test";

import type { InvalidConfigError } from "../src/providers/config.ts";
import { providerError } from "../src/providers/types.ts";
import {
	errorResult,
	invalidConfigResult,
	missingCredentialResult,
} from "../src/utils.ts";

test("invalidConfigResult reports invalid_config with the config path", () => {
	const error = providerError(
		"invalid_config",
		"/tmp/web-search.json is not valid JSON",
	) as InvalidConfigError;
	error.configPath = "/tmp/web-search.json";

	const result = invalidConfigResult(error);
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";

	assert.equal(result.details.error, "invalid_config");
	assert.equal(result.details.configPath, "/tmp/web-search.json");
	assert.equal(
		text,
		"web_search failed (invalid_config): /tmp/web-search.json is not valid JSON",
	);
});

test("missingCredentialResult reports missing_credentials with a hint", () => {
	const result = missingCredentialResult("parallel", "Set PARALLEL_API_KEY.");
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";

	assert.equal(result.details.error, "missing_credentials");
	assert.equal(result.details.code, "missing_credentials");
	assert.equal(result.details.provider, "parallel");
	assert.equal(result.details.hint, "Set PARALLEL_API_KEY.");
	assert.equal(
		text,
		"web_search failed (missing_credentials): parallel: Set PARALLEL_API_KEY.",
	);
});

test("errorResult maps a provider error code and status", () => {
	const result = errorResult(
		providerError("rate_limited", "Too many requests.", { status: 429 }),
	);
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";

	assert.equal(result.details.error, "rate_limited");
	assert.equal(result.details.code, "rate_limited");
	assert.equal(result.details.status, 429);
	assert.equal(text, "web_search failed (rate_limited): Too many requests.");
});

test("errorResult omits status when the provider did not report one", () => {
	const result = errorResult(providerError("network_error", "socket hang up"));

	assert.equal(result.details.error, "network_error");
	assert.equal("status" in result.details, false);
});

test("errorResult maps a non-Error throw to unknown without a stack", () => {
	const result = errorResult("kaboom");
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";

	assert.equal(result.details.error, "unknown");
	assert.equal(result.details.code, "unknown");
	assert.equal(text, "web_search failed (unknown): kaboom");
	assert.equal(text.includes("at "), false);
	assert.equal("stack" in (result.details as Record<string, unknown>), false);
});

test("errorResult maps a plain Error to unknown and keeps only its message", () => {
	const cause = new Error("boom");
	const result = errorResult(new Error("wrapper", { cause }));
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";

	assert.equal(result.details.error, "unknown");
	assert.equal(text, "web_search failed (unknown): wrapper");
});
