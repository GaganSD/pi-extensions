import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

// Offline stdio MCP fixture. Pi's built-in MCP extension, not this package, owns its lifecycle.
const log = process.argv[2];
const tools = ["web_search", "web_fetch"].map((name) => ({ name, inputSchema: { type: "object", additionalProperties: true } }));
for await (const line of createInterface({ input: process.stdin })) {
	const request = JSON.parse(line);
	if (request.id === undefined) continue;
	let result;
	switch (request.method) {
		case "initialize":
			result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "parallel-offline-fixture", version: "1" } };
			break;
		case "tools/list": result = { tools }; break;
		case "tools/call": {
			const { name, arguments: args } = request.params;
			appendFileSync(log, `${JSON.stringify({ name, args })}\n`);
			const payload = name === "web_search"
				? { search_id: "fixture-search", results: [{ url: "https://example.test/result", title: "Result", excerpts: ["Search citation"] }] }
				: { results: [{ url: args.urls[0], title: "Extract", excerpts: ["Fetched citation"] }] };
			result = { content: [{ type: "text", text: JSON.stringify(payload) }] };
			break;
		}
		default: process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } })}\n`); continue;
	}
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
}
