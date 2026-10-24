# pi-web-search

**Web and public-code search for Pi: `web_search`, `code_search`, and opt-in `multi_search`.**

- **Keyless by default:** Exa, Parallel, Jina Reader (URL-only extraction), grep.app, and Sourcegraph. Optional Jev filtering reuses your Pi login/key.
- You configure providers in settings; Agent only sees small, task-focused tools for minimal context bloat. Optional Brave REST search uses a key; no extra tools or provider-selection arguments.
- Opt-in search across multiple sources, scoped to web, code, or both.
- Optional Pi-native Jev ranking, filtering, and safety classification. Off by default.

## Installation

Requires Pi **0.99.0 or newer**.

1. Install: `pi install npm:@gagansd/pi-web-search`

2. The first interactive session shows a one-time setup prompt for existing Exa, GitHub, and Parallel credentials. For keys and settings anytime, run `/web-search`.

> Keyless configs have limitations set by Exa and Parallel.

| Command | What it does |
| --- | --- |
| `/web-search` | Menu: status, provider keys, classifier. Headless prints status. |
| `/web-search status` | Providers, credential presence (never keys), and the classifier pin. |
| `/web-search provider [name]` | Add or modify a retrieval key. The picker is color-coded: keyless, optional, or required; present or missing. |
| `/web-search classifier [none\|provider/model]` | Pin a classifier for judgment, pick from the list, or disable with `none`. |

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

The provider-independent boundary makes other classifiers possible without rewriting retrieval or ranking. Pin any registered Pi classifier with `/web-search classifier`.

### Try Jev with your existing Pi login

For OpenRouter:

1. Run `/login openrouter` **only if Pi isn't already authenticated**.
2. Run `/web-search classifier` and pick `openrouter/~typesafe/jev-latest`, or `/web-search classifier openrouter/~typesafe/jev-latest`.
3. Run `/reload`.
4. Ask: “Use multi_search to search the web for AbortSignal.timeout.”

| Use | Setup command | Default model |
| --- | --- | --- |
| TypeSafe | `/web-search classifier typesafe/jev-latest` | `jev-latest` |
| Vercel AI Gateway | `/web-search classifier vercel-ai-gateway/typesafe-ai/jev` | `typesafe-ai/jev` |
| OpenRouter | `/web-search classifier openrouter/~typesafe/jev-latest` | `~typesafe/jev-latest` |
| OpenCode | `/web-search classifier opencode/jev-1.13` | `jev-1.13` |
| OpenAI Decisions | `/web-search classifier openai/gpt-6-luna` | `gpt-6-luna` |
| Cloudflare Workers AI | `/web-search classifier` and pick a listed Clef/Jev model | catalog |

`/web-search classifier` lists every classifier Pi currently registers, plus **None**. Classifiers do not appear in `/model`; this picker is the search-specific pin. Pinning enables multi-source search and judgment in `web-search.json`, preserving your other settings. **No second API key is needed.** Pi reuses its stored, environment, runtime, or model authentication. If needed, use Pi's `/login` for that provider.

`/web-search classifier none` disables judgment; search stays on. Hosted classification is billed to the pinned account.

Classification is off by default. Failures keep retrieved evidence with warnings. Hosted classifiers receive excerpts before output clipping; safety judgments are not a security boundary. See [all settings and limits](docs/research.md).

## Tools and Examples

1. Use `web_search` for explanations and documentation
2. `code_search` for literal public-code patterns
3. Opt-in `multi_search` when you need retrieval from multiple sources

> Two tools are declared directly by default; `multi_search` is opt-in. `search_read` is always registered for codemode discovery, not added as another direct declaration.

| Tool | Inputs | Use |
| --- | --- | --- |
| `web_search` | `query` and/or `urls` | Public documentation and current information; omit `query` to fetch known pages without searching. |
| `code_search` | Required `query` | Literal identifiers or code snippets in public repositories. |
| `multi_search` | Required `query` and `scope` (`web`, `code`, or `both`) | Opt-in concurrent retrieval across available sources; optional judgment is configured separately. |

You can narrow searches to specific codebases using prompts like "check Meta's repos only", which your LLM translates to GitHub org/user-level filters:

```json
{ "query": "useSyncExternalStore repo:vercel/next.js" }
```

