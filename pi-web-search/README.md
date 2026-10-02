# pi-web-search

**Web and public-code search for Pi: `web_search`, `code_search`, and opt-in `multi_search`.**

- **Keyless by default:** Exa, Parallel, and grep.app. Optional Jev filtering reuses your Pi login/key.
- You configure providers in settings; Agent only sees small, task-focused tools for minimal context bloat.
- Opt-in search across multiple sources, scoped to web, code, or both.
- Optional Jev ranking, filtering, and safety classification via TypeSafe, Vercel AI Gateway, or OpenRouter. Off by default.

## Installation

1. Install: `pi install npm:@gagansd/pi-web-search`
2. For optional keys and settings, run `/web-search-settings` for setup guidance.

> Keyless configs have limitations set by Exa and Parallel.


## Classifier API

Optional classification adds judgments to `multi_search`; ordinary `web_search` and `code_search` never run it.

- **Rank:** favor relevant, self-contained excerpts and penalize off-topic results.
- **Filter:** suppress confidently flagged prompt injection, phishing, or harmful content.
- **Check coverage:** judge whether the retrieved evidence is enough to answer the query.

### Architecture and model support

`Retrieval → Pi classifier API → ranking/filtering policy → cited results`

The classifier receives the query and candidate titles, URLs, and excerpts as state, plus typed boolean and choice questions. It returns probabilities; code applies weights and thresholds. Pi owns model authentication and execution, separate from the search connectors.

| Classifier | Support |
| --- | --- |
| **Jev** via TypeSafe, Vercel AI Gateway, or OpenRouter | Available now; reuses Pi authentication. |
| **Your own local classifier** via llama.cpp or a custom Pi provider | Pi supports it; selecting it in this extension is planned. |
| **OpenAI Decisions API** | Planned adapter; official API contract and access still need verification. Not available today. |

The provider-independent boundary makes other classifiers possible without rewriting retrieval or ranking. The current model selector supports TypeSafe, Vercel, and OpenRouter; see the [implementation plan](docs/classifier-plan.md) for lifting that restriction.

### Try Jev with your existing Pi login

For OpenRouter:

1. Run `/login openrouter` **only if Pi isn't already authenticated**.
2. Run `/web-search-settings openrouter`, then `/reload`.
3. Ask: “Use multi_search to search the web for AbortSignal.timeout.”

| Use | Setup command | Default model |
| --- | --- | --- |
| TypeSafe | `/web-search-settings typesafe` | `jev-latest` |
| Vercel AI Gateway | `/web-search-settings vercel` | `typesafe-ai/jev` |
| OpenRouter | `/web-search-settings openrouter` | `~typesafe/jev-latest` |

The command enables multi-source search and judgment in `web-search.json`, preserving your other settings. **No second API key is needed.** Pi reuses its stored, environment, runtime, or model authentication. If needed, use Pi's `/login vercel-ai-gateway` or `/login typesafe` for the other providers.

`/web-search-settings` shows status; `/web-search-settings off` disables judgment but keeps search enabled. Gateways require explicit selection: `auto` now uses TypeSafe only, with **no classifier provider fallback**. Hosted classification is billed to the selected account.

Classification is off by default. Failures keep retrieved evidence with warnings. Hosted classifiers receive excerpts before output clipping; safety judgments are not a security boundary. See [all settings and limits](docs/research.md).

## Tools and Examples

1. Use `web_search` for explanations and documentation
2. `code_search` for literal public-code patterns
3. Opt-in `multi_search` when you need retrieval from multiple sources

> The tool definitions register two tools by default and activate `multi_search` only when enabled.

| Tool | Inputs | Use |
| --- | --- | --- |
| `web_search` | Required `query`; optional `urls` | Public documentation, prose, current information; retrieve known-page excerpts alongside a search. |
| `code_search` | Required `query` | Literal identifiers or code snippets in public repositories. |
| `multi_search` | Required `query` and `scope` (`web`, `code`, or `both`) | Opt-in concurrent retrieval across available sources; optional judgment is configured separately. |

You can narrow searches to specific codebases using prompts like "check Meta's repos only", which your LLM translates to GitHub org/user-level filters:

```json
{ "query": "useSyncExternalStore repo:facebook/react" }
```

