# pi-web-search

A `web_search` tool for the [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent) harness, backed by **Exa** and **Parallel** search APIs.

This is a self-hosted replacement for the third-party `pi-web-search` package. The original routes search through a chat model that has native web search, so you pay model prices for a lookup and your results depend on which model you happen to be using. This one calls a search API directly: a search costs a fraction of a model call, works with every model, and returns documents with citations instead of a model's paraphrase of them.

It is also much smaller. One tool, two providers, no native-search adapters for five LLM vendors.

## Install

```bash
pi install npm:@gagansd/pi-web-search
```

Or from a checkout, add it to your `settings.json`:

```jsonc
{ "packages": ["../../GitHub/pi-extensions/pi-web-search"] }
```

## No key required

**Exa works with no API key.** The extension uses Exa's hosted MCP endpoint at `https://mcp.exa.ai/mcp`, which is open. Install it and search.

Exa's REST API is used automatically instead when `EXA_API_KEY` is set — same results, more control, and no rate limit shared with other MCP clients.

```bash
# Optional. Enables the REST path and the Parallel fallback.
export EXA_API_KEY=...
export PARALLEL_API_KEY=...
```

## Configuration

Optional, at `~/.pi/agent/web-search.json`. Every key has a default; the file is not required.

```jsonc
{
  // "exa" (default) or "parallel"
  "provider": "exa",

  // Tried in order when the primary provider fails with a retryable error.
  // Parallel is skipped silently when PARALLEL_API_KEY is unset.
  "fallback": ["parallel"],

  "timeoutMs": 20000,
  "maxResults": 8
}
```

Set `PI_WEB_SEARCH_CONFIG` to point somewhere else.

Exa is the default because it is the one that works without a key. Parallel is the fallback: when you have a key, a Parallel outage or rate limit does not take search down with it.

## The tool

```jsonc
{
  "query": "What changed in the Node.js release policy in 2026?",
  "urls": ["https://example.com/spec"]   // optional, up to 20
}
```

`urls` are fetched and returned alongside the search results, using Exa's `/contents` API or its `web_fetch_exa` MCP tool, or Parallel's `/v1/extract`. A failed fetch never discards your search results — it is reported as a warning.

Results are returned as a `## Results` section of titled, linked excerpts, plus a `## Sources` list for attribution. Structured detail lands in the tool result's `details` field, so an agent can inspect `resultCount`, `requestId`, and the raw results without re-parsing the text.

## Why there is no `url_context` tool

The original package also shipped a `url_context` tool, backed by Google Gemini URL Context. It is not here, on purpose:

- Both providers already fetch URLs, so `urls` on `web_search` covers the same ground.
- A second tool means a second schema in every request, forever, for a capability the first tool already has.
- The original was Gemini-only and silently disappeared from the tool list on any non-Gemini model. That behavior is not something worth reproducing.

URL fetching stays a separate call from search inside the provider layer, so a dedicated URL-only tool can be added later without reworking the search path.

## Cost

| Provider | Search | Notes |
| --- | --- | --- |
| Exa (keyless MCP) | Free | Hosted MCP endpoint, no key, no account |
| Exa (REST, with key) | Exa's published rates | Better rate limits, `highlights` control |
| Parallel | $1 / 1,000 searches | `fast` mode, ~700ms. `basic` is $5 / 1,000 |

## Development

```bash
npm install
npm test        # node --test --experimental-strip-types, fully offline
npm run typecheck
```

The whole suite is hermetic — every transport is tested through an injected `fetch`, so no test touches the network and none of them need a key. `SPEC.md` is the implementation contract the code was built against.

## License

MIT
