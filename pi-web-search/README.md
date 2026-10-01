# pi-web-search

A `web_search` tool for the [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent). It calls search APIs directly, so it works with every model and returns documents with citations instead of a model's paraphrase.

Two modes, one tool:

- **simple** (default) — Exa, with Parallel as a fallback. No key required. Use this most of the time.
- **parallel** — Exa, Parallel, grep.app and GitHub run together. Failures become warnings. Optional Jev ranking, safety filter and sufficiency check.

## Install

```bash
pi install npm:@gagansd/pi-web-search
```

Or from a checkout, add it to `settings.json`:

```jsonc
{ "packages": ["../../GitHub/pi-extensions/pi-web-search"] }
```

## No key required

**Exa works with no API key** via `https://mcp.exa.ai/mcp`. grep.app is also keyless. Parallel needs `PARALLEL_API_KEY`. GitHub needs `GITHUB_TOKEN` or `GH_TOKEN`.

```bash
export EXA_API_KEY=...          # optional; switches Exa to REST
export PARALLEL_API_KEY=...     # optional; enables Parallel
export GITHUB_TOKEN=...         # optional; enables GitHub code search
export TYPESAFE_API_KEY=...     # optional; native Jev
export AI_GATEWAY_API_KEY=...   # optional; Jev via Vercel AI Gateway
```

Jev also reads Pi's `auth.json` (`typesafe` or `vercel-ai-gateway`) when the tool runs inside Pi. Native TypeSafe wins if both keys exist. A pinned native model id is remapped on the Vercel backend.

## Configuration

Optional, at `~/.pi/agent/web-search.json`. A leftover third-party file (`provider: "openai"`) is ignored, not fatal.

```jsonc
{
  "mode": "simple",            // or "parallel"
  "provider": "exa",
  "fallback": ["parallel"],
  "timeoutMs": 20000,
  "maxResults": 8,
  // "family": "web",          // pin "web" or "code"; skips Jev routing
  "jev": {
    "enabled": false,
    "backend": "auto",         // auto | typesafe | vercel
    "model": "jev-1.13.0"
  }
}
```

Set `PI_WEB_SEARCH_CONFIG` to point somewhere else.

`simple` stays in one family and walks `provider` then `fallback`. `parallel` fans out every available source (or the pinned family) and merges what comes back. Jev never appears in the provider chain — it only judges results.

## The tool

```jsonc
{
  "query": "What changed in the Node.js release policy in 2026?",
  "urls": ["https://example.com/spec"]   // optional, up to 20
}
```

`urls` are fetched alongside search results. A failed fetch is a warning, never a lost search.

## Cost

| Source | Search | Notes |
| --- | --- | --- |
| Exa (keyless MCP) | Free | No key, no account |
| Exa (REST) | Exa's published rates | Used when `EXA_API_KEY` is set |
| Parallel | $1 / 1,000 | `fast` mode |
| grep.app | Free | Keyless MCP |
| GitHub | GitHub's code-search limits | Needs a token; 10 req/min |
| Jev | TypeSafe / Vercel rates | One batched call per search when enabled |

## Development

```bash
npm install
npm test
npm run typecheck
```

The suite is hermetic — every transport is tested through an injected `fetch`. `SPEC.md` is the implementation contract.

## License

MIT
