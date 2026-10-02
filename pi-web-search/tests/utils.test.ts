import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import type { InvalidConfigError } from "../src/providers/config.ts";
import { SearchOutputSchema } from "../src/format.ts";
import { providerError } from "../src/providers/types.ts";
import { formatSearchError } from "../src/utils.ts";

test("failed searches return isError plus schema-valid structured data", () => {
	const result = formatSearchError("web_search", providerError("rate_limited", "Too many requests.", { status: 429 }));
	assert.equal(result.isError, true);
	assert.equal(Check(SearchOutputSchema, result.structuredContent), true);
	assert.equal(result.details.error?.code, "rate_limited");
	assert.equal(result.details.error?.status, 429);
	assert.equal(result.details.error?.message, "web_search failed (rate_limited): Too many requests.");
	assert.deepEqual(result.structuredContent, { status: "error", text: result.details.error?.message, ...JSON.parse(JSON.stringify(result.details)) });
});

test("structured failures preserve config paths and originating tool", () => {
	const error = providerError("invalid_config", "not valid JSON") as InvalidConfigError;
	error.configPath = "/tmp/web-search.json";
	const result = formatSearchError("multi_search", error);
	assert.equal(result.details.error?.configPath, error.configPath);
	assert.match(result.details.error?.message ?? "", /^multi_search failed \(invalid_config\)/);
});

test("missing HTTP fields are absent from the JSON result", () => {
	const result = formatSearchError("code_search", providerError("network_error", "socket hang up"));
	const data = result.structuredContent as { error: { status?: number; rpcCode?: number } };
	assert.equal("status" in data.error, false);
	assert.equal("rpcCode" in data.error, false);
	assert.equal(Check(SearchOutputSchema, data), true);
});

test("non-provider throws become unknown without stack or cause leakage", () => {
	for (const thrown of ["kaboom", new Error("wrapper", { cause: new Error("private cause") })]) {
		const result = formatSearchError("web_search", thrown);
		assert.equal(result.details.error?.code, "unknown");
		assert.doesNotMatch(JSON.stringify(result), /private cause|\n\s+at /);
	}
});

test("JSON-RPC codes remain distinct from HTTP statuses", () => {
	const result = formatSearchError("code_search", providerError("rpc_error", "server down", { rpcCode: -32603, retryable: true }));
	assert.equal(result.details.error?.rpcCode, -32603);
	assert.equal(result.details.error?.status, undefined);
	assert.equal(result.details.error?.retryable, true);
});
