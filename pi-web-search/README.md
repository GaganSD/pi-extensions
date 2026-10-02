# pi-web-search

**Web and public-code search for Pi: `web_search`, `code_search`, and opt-in `multi_search`.**

- **Keyless by default:** Exa, Parallel, grep.app, and Sourcegraph. Optional Jev filtering reuses your Pi login/key.
- You configure providers in settings; Agent only sees small, task-focused tools for minimal context bloat.
- Opt-in search across multiple sources, scoped to web, code, or both.
- Optional Jev ranking, filtering, and safety classification via TypeSafe, Vercel AI Gateway, or OpenRouter. Off by default.

## Installation

Requires Pi **0.99.0 or newer** and Node.js **22.19.0 or newer**.

1. Install: `pi install npm:@gagansd/pi-web-search`
2. The first interactive session shows a one-time setup prompt for existing Exa, GitHub, and Parallel credentials. For optional keys and settings anytime, run `/web-search-settings`.

> Keyless configs have limitations set by Exa and Parallel.


## Classifier API

Optional classification adds judgments to `multi_search`; ordinary `web_search` and `code_search` never run it.

- **Rank:** favor relevant, self-contained excerpts and penalize off-topic results.
- **Filter:** suppress confidently flagged prompt injection, phishing, or harmful content.
- **Check coverage:** judge whether the retrieved evidence is enough to answer the query.

### Architecture and model support

`Retrieval → Pi classifier API → ranking/filtering policy → cited results`

The classifier receives the query and candidate titles, URLs, and excerpts as state, plus typed boolean and choice questions. It returns probabilities; code applies weights and thresholds. Pi owns the catalog, authentication, and `classify()`. This package pins one exact `provider`/`model`.

| Classifier | Support |
| --- | --- |
| **Jev** via TypeSafe, Vercel AI Gateway, or OpenRouter | Available now; reuses Pi authentication. |
| **Any Pi classifier** including llama.cpp | Pin its exact `provider`/`model`. |
| **OpenAI Decisions API** | Planned adapter; official API contract and access still need verification. Not available today. |

The provider-independent boundary makes other classifiers possible without rewriting retrieval or ranking. Pin any registered Pi classifier with `/web-search-settings provider/model`.

### Try Jev with your existing Pi login

For OpenRouter:

1. Run `/login openrouter` **only if Pi isn't already authenticated**.
2. Run `/web-search-settings openrouter/~typesafe/jev-latest`.
3. Run `/reload`.
4. Ask: “Use multi_search to search the web for AbortSignal.timeout.”

| Use | Setup command | Default model |
| --- | --- | --- |
| TypeSafe | `/web-search-settings typesafe/jev-latest` | `jev-latest` |
| Vercel AI Gateway | `/web-search-settings vercel-ai-gateway/typesafe-ai/jev` | `typesafe-ai/jev` |
| OpenRouter | `/web-search-settings openrouter/~typesafe/jev-latest` | `~typesafe/jev-latest` |

The command enables multi-source search and judgment in `web-search.json`, preserving your other settings. **No second API key is needed.** Pi reuses its stored, environment, runtime, or model authentication. If needed, use Pi's `/login vercel-ai-gateway` or `/login typesafe` for the other providers.

`/web-search-settings` shows status; `/web-search-settings off` disables judgment but keeps search enabled. There is no gateway ladder or default classifier. Hosted classification is billed to the pinned account.

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

`repo:<owner/name>` and `language:<name>` are the documented common subset. On grep.app and Sourcegraph, these are extracted into filters; quote qualifier values containing spaces. The first nonempty `repo:` value is used, and repeated languages are deduplicated. **grep.app language filtering is unreliable** and always adds a warning when used; avoid it for a first search, and treat zero hits as inconclusive.

Other qualifiers are provider-dependent: grep.app leaves `path:`, `filename:`, and similar syntax in the literal pattern, while GitHub receives the original query unchanged and interprets its own syntax. A zero-hit warning suggests possible remedies, not a confirmed cause or proof that code does not exist. grep.app and public Sourcegraph do not index every GitHub repository; `repo:facebook/react` often misses on those sources.

## Full Configuration

The config path is `<agent-dir>/web-search.json`, normally `~/.pi/agent/web-search.json`. `PI_WEB_SEARCH_CONFIG` overrides this path. `PI_CODING_AGENT_DIR` changes Pi's agent directory.

The extension does not automatically read project `.pi/web-search.json` or merge Pi's `settings.json`. Project-local installation does not change the config location.

A missing file uses these defaults:

```json
{
  "web": { "provider": "exa", "fallback": ["parallel"] },
  "code": { "provider": "grep", "fallback": ["sourcegraph", "github"] },
  "research": { "enabled": false },
  "timeoutMs": 20000,
  "maxResults": 8
}
```

