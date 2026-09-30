import assert from "node:assert/strict";
import test from "node:test";

import {
	EXCERPT_MAX_CHARS,
	RESULTS_HEADING,
	SOURCES_HEADING,
	WARNINGS_HEADING,
	formatResult,
	formatWebSearchResult,
} from "../src/format.ts";
import type { StreamResult } from "../src/providers/types.ts";

function textOf(result: { content: { type: string; text?: string }[] }): string {
	const part = result.content[0];
	return part?.type === "text" ? (part.text ?? "") : "";
}

test("sources section is a numbered markdown link list", () => {
	const result: StreamResult = {
		text: "",
		providerKind: "exa",
		sources: [
			{ title: "Exa", url: "https://exa.ai" },
			{ title: "Parallel", url: "https://parallel.ai" },
		],
	};

	assert.equal(
		textOf(formatWebSearchResult(result)),
		`${SOURCES_HEADING}\n\n1. [Exa](https://exa.ai)\n2. [Parallel](https://parallel.ai)`,
	);
});

test("results section lists each result with a blockquoted excerpt", () => {
	const result: StreamResult = {
		text: "",
		providerKind: "parallel",
		searchResults: [
			{
				title: "First",
				url: "https://example.com/1",
				citedText: "an\nexcerpt  with   spaces",
			},
			{ title: "Second", url: "https://example.com/2" },
		],
	};

	assert.equal(
		textOf(formatWebSearchResult(result)),
		[
			RESULTS_HEADING,
			"",
			"1. [First](https://example.com/1)",
			"> an excerpt with spaces",
			"",
			"2. [Second](https://example.com/2)",
		].join("\n"),
	);
});

test("excerpts are capped at 400 characters with whitespace collapsed", () => {
	const citedText = `${"word ".repeat(200)}\n\ttail`;
	const result: StreamResult = {
		text: "",
		providerKind: "exa",
		searchResults: [{ title: "Long", url: "https://example.com", citedText }],
	};

	const lines = textOf(formatWebSearchResult(result)).split("\n");
	const quote = lines.find((line) => line.startsWith("> "));
	assert.ok(quote !== undefined);
	const excerpt = quote.slice(2);

	assert.equal(excerpt.length, EXCERPT_MAX_CHARS);
	assert.equal(excerpt, citedText.replace(/\s+/g, " ").trim().slice(0, EXCERPT_MAX_CHARS));
	assert.equal(excerpt.includes("\n"), false);
});

test("an empty excerpt never produces a bare blockquote line", () => {
	const result: StreamResult = {
		text: "",
		providerKind: "exa",
		searchResults: [{ title: "Blank", url: "https://example.com", citedText: " \n\t " }],
	};

	assert.equal(
		textOf(formatWebSearchResult(result)),
		`${RESULTS_HEADING}\n\n1. [Blank](https://example.com)`,
	);
});

test("a result with no title or url still gets a numbered entry", () => {
	const result: StreamResult = {
		text: "",
		providerKind: "exa",
		searchResults: [{}],
	};

	assert.equal(textOf(formatWebSearchResult(result)), `${RESULTS_HEADING}\n\n1. Result 1`);
});

test("empty text with zero results emits no orphan header", () => {
	const result: StreamResult = { text: "", providerKind: "exa" };

	const text = textOf(formatWebSearchResult(result));

	assert.equal(text, "");
	assert.equal(text.includes("##"), false);
});

test("warnings section appears only when warnings are present", () => {
	const withWarnings: StreamResult = {
		text: "",
		providerKind: "parallel",
		warnings: ["budget capped", "two queries merged"],
	};
	assert.equal(
		textOf(formatWebSearchResult(withWarnings)),
		`${WARNINGS_HEADING}\n\n- budget capped\n- two queries merged`,
	);

	const withoutWarnings: StreamResult = {
		text: "",
		providerKind: "parallel",
		warnings: [],
	};
	assert.equal(textOf(formatWebSearchResult(withoutWarnings)), "");
});

test("sections are ordered text, results, sources, warnings", () => {
	const result: StreamResult = {
		text: "summary line",
		providerKind: "parallel",
		requestId: "search_1",
		searchResults: [{ title: "A", url: "https://a.example", citedText: "hit" }],
		sources: [{ title: "A", url: "https://a.example" }],
		warnings: ["trimmed"],
	};

	const text = textOf(formatWebSearchResult(result));
	const order = [text.indexOf("summary line"), text.indexOf(RESULTS_HEADING), text.indexOf(SOURCES_HEADING), text.indexOf(WARNINGS_HEADING)];

	assert.deepEqual(order, [...order].sort((a, b) => a - b));
	assert.equal(order.every((index) => index >= 0), true);
});

test("details carry the full result key set", () => {
	const result: StreamResult = {
		text: "",
		providerKind: "exa",
		requestId: "req_1",
		searchResults: [{ title: "A", url: "https://a.example" }],
		sources: [{ title: "A", url: "https://a.example" }],
		warnings: [],
	};

	const { details } = formatWebSearchResult(result);

	assert.equal(details.provider, "exa");
	assert.equal(details.requestId, "req_1");
	assert.equal(details.resultCount, 1);
	assert.deepEqual(details.sources, [{ title: "A", url: "https://a.example" }]);
	assert.equal(details.searchResults?.length, 1);
	assert.deepEqual(details.warnings, []);
	assert.equal(details.grounded, true);
	assert.equal("error" in details, false);
});

test("grounded is false without sources and resultCount is zero without any results", () => {
	const { details } = formatWebSearchResult({ text: "", providerKind: "exa" });

	assert.equal(details.grounded, false);
	assert.equal(details.resultCount, 0);
});

test("formatResult marks truncated output", () => {
	const long = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");

	assert.equal(textOf(formatResult(long, {}, { maxLines: 3 })), "line 0\nline 1\nline 2\n\n[Truncated]");
	assert.equal(textOf(formatResult("short", {})), "short");
});
