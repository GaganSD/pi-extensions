import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const httpUrl = new URL("../src/providers/http.ts", import.meta.url).href;
const augmentUrl = new URL("../src/jev/augment.ts", import.meta.url).href;

// Allow slow child startup under CPU contention. Fixture deadlines must outlive
// the guard, so a leaked timer still fails rather than expiring before exit.
const ISOLATED_PROCESS_GUARD_MS = 30_000;
const CLEANUP_FIXTURE_DEADLINE_MS = 120_000;
assert.ok(CLEANUP_FIXTURE_DEADLINE_MS > ISOLATED_PROCESS_GUARD_MS, "cleanup fixture deadline must exceed the subprocess guard");

/** No test-runner handles or artificial keepalive may sustain the child's deadline. */
function runIsolated(source: string): void {
	const child = spawnSync(process.execPath, [
		"--experimental-strip-types", "--input-type=module", "--eval",
		`
			import assert from "node:assert/strict";
			import { getEventListeners } from "node:events";
			import { postJson, withTimeout } from ${JSON.stringify(httpUrl)};
			${source}
			console.log("completed");
		`,
	], { encoding: "utf8", timeout: ISOLATED_PROCESS_GUARD_MS });
	assert.ifError(child.error);
	assert.equal(child.status, 0, child.stderr);
	assert.equal(child.stdout.trim(), "completed", child.stderr);
}

test("postJson deadline keeps an otherwise idle pending fetch alive", () => {
	runIsolated(`
		await assert.rejects(postJson("https://offline.test", {
			body: {}, timeoutMs: 20, fetchImpl: async () => new Promise(() => {}),
		}), (error) => error.code === "timeout");
	`);
});

test("postJson deadline keeps an otherwise idle pending body reader alive", () => {
	runIsolated(`
		await assert.rejects(postJson("https://offline.test", {
			body: {}, timeoutMs: 20,
			fetchImpl: async () => ({
				ok: true, status: 200, headers: new Headers(),
				text: async () => new Promise(() => {}),
			}),
		}), (error) => error.code === "timeout");
	`);
});

test("withTimeout disposal releases its timer and caller abort listener", () => {
	runIsolated(`
		const caller = new AbortController();
		const deadline = withTimeout(caller.signal, ${CLEANUP_FIXTURE_DEADLINE_MS});
		assert.equal(getEventListeners(caller.signal, "abort").length, 1);
		deadline.dispose();
		deadline.dispose();
		assert.equal(getEventListeners(caller.signal, "abort").length, 0);
		caller.abort();
		assert.equal(deadline.signal.aborted, false);
	`);
});

test("postJson success releases its deadline and caller abort listener", () => {
	runIsolated(`
		const caller = new AbortController();
		const result = await postJson("https://offline.test", {
			body: {}, signal: caller.signal, timeoutMs: ${CLEANUP_FIXTURE_DEADLINE_MS},
			fetchImpl: async () => new Response('{"ok":true}'),
		});
		assert.deepEqual(result, { ok: true });
		assert.equal(getEventListeners(caller.signal, "abort").length, 0);
	`);
});

test("postJson caller cancellation releases its deadline and abort listener", () => {
	runIsolated(`
		const caller = new AbortController();
		await assert.rejects(postJson("https://offline.test", {
			body: {}, signal: caller.signal, timeoutMs: ${CLEANUP_FIXTURE_DEADLINE_MS},
			fetchImpl: async () => {
				caller.abort();
				return new Promise(() => {});
			},
		}), (error) => error.code === "aborted");
		assert.equal(getEventListeners(caller.signal, "abort").length, 0);
	`);
});

test("optional judging survives an otherwise idle operation deadline with its evidence", () => {
	runIsolated(`
		const { augmentResults } = await import(${JSON.stringify(augmentUrl)});
		const deadline = withTimeout(undefined, 20);
		const input = {
			text: "", providerKind: "exa",
			searchResults: [{ title: "Evidence", url: "https://offline.test", citedText: "Retrieved evidence" }],
			sources: [{ title: "Evidence", url: "https://offline.test" }],
		};
		try {
			const result = await augmentResults({
				query: "q", signal: deadline.signal,
				settings: { jev: { enabled: true, provider: "typesafe", model: "jev-latest", maxStateChars: 20000 } },
			}, input, {
				timeoutMs: ${CLEANUP_FIXTURE_DEADLINE_MS},
				modelRegistry: {
					findOfType: () => ({ provider: "typesafe", id: "jev-latest" }),
					getAvailableOfType: async () => [{ provider: "typesafe", id: "jev-latest" }],
					classify: async () => new Promise(() => {}),
				},
			});
			assert.deepEqual(result.searchResults, input.searchResults);
			assert.deepEqual(result.sources, input.sources);
			assert.equal(result.jevStatus, "unavailable");
			assert.match(result.warnings.join(" "), /operation timeout/);
		} finally { deadline.dispose(); }
	`);
});