**Multi-source search**, after [enabling it](#optional-multi-source-search-and-jev) — `multi_search` arguments:

```json
{ "query": "AbortSignal.timeout", "scope": "both" }
```

Supply a query, URLs, or both. Omit `query` for URL-only extraction (no search request). An explicitly supplied query must be nonblank and is limited to 4,000 characters. `web_search` accepts up to 20 URL strings; blanks are ignored and invalid/non-HTTP(S) URLs generate warnings. URL-only calls require at least one valid URL. Extraction returns provider-selected evidence, not a full browser page. Undeclared tool arguments such as `limit`, `provider`, or `path` are ignored and named in successful-result warnings; they do not configure a provider or filter.

### Read more without another network request

Searches return bounded previews plus a session-local `resultId` when evidence can be stored. Use codemode to list results or read a passage:

```js
const index = await tools.search_read({ resultId: "<returned handle>" });
text(index);
const passage = await tools.search_read({ resultId: "<returned handle>", index: 0, find: "timeout" });
text(passage);
```

Indexes are zero-based. Omit `find` and use `offset`/`limit` to page; `passage.nextOffset` identifies the next slice. Handles expire after 10 minutes, eviction, shutdown, or reload. Nothing is written to disk. Stored evidence is bounded and may already have been truncated by the provider; it is **not guaranteed full-page content**. If codemode is unavailable, retrieve the cited URL again. See [efficiency and limits](docs/efficiency.md).

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

- `web` accepts `exa`, `parallel`, and `brave`. Jina is extraction-only, not a search-chain provider. `code` accepts `grep`, `sourcegraph`, and `github`.
- `maxResults` truncates to an integer, then clamps to **1–20**. It limits both provider requests and the **global returned preview count**, including URL excerpts. Requested URL extracts are prioritized; additional admitted evidence is available through `search_read`. Providers may return fewer results or ignore the requested limit.
- `timeoutMs` truncates to integer milliseconds. Positive values have a **1,000 ms minimum**. Nonpositive values use **20,000 ms**. These numeric adjustments emit no warnings.
- Invalid JSON, unknown fields/providers, and malformed blocks produce `invalid_config`. Wrong-family providers trigger warnings and defaults or removal. Some invalid Jev values trigger defaults with warnings. Only literal `true` enables `jev.enabled`.

See the [configuration resolver](src/providers/config.ts) for validation details.

### Optional multi-source search and Jev

1. Run `/web-search` to identify the config path.
2. Merge `{"research":{"enabled":true}}` into that file.
3. Run `/reload`.

`multi_search` sends the same query concurrently to all eligible sources in scope. `fallback: []` does not exclude sources. It does not check agreement or initiate further searches.

Jev requires a separate opt-in. Anonymous retrieval needs no classifier credentials. See [classifier setup](docs/research.md#enable-external-judgment), [tuning](docs/research.md#all-jev-settings), and [failure behavior](docs/research.md#outcomes-and-limits).

## Credentials

Exa MCP, Parallel native MCP, grep.app, and Sourcegraph need no search key. Jina Reader handles URL-only extraction anonymously; Brave search requires its own key. Anonymous Parallel has lower server-controlled rate limits. A Parallel key is optional.

Search credentials use the first nonblank environment alias before `<agent-dir>/auth.json`. GitHub then tries an existing `gh auth login` token.

| Stored ID | Environment aliases, highest precedence first | Behavior |
| --- | --- | --- |
| `exa` | `EXA_API_KEY` | Selects REST instead of keyless MCP. |
| `parallel` | `PARALLEL_API_KEY` | Adds a Bearer header for higher limits. |
| `github` | `GITHUB_TOKEN`, `GH_TOKEN` | Requires a token. Returns only verified public results. |
| `brave` | `BRAVE_API_KEY`, `BRAVE_SEARCH_API_KEY` | Optional REST search provider; requires a key. |

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

The [retrieval credential resolver](src/env.ts) reads literal `.key` strings, not shell commands, embedded environment references, or OAuth refresh credentials. Unreadable/malformed auth means no stored key.

`/web-search provider` adds or modifies a retrieval key in `auth.json` and shows where to create one. Keys are never command arguments, never written to `web-search.json`, and never displayed after you type them. Environment aliases still win over the stored value.

Pi supplies optional host peers. This package does not install another Pi copy. See the [npm advisory notes](docs/release-validation.md#npm-advisory-and-host-dependencies).

Pi alone resolves classifier authentication at judgment time. Jev needs no separate key.

Each provider controls quotas and billing. Keys do not guarantee quota or price changes. Additional sources do not guarantee results or availability.

`/web-search` shows an authentication snapshot, not a live key-validity test. It never displays keys.

### Optional Brave search

Run `/web-search provider brave` to store a key privately, then merge this into `web-search.json`:

```json
{ "web": { "provider": "brave", "fallback": ["exa", "parallel"] } }
```

Brave uses one REST request and returns ranked snippets, not generated answers or extra snippets. Its queries are limited to 400 characters and 50 words; longer queries fail explicitly rather than being silently shortened. Without a key, Brave is skipped. Opt-in `multi_search` includes it when credentials are present. Supplied URLs are extracted by keyless Jina alongside Brave search.

URL-only `web_search` uses Jina Reader regardless of the search-provider selection, with existing web extraction as a retryable fallback. Jina is not a search engine, requires no setup, and receives only requested URLs, not the search query. Images and link destinations are omitted from Jina Markdown to reduce output noise. New providers share the existing preview and local-continuation budgets; no new LLM instructions or tools are added.

## Provider behavior and limits

- Default chains: **Exa → Parallel** and **grep.app → Sourcegraph → GitHub**.
- Empty web results do not trigger fallback. Empty code results or retryable failures continue through the [provider chain](src/providers/index.ts).
- Results contain links and excerpts, not guaranteed full pages. Exact duplicate evidence is collapsed, while distinct passages and code anchors remain. Structured excerpts share a 12,000-character budget, with a 4,000-character per-hit maximum and short model-facing previews. See [structured output](src/format.ts).
- Direct HTTP retrieval has bounded 30-second session reuse and in-flight deduplication. Rate-limited providers enter a short cooldown. Parallel nested calls always execute through Pi so permission checks are never reused. See [efficiency and limits](docs/efficiency.md).

## Timeouts, fallback, and errors

Retrieval and judgment share a default **20-second** budget. Cleanup can take longer. Jev failures return unjudged evidence with warnings. Retrieval deadline expiry or caller cancellation fails the call.

Check warnings and `/web-search`. Use `/mcp` for Parallel connection issues.

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
7. Run `npm run bench:context` for offline context-footprint measurements (character-proxy estimates, not billed tokenizer counts).

Optional live check: `npm run smoke:live`. It sends public test queries without your credentials. See [release checks and limits](docs/release-validation.md).

SDK users must load Pi's MCP and codemode extensions. They must call `bindExtensions()`. See the [SDK example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/14-codemode-mcp.ts).

## License

[MIT](LICENSE) - Gagan Devagiri
