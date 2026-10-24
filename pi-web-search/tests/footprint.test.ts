import assert from "node:assert/strict";
import test from "node:test";
import { measureFootprint } from "../scripts/footprint.ts";

test("host-built declarations and result payloads stay within context budgets", async () => {
	const prior = globalThis.fetch;
	globalThis.fetch = async () => { throw new Error("Footprint measurement must be offline"); };
	try {
		const sample = await measureFootprint();
		assert.deepEqual(sample.modes.default.tools, ["web_search", "code_search"]);
		assert.deepEqual(sample.modes.research.tools, ["web_search", "code_search", "multi_search"]);
		assert.ok(sample.modes.default.estimatedTokens <= 460, JSON.stringify(sample.modes.default));
		assert.ok(sample.modes.research.estimatedTokens <= 670, JSON.stringify(sample.modes.research));
		assert.ok(sample.modes.default.continuationSchemaChars <= 600);
		assert.equal(sample.result.previewCount, 8);
		assert.ok(sample.result.directChars <= 4500);
		assert.ok(sample.result.structuredChars <= 18_000);
	} finally { globalThis.fetch = prior; }
});
