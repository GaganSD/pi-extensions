# pi-web-search

**Search the web and public code from Pi, with citations.** One extension,
three tools, keyless by default.

`pi-web-search` gives your agent real search: documentation lookups, current
events, and literal code in public repositories. Every result comes back
cited, so the model can show its work instead of guessing.

- **Works immediately.** No API key needed for web search or code search.
- **No vendor lock-in.** Providers, fallbacks, and ranking stay internal. The
  model never picks a vendor, and a dead provider falls back on its own.
- **Works with any model.** Plain tool calls, no vendor-specific parameters.
- **Zero runtime dependencies.** Providers are reached with the built-in
  `fetch`.

## Install

```bash
pi install npm:@gagansd/pi-web-search
```

Requires Pi `>= 0.99.0` and Node `>= 22.19.0`. That is the whole setup — ask
your agent a question and it will search.

Check what resolved at any time:

```
/web-search-settings
```

This prints the config path, which credentials are present (never their
values), and whether optional features are on. It makes no network calls.

## What your agent gets

| Tool | When it shows up | What it does |
| --- | --- | --- |
| `web_search` | always | Documentation, prose, and current events. Can also fetch specific pages you name. |
| `code_search` | always | Literal identifiers and code snippets in public repositories. |
| `research_search` | opt-in | Cross-checks a query across web and/or code with extra ranking. Slower; enable when you want it. |

All three return cited results, a coverage line naming which providers
answered, and any warnings.

### Examples

Ask your agent things like:

- "What's the current stable version of Node and when did it ship?"
- "Find how `useSyncExternalStore` is used in the React repo."
- "Read https://nodejs.org/api/timers.html and explain `setImmediate`."
- "Is `Array.prototype.toSorted` safe for production browsers yet?"

The model picks the right tool. When you want to see the raw call, tools
look like this:

```jsonc
// web_search — search, optionally fetching pages you already know
{ "query": "Node.js AbortSignal timeout", "urls": ["https://nodejs.org/api/globals.html"] }

// code_search — a literal pattern; repo:/language: narrow it
{ "query": "useState( repo:facebook/react language:javascript" }

// research_search — cross-source check (when enabled)
{ "query": "AbortSignal.timeout", "scope": "both" }
```

## Keys

Web search and code search work with **no key at all**. Keys only raise rate
limits or unlock extra providers.

| Credential | Env var | Unlocks |
| --- | --- | --- |
| `exa` | `EXA_API_KEY` | Keyed Exa. Keyless Exa works without it. |
| `parallel` | `PARALLEL_API_KEY` | Parallel web search and page extraction. |
| `github` | `GITHUB_TOKEN` / `GH_TOKEN` | GitHub code search (public repos). |
| `typesafe` | `TYPESAFE_API_KEY` | Ranking (Jev) via Typesafe. |
| `vercel-ai-gateway` | `AI_GATEWAY_API_KEY` | Ranking (Jev) via the Vercel AI Gateway. |

Secrets live in Pi's `auth.json` (usually `~/.pi/agent/auth.json`); environment
variables override it. Only the *presence* of a key is ever reported — a value
is never printed. Rotating or removing a key takes effect on the next search,
with no reload.

## Configuration

Settings live in `web-search.json` in your agent directory (override the path
with `PI_WEB_SEARCH_CONFIG`). Everything is optional; the defaults are chosen
to work.

```json
{
  "web": { "provider": "exa", "fallback": ["parallel"] },
  "code": { "provider": "grep", "fallback": ["github"] },
  "research": { "enabled": false },
  "timeoutMs": 20000,
  "maxResults": 8
}
```

- `research.enabled: true` is the only way to turn on `research_search`. After
  changing it, run `/reload` — tool exposure is fixed at load time. Changing
  keys never needs a reload.
- `timeoutMs` is one end-to-end budget for the whole call, not per request.
- Unknown or misspelled settings fail loudly instead of being ignored, so a
  typo cannot quietly change behavior.

### Code search qualifiers

`code_search` takes one `query`. It understands:

- `repo:<owner/name>` — restrict to a repository
- `language:<name>` — restrict to a language (quote values with spaces)

These are real filters. Everything else (`path:`, `filename:`, `site:`) is
treated as part of the search text and will not filter. A zero-result search
says why: an unindexed repository or an over-long pattern.

## When something goes wrong

- **`... failed (missing_credentials)`** — that provider family needs a key.
  The message names the variable to set; no reload needed.
- **`... failed (invalid_config)`** — names the settings file and the problem.
- **`research_search` is missing** — it only appears when `research.enabled` is
  true. Set it and run `/reload`.
- **A search timed out** — raise `timeoutMs`.
- **Another extension also provides `web_search`/`code_search`** — remove it so
  the model sees one definition, then `/reload`.

## Design notes

The extension is deliberately small, and that is a maintained property:

- Three tools, one parameter each (plus `urls`/`scope` where they earn their
  place). An undeclared parameter is ignored and named in the result warnings,
  so a model never believes a filter ran that did not — and a stray key costs
  no failed call.
- Providers, credentials, fallback, and optional ranking are internal. The
  agent never selects a vendor.
- Results are cited Markdown for models, and the same data as structured
  fields for scripts. Failures return structured errors instead of throwing
  away partial results.
- No compatibility shims, no config migrations: unsupported settings fail
  loudly by design.

## Observability

All tools live in the `search` namespace, declare read-only/open-world
annotations, and expose an output schema. Codemode callers get structured
results — status, citations, coverage, warnings — instead of parsing prose.
Failures set `isError` and still return their data.

## License

MIT
