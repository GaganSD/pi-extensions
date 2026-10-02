# pi-web-search

Web and public-code search for Pi.

## Install

```
pi install npm:@gagansd/pi-web-search
```

The first interactive session shows a one-time setup prompt. `/web-search-settings` anytime.

## Tools

| Tool | Input | Use |
| --- | --- | --- |
| `web_search` | `query`, optional `urls` | Docs, prose, current events. Pass URLs to extract excerpts. |
| `code_search` | `query` | Literal identifiers or snippets. Qualifiers: `repo:owner/name`, `language:Name`. |
| `multi_search` | `query`, `scope` (`web` \| `code` \| `both`) | Opt-in multi-source search. Off until enabled. |

`read` does not open URLs. Use `web_search` with `urls`.

## Defaults

| Family | Chain |
| --- | --- |
| Web | Exa → Parallel (both keyless) |
| Code | grep.app → Sourcegraph (both keyless) → GitHub if a token exists |

GitHub code search is not keyless. A token comes from `GITHUB_TOKEN`, `GH_TOKEN`, `auth.json` `github`, or `gh auth login`.

Jev ranking is off. Ordinary `web_search` / `code_search` never run it.

## Optional setup

| Want | Do |
| --- | --- |
| Higher Exa quota | `EXA_API_KEY` or `auth.json` `exa` |
| Higher Parallel limits | `PARALLEL_API_KEY` or `auth.json` `parallel` |
| GitHub code search | token or `gh auth login` |
| `multi_search` + Jev | `/web-search-settings typesafe` \| `vercel` \| `openrouter`, then `/reload` |
| Jev off | `/web-search-settings off` |

Set env vars before starting Pi. Keys are never printed.

## Config

`~/.pi/agent/web-search.json` (override with `PI_WEB_SEARCH_CONFIG`):

```json
{
  "web": { "provider": "exa", "fallback": ["parallel"] },
  "code": { "provider": "grep", "fallback": ["sourcegraph", "github"] },
  "research": { "enabled": false },
  "timeoutMs": 20000,
  "maxResults": 8
}
```

`code` providers: `grep`, `sourcegraph`, `github`. `web`: `exa`, `parallel`. `/reload` after changing `research.enabled`.

## Code search notes

- Query is a **literal** pattern, not a sentence.
- grep.app and public Sourcegraph do not index every GitHub repo. `repo:facebook/react` often misses; try without `repo:` or a mirror such as `repo:react/react`.
- Empty grep/Sourcegraph results continue to the next code source. GitHub still needs a token.
- `language:` on grep.app is unreliable.

## Limits

Query max 4,000 characters. `maxResults` 1–20. Shared deadline 20s. Markdown excerpts are short; follow citation URLs.

Jev settings: [docs/research.md](docs/research.md).
