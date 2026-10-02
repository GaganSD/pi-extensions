import assert from "node:assert/strict";
import test from "node:test";

import { applyConfig } from "../src/providers/config.ts";
import { GH_CLI_TOKEN_ARGS, githubToken } from "../src/env.ts";
import { normalizeHttpError } from "../src/providers/http.ts";
import { runSearch } from "../src/providers/index.ts";
import { providerError } from "../src/providers/types.ts";

const settings = applyConfig("/tmp/c.json", {
	code: { provider: "grep", fallback: ["sourcegraph", "github"] },
});

test("empty code hits continue to the next source", async () => {
	const attempted: string[] = [];
	const result = await runSearch({ query: "useSyncExternalStore repo:facebook/react", settings }, {
		family: "code",
		availability: { grep: true, sourcegraph: true, github: false },
		transports: {
			grep: async () => {
				attempted.push("grep");
				return { text: "", providerKind: "grep", searchResults: [], sources: [] };
			},
			sourcegraph: async () => {
				attempted.push("sourcegraph");
				return {
					text: "",
					providerKind: "sourcegraph",
					searchResults: [{
						title: "vercel/next.js/x.ts",
						url: "https://github.com/vercel/next.js/blob/HEAD/x.ts",
						source: "sourcegraph",
					}],
				};
			},
		},
	});
	assert.deepEqual(attempted, ["grep", "sourcegraph"]);
	assert.equal(result.providerKind, "sourcegraph");
	assert.match(result.warnings?.join(" ") ?? "", /grep returned no results/);
});

test("web empty results do not walk the fallback chain", async () => {
	const attempted: string[] = [];
	const result = await runSearch({ query: "q", settings: applyConfig("/tmp/c.json", {}) }, {
		family: "web",
		availability: { exa: true, parallel: true },
		transports: {
			exa: async () => {
				attempted.push("exa");
				return { text: "", providerKind: "exa", searchResults: [], sources: [] };
			},
			parallel: async () => {
				attempted.push("parallel");
				return { text: "should not run", providerKind: "parallel", searchResults: [{ url: "https://x" }] };
			},
		},
	});
	assert.deepEqual(attempted, ["exa"]);
	assert.equal(result.providerKind, "exa");
});

test("a retryable code failure continues, then keeps the last empty result", async () => {
	const result = await runSearch({ query: "q", settings }, {
		family: "code",
		availability: { grep: true, sourcegraph: true },
		transports: {
			grep: async () => {
				throw providerError("http_error", "HTTP 504", { status: 504, retryable: true });
			},
			sourcegraph: async () => ({ text: "", providerKind: "sourcegraph", searchResults: [], sources: [] }),
		},
	});
	assert.equal(result.providerKind, "sourcegraph");
	assert.match(result.warnings?.join(" ") ?? "", /grep failed \(http_error\)/);
});

test("HTML error pages are not dumped into the tool error", () => {
	const error = normalizeHttpError(
		{ ok: false, status: 504, headers: { get: () => null }, text: async () => "" },
		"<!doctype html><html><title>500: Internal Server Error</title></html>",
	);
	assert.equal(error.code, "http_error");
	assert.equal(error.status, 504);
	assert.match(error.message, /HTML error page/);
	assert.doesNotMatch(error.message, /<!doctype|<title>/i);
});

test("gh CLI token requests github.com, never the default host", () => {
	assert.deepEqual([...GH_CLI_TOKEN_ARGS], ["auth", "token", "--hostname", "github.com"]);
});

test("githubToken uses an injected gh reader only after env and auth miss", () => {
	assert.equal(
		githubToken({
			env: {},
			readCredential: () => undefined,
			readGhToken: () => " cli-token ",
		}),
		"cli-token",
	);
	assert.equal(
		githubToken({
			env: { GH_TOKEN: "env-token" },
			readCredential: () => ({ key: "stored" }),
			readGhToken: () => "cli-token",
		}),
		"env-token",
	);
	assert.equal(githubToken({ env: {}, readCredential: () => undefined }), undefined);
});