All fields are optional. Merge changes into the existing file. The extension reads config each operation. Tool exposure changes require `/reload`.

- `web` accepts `exa` and `parallel`. `code` accepts `grep`, `sourcegraph`, and `github`.
- `maxResults` truncates to an integer, then clamps to **1–20**, per provider. Merged results and additional URL excerpts can exceed this limit. Providers may return fewer results or ignore the limit.
- `timeoutMs` truncates to integer milliseconds. Positive values have a **1,000 ms minimum**. Nonpositive values use **20,000 ms**. These numeric adjustments emit no warnings.
- Invalid JSON, unknown fields/providers, and malformed blocks produce `invalid_config`. Wrong-family providers trigger warnings and defaults or removal. Some invalid Jev values trigger defaults with warnings. Only literal `true` enables `jev.enabled`.

See the [configuration resolver](src/providers/config.ts) for validation details.

### Optional multi-source search and Jev

1. Run `/web-search-settings` to identify the config path.
2. Merge `{"research":{"enabled":true}}` into that file.
3. Run `/reload`.

`multi_search` sends the same query concurrently to all eligible sources in scope. `fallback: []` does not exclude sources. It does not check agreement or initiate further searches.

Jev requires a separate opt-in. Anonymous retrieval needs no classifier credentials. See [classifier setup](docs/research.md#enable-external-judgment), [tuning](docs/research.md#all-jev-settings), and [failure behavior](docs/research.md#outcomes-and-limits).

## Credentials

Exa MCP, Parallel native MCP, grep.app, and Sourcegraph need no search key. Anonymous Parallel has lower server-controlled rate limits. A Parallel key is optional.

Search credentials use the first nonblank environment alias before `<agent-dir>/auth.json`. GitHub then tries an existing `gh auth login` token.

| Stored ID | Environment aliases, highest precedence first | Behavior |
| --- | --- | --- |
| `exa` | `EXA_API_KEY` | Selects REST instead of keyless MCP. |
| `parallel` | `PARALLEL_API_KEY` | Adds a Bearer header for higher limits. |
| `github` | `GITHUB_TOKEN`, `GH_TOKEN` | Requires a token. Returns only verified public results. |

- Set environment variables **before starting Pi**. Exports in another shell cannot change a running Pi process. Restart Pi with the changed environment.
- The extension reads Exa/GitHub stored keys each operation.
- Parallel captures its Bearer header at MCP registration. Run `/reload` after changing its key.

Merge this entry into existing `auth.json` without replacing other credentials:

```json
{ "parallel": { "type": "api_key", "key": "<your-api-key>" } }
```

- Replace the placeholder privately.
- Exclude auth files from version control.
- Use narrowly scoped keys/tokens.

The [retrieval credential resolver](src/env.ts) reads literal `.key` strings, not shell commands, embedded environment references, or OAuth refresh credentials. Unreadable/malformed auth means no stored key. The extension never writes credentials.

Pi alone resolves classifier authentication at judgment time. Jev needs no separate key.

Each provider controls quotas and billing. Keys do not guarantee quota or price changes. Additional sources do not guarantee results or availability.

`/web-search-settings` shows an authentication snapshot, not a live key-validity test. It never displays keys.

## Provider behavior and limits

- Default chains: **Exa → Parallel** and **grep.app → Sourcegraph → GitHub**.
- Empty web results do not trigger fallback. Empty code results or retryable failures continue through the [provider chain](src/providers/index.ts).
- Results contain links and excerpts, not full pages. See [structured output](src/format.ts).

## Timeouts, fallback, and errors

Retrieval and judgment share a default **20-second** budget. Cleanup can take longer. Jev failures return unjudged evidence with warnings. Retrieval deadline expiry or caller cancellation fails the call.

Check warnings and `/web-search-settings`. Use `/mcp` for Parallel connection issues.

## Data handling

**Do not send secrets or private code.** External providers receive queries and URLs. Optional Jev receives candidate titles, URLs, and provider excerpts before output clipping.

Retrieved content is untrusted. Jev is not a prompt-injection firewall or truth guarantee.

The extension does not send workspace files or session history as search payloads. Pi can retain tool calls in session history.

Queries, URLs, errors, and excerpts can contain sensitive text.

## Development and package checks

1. Run `cd pi-web-search`.
2. Run `npm ci --ignore-scripts --no-audit --no-fund`.
3. Run `npm test`.
4. Run `npm run typecheck`.
5. Run `npm run audit:prod`.
6. Run `npm run pack:check`.

Optional live check: `npm run smoke:live`. It sends public test queries without your credentials. See [release checks and limits](docs/release-validation.md).

SDK users must load Pi's MCP and codemode extensions. They must call `bindExtensions()`. See the [SDK example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/14-codemode-mcp.ts).

## License

[MIT](LICENSE) - Gagan Devagiri