**Multi-source search**, after [enabling it](#optional-multi-source-search-and-jev) — `multi_search` arguments:

```json
{ "query": "AbortSignal.timeout", "scope": "both" }
```

Queries are required even when supplying URLs, are limited to 4,000 characters, and must not be blank after trimming. `web_search` accepts up to 20 URL strings; blanks are ignored and invalid/non-HTTP(S) URLs generate warnings. URL input requests remote extraction, not a full browser page or a URL-only fetch. Undeclared tool arguments such as `limit`, `provider`, or `path` are ignored and named in successful-result warnings; they do not configure a provider or filter.

### Code qualifiers

`repo:<owner/name>` and `language:<name>` are the documented common subset. On grep.app, these are extracted into filters; quote qualifier values containing spaces. The first nonempty `repo:` value is used, and repeated languages are deduplicated. **grep.app language filtering is unreliable** and always adds a warning when used; avoid it for a first search, and treat zero hits as inconclusive.

Other qualifiers are provider-dependent: grep.app leaves `path:`, `filename:`, and similar syntax in the literal pattern, while GitHub receives the original query unchanged and interprets its own syntax. A zero-hit warning suggests possible remedies, not a confirmed cause or proof that code does not exist.

## Full Configuration

Ask your agent to set up the keys for you.

Alternatively:

To change providers or enable research, use `<agent-dir>/web-search.json`, normally `~/.pi/agent/web-search.json`. `PI_WEB_SEARCH_CONFIG` overrides that file path; `PI_CODING_AGENT_DIR` changes Pi's agent directory. There is no automatic project `.pi/web-search.json` lookup or merge with Pi's `settings.json`. A project-local package install does not make this config project-local.

A missing config file uses these retrieval defaults:

```json
{
  "web": { "provider": "exa", "fallback": ["parallel"] },
  "code": { "provider": "grep", "fallback": ["github"] },
  "research": { "enabled": false },
  "timeoutMs": 20000,
  "maxResults": 8
}
```

All fields are optional; the [configuration resolver](src/providers/config.ts) defines the defaults and accepted fields. Merge changes into your existing file instead of replacing it. Config is read each operation; changing research tool exposure also requires `/reload`.

- `web` accepts `exa` and `parallel`; `code` accepts `grep` and `github`.
- `maxResults` is truncated to an integer and clamped to **1–20**. It is a per-provider search setting, not a cap on merged research hits; URL excerpts are additional entries. Upstreams may return fewer hits or not honor a requested limit.
- `timeoutMs` is truncated to integer milliseconds. Positive values have a **1,000 ms minimum**; nonpositive values use **20,000 ms**. See [deadline behavior](#timeouts-fallback-and-errors), not a whole-call latency guarantee.
- Malformed JSON, unsupported field/provider names, and malformed major blocks produce `invalid_config`. Wrong-family provider selections are ignored/defaulted with search warnings. Some known Jev values also default with warnings; `jev.enabled` activates only for literal `true`. Numeric normalization above does not itself emit a warning.

### Optional multi-source search and Jev

To expose `multi_search`, merge this into the config path printed by `/web-search-settings`, then `/reload`:

```json
{ "research": { "enabled": true } }
```

Research sends the same query to all eligible sources in the chosen scope, concurrently. It is not an autonomous research agent, agreement checker, or automatic follow-up search. It merges successful responses while the operation deadline remains live. Ordinary web/code searches do not run Jev.

For optional ranking and safety classification, choose a provider with `/web-search-settings typesafe`, `vercel`, or `openrouter`. Pi handles authentication; anonymous search does not depend on classifier credentials. See [settings and limits](docs/research.md).

## Credentials

### Which providers need an API key?

Default Exa web search, native Parallel MCP web fallback, and grep.app code search need no search-provider key. Parallel anonymous access has lower server-controlled rate limits; an already configured key is optional for higher limits. An Exa key selects REST instead of keyless MCP; GitHub requires a token. Jev is independently opt-in and uses Pi classifier authentication. Additional providers do not guarantee more results or availability.

For search credentials, the first nonblank environment alias overrides the stored key in `<agent-dir>/auth.json`. Classifier credentials are resolved exclusively by Pi—no extension key store or separate Jev key.

| Stored ID | Environment aliases, in precedence order | Enables |
| --- | --- | --- |
| `exa` | `EXA_API_KEY` | Exa REST instead of keyless MCP. |
| `parallel` | `PARALLEL_API_KEY` | Optional Bearer header for Parallel native MCP (anonymous without it). |
| `github` | `GITHUB_TOKEN`, `GH_TOKEN` | Authenticated GitHub search; only verified public results are returned. |

Set environment variables **before starting Pi**. A new export in another shell cannot change a running Pi process; restart Pi with that environment. Exa/GitHub stored keys are read each operation; the Parallel Bearer header is captured when its MCP server is registered, so changing its key requires `/reload`. Pi, not this package, resolves classifier credentials at judgment time.

To store a key, merge an entry of this form into Pi's existing `auth.json` (replace the placeholder privately; do not replace other credentials):

```json
{ "parallel": { "type": "api_key", "key": "<your-api-key>" } }
```

For retrieval keys, this extension reads literal `.key` strings; it does not resolve shell commands, environment references inside those strings, or OAuth refresh credentials. Pi owns classifier credential resolution, including its other supported auth sources. Unreadable/malformed retrieval auth is treated as no stored key. This extension does not write credentials. Keep auth files out of version control and use narrowly scoped keys/tokens. Additional sources have their own quotas and billing; no price or quota increase is promised here.

`/web-search-settings` reports Pi's classifier authentication snapshot, not a live key-validity test. It never displays keys. Queries, URLs, errors, and excerpts can still contain sensitive text; see [data handling](#data-handling).

## Provider behavior and limits

- Web: **Exa → Parallel**. Code: **grep.app → GitHub** (token required).
- Only retryable failures trigger fallback; empty results do not.
- Research queries all eligible sources in scope. `fallback: []` does not exclude providers.
- Results include source links and compact excerpts, not full pages. Scripts receive [structured output](src/format.ts).

## Timeouts, fallback, and errors

- Default operation budget: **20 seconds**, shared by retrieval and judgment; cleanup can take longer.
- Check warnings and `/web-search-settings`; use `/mcp` for Parallel connection issues.
- Jev failures return unjudged evidence with warnings. Retrieval timeout or cancellation fails the call.

## Data handling

- Queries and URLs go to external providers. Optional Jev also receives candidate titles, URLs, and provider excerpts before output clipping. **Do not send secrets or private code.**
- Retrieved content is untrusted. Jev is not a prompt-injection firewall or truth guarantee.
- The extension does not send workspace files or session history as search payloads; tool calls can still appear in Pi's session history.

## Development and package checks

```bash
cd pi-web-search
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run typecheck
npm run pack:check
```

SDK users must load Pi's MCP and codemode extensions and call `bindExtensions()`; see the [SDK example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/14-codemode-mcp.ts).

## License

[MIT](LICENSE) - Gagan Devagiri
