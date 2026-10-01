# pi-web-search

Search tools for the [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent). Calls search APIs directly, so it works with every model and returns cited documents.

## Tools

| Tool | Default? | What it does |
| --- | --- | --- |
| `web_search` | yes | Web pages and docs. Exa, Parallel fallback. Optional `urls`. |
| `code_search` | yes | Public source. grep.app, GitHub fallback. Query only. |
| `research_search` | only if `research.enabled` | Parallel retrieval in an explicit `scope`: `web`, `code`, or `both`. Optional Jev ranking. |

The agent never picks a vendor. Providers, keys, fallback and Jev stay internal.

## Install

```bash
pi install npm:@gagansd/pi-web-search
```

## Keys

**Exa and grep.app work with no key.** Parallel needs `PARALLEL_API_KEY`. GitHub needs `GITHUB_TOKEN` or `GH_TOKEN`.

Jev (research only): `TYPESAFE_API_KEY` / `JEV_API_KEY`, or `AI_GATEWAY_API_KEY`, or Pi `auth.json` (`typesafe`, `vercel-ai-gateway`). Parallel can also live in `auth.json` as `parallel`.

## Configuration

`~/.pi/agent/web-search.json`. Leftover `{ "provider": "openai" }` is ignored, not fatal.

```jsonc
{
  "web": { "provider": "exa", "fallback": ["parallel"] },
  "code": { "provider": "grep", "fallback": ["github"] },
  "research": { "enabled": false },
  "timeoutMs": 20000,
  "maxResults": 8,
  "jev": { "enabled": false, "backend": "auto" }
}
```

Legacy `mode: "parallel"` turns on `research_search`. Ordinary `web_search` never fans out and never calls Jev.

## Development

```bash
npm test
npm run typecheck
```

## License

MIT
