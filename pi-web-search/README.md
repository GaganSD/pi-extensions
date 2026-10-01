# pi-web-search

**An optimized web search tool for the Pi Coding Harness that introduces three tools: `web_search`, `code_search`, and `research_search`.**

- Connects with Parallel, Exa, and Grep (works without an API key).
- All connectors are encapsulated for the agent and designed to be human-configured through settings to minimize bloat during coding sessions.
- Classifier API (Jev and OpenAI's Decisions API) helps with ranking, filtering, and prompt injection prevention. Can be disabled in settings.

## Installation

1. Install with: `pi install npm:@gagansd/pi-web-search`
2. (Optional) Add API keys for Exa, Parallel, and Jev using `/pi-web-search`.

## Tools and Examples

1. Use `web_search` for explanations and documentation.
2. `code_search` for literal public-code patterns.
3. Opt-in `research_search` when you need retrieval from multiple sources.

> The tool definitions register two tools by default and activate `research_search` only when enabled.

| Tool | Inputs | Use |
| --- | --- | --- |
| `web_search` | Required `query`; optional `urls` | Public documentation, prose, current information; retrieve known-page excerpts alongside a search. |
| `code_search` | Required `query` | Literal identifiers or code snippets in public repositories. |
| `research_search` | Required `query` and `scope` (`web`, `code`, or `both`) | Opt-in concurrent retrieval across available sources; optional judgment is configured separately. |

You can narrow searches to specific codebases using prompts like "check Meta's repos only", which your LLM translates to GitHub org/user-level filters:

```json
{ "query": "useSyncExternalStore repo:facebook/react" }
```

**Cross-source check**, after [enabling research](#optional-research-and-jev) — `research_search` arguments:

```json
{ "query": "AbortSignal.timeout", "scope": "both" }
```

Queries are required even when supplying URLs, are limited to 4,000 characters, and must not be blank after trimming. `web_search` accepts up to 20 URL strings; blanks are ignored and invalid/non-HTTP(S) URLs generate warnings. URL input requests remote extraction, not a full browser page or a URL-only fetch. Undeclared tool arguments such as `limit`, `provider`, or `path` are ignored and named in successful-result warnings; they do not configure a provider or filter.

### Can it search my local files or return private code?

No. For workspace files, use local `rg`/`grep` or Pi's file tools. `code_search` returns public code; it is not a workspace index or a repository checkout. GitHub's public-result filter does not limit the token's permissions or prevent upstream query processing; see [data handling](#data-handling). Pi's `read` tool does not open URLs—use `web_search` with `urls` for remote excerpts.

### Code qualifiers

`repo:<owner/name>` and `language:<name>` are the documented common subset. On grep.app, these are extracted into filters; quote qualifier values containing spaces. The first nonempty `repo:` value is used, and repeated languages are deduplicated. **grep.app language filtering is unreliable** and always adds a warning when used; avoid it for a first search, and treat zero hits as inconclusive.

Other qualifiers are provider-dependent: grep.app leaves `path:`, `filename:`, and similar syntax in the literal pattern, while GitHub receives the original query unchanged and interprets its own syntax. A zero-hit warning suggests possible remedies, not a confirmed cause or proof that code does not exist.

## Configuration

No config file is required for default search. To change providers or enable research, use `<agent-dir>/web-search.json`, normally `~/.pi/agent/web-search.json`. `PI_WEB_SEARCH_CONFIG` overrides that file path; `PI_CODING_AGENT_DIR` changes Pi's agent directory. There is no automatic project `.pi/web-search.json` lookup or merge with Pi's `settings.json`. A project-local package install does not make this config project-local.

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

### Optional research and Jev

To expose `research_search`, merge this into the config path printed by `/web-search-settings`, then `/reload`:

```json
{ "research": { "enabled": true } }
```

Research sends the same query to all eligible sources in the chosen scope, concurrently. It is not an autonomous research agent, agreement checker, or automatic follow-up search. It merges successful responses while the operation deadline remains live. Ordinary web/code searches do not run Jev.

Optional Jev ranking, safety classification, and sufficiency judgment additionally require `jev.enabled: true` and an available Pi classifier model (TypeSafe or Vercel AI Gateway). Pi owns classifier authentication through `TYPESAFE_API_KEY`, `AI_GATEWAY_API_KEY`, or Pi-supported stored/runtime/model auth; anonymous Parallel search does not depend on it. Before enabling it, read [research and Jev settings](docs/research.md) for every setting/default, backend precedence, data sent externally, and fail-open behavior. Judgment is an optional heuristic, **not a security boundary**.

## Credentials

### Which providers need an API key?

Default Exa web search, native Parallel MCP web fallback, and grep.app code search need no search-provider key. Parallel anonymous access has lower server-controlled rate limits; an already configured key is optional for higher limits. An Exa key selects REST instead of keyless MCP; GitHub requires a token. Jev is independently opt-in and uses Pi classifier authentication. Additional providers do not guarantee more results or availability.

For retrieval IDs, the first nonblank environment alias below overrides the current stored key in `<agent-dir>/auth.json`, as defined by the [credential resolver](src/env.ts). The classifier rows report package-visible key presence only; Pi independently resolves classifier authentication:

| Stored ID | Environment aliases, in precedence order | Enables |
| --- | --- | --- |
| `exa` | `EXA_API_KEY` | Exa REST instead of keyless MCP. |
| `parallel` | `PARALLEL_API_KEY` | Optional Bearer header for Parallel native MCP (anonymous without it). |
| `github` | `GITHUB_TOKEN`, `GH_TOKEN` | Authenticated GitHub search; only verified public results are returned. |
| `typesafe` | `TYPESAFE_API_KEY`, legacy `JEV_API_KEY` | Diagnostic only. Pi uses `TYPESAFE_API_KEY` or its stored/runtime/model auth; `JEV_API_KEY` alone does not authenticate Pi's classifier. |
| `vercel-ai-gateway` | `AI_GATEWAY_API_KEY` | Diagnostic only. Pi uses `AI_GATEWAY_API_KEY` or its stored/runtime/model auth; Pi owns availability. |

Set environment variables **before starting Pi**. A new export in another shell cannot change a running Pi process; restart Pi with that environment. Exa/GitHub stored keys are read each operation; the Parallel Bearer header is captured when its MCP server is registered, so changing its key requires `/reload`. Pi, not this package, resolves classifier credentials at judgment time.

To store a key, merge an entry of this form into Pi's existing `auth.json` (replace the placeholder privately; do not replace other credentials):

```json
{ "parallel": { "type": "api_key", "key": "<your-api-key>" } }
```

For retrieval keys, this extension reads literal `.key` strings; it does not resolve shell commands, environment references inside those strings, or OAuth refresh credentials. Pi owns classifier credential resolution, including its other supported auth sources. Unreadable/malformed retrieval auth is treated as no stored key. This extension does not write credentials. Keep auth files out of version control and use narrowly scoped keys/tokens. Additional sources have their own quotas and billing; no price or quota increase is promised here.

`/web-search-settings` does not echo resolved key values. **That is not a general secret-redaction guarantee**: tool queries, URLs, upstream errors, warnings, and excerpts may contain sensitive text. See [data handling](#data-handling).

## Provider behavior and limits

| Source | Default eligibility | Behavior |
| --- | --- | --- |
| Exa | Keyless; a resolved key selects REST | Web search and supplied-URL extraction run concurrently. URL extraction requests excerpts up to 3,000 characters per page. |
| Parallel | Keyless native Pi MCP; configured key adds Bearer header | Pi connects to `https://search.parallel.ai/mcp`. Search uses server defaults; supplied-URL `web_fetch` requests excerpts (`full_content: false`) after search. The local `maxResults` cap limits presented search hits. |
| grep.app (`grep`) | Keyless | Indexed literal public-code search over hosted MCP; results locally limited to `maxResults`. |
| GitHub | Requires token | REST code search; non-public or unverifiable returned repositories are withheld. |

An explicit `pi_web_search_parallel` entry in Pi `mcp.json` takes precedence over the package registration: configure your own server there if needed, inspect `/mcp`, and `/reload`. Without a key, the package sends no Authorization header and does not start OAuth. Parallel's `https://search.parallel.ai/mcp-oauth` endpoint is an explicitly chosen authenticated account-enforcement option configured in your own `mcp.json` entry, not a silent fallback. An unavailable/disabled built-in MCP host (or an adapter replacing it) must be fixed in Pi; this package does not spawn an independent Parallel client. Native raw MCP tools may also be reachable through Pi deferred exposure. The package sends a stable opaque hashed `session_id` per conversation, and only a known runtime model ID as `model_name` (omits absent/unknown); no workspace or transcript data is used for these fields.

Eligibility means credential availability, not health. Ordinary defaults are **Exa → Parallel** for web and **grep.app → GitHub** for code. A successful empty or unparsed reply ends that chain. Only retryable failures try the next eligible source while the operation deadline remains live; there is no same-provider retry/backoff loop or guaranteed failover. Without keys, both default web sources remain eligible. Pi host/pipeline failures without an MCP error envelope (including arbitrary permission-hook reasons) are nonretryable and reported with `/mcp` guidance, never bypassed with a private Parallel transport. Only an actual MCP server error envelope can authorize fallback for a reported 429/5xx; authentication/permission denials do not retry into another source.

If a configured ordinary chain has no eligible source, available family defaults are restored. Research appends the family defaults to the configured set and runs all eligible sources. **`fallback: []` is not a research exclusion or privacy allowlist.** Research hits sharing a URL remain distinct; only the source index is deduplicated. Consulted-provider coverage is not an exhaustive index or a trace of every failed ordinary attempt.

Parsed Exa URL excerpts must identify a requested URL. Fragment differences and safe URL-serialization equivalents (host case, default ports, root slash) are accepted, but changed scheme/path/query or arbitrary redirect destinations are not inferred. Unrequested/unidentified parsed pages are withheld. Unparsed Exa replies can be returned with warnings and no verified page identity; do not claim a requested page was read just because the search succeeded. Links support inspection, not truth, freshness, or safety certification.

### Output for models and scripts

Tools expose the `search` namespace and [output schema](src/format.ts). Models receive Markdown; scripts receive `structuredContent` with `status`, `text`, and available results, sources, coverage, warnings, usage, and Jev audit fields. Failures set `isError: true` and carry `error.code`, `message`, and applicable HTTP/RPC/config metadata. Empty results may still have `status: "success"`. `grounded` means a source URL is present, not independent verification.

Evidence is compact, not a full-document archive:

- Markdown excerpts show at most **400 characters per hit**. Structured `searchResults[].citedText` is a preview capped at **4,000 per hit / 32,000 total**, allocated in returned-result order; later hits may have empty previews. Hits and citation URLs remain.
- Provider prose is capped at **8,000 characters**. Other string metadata is capped at **1,000 per field / 16,000 total**, except recognized provider tags. Incoming warnings are limited to **100 entries / 1,000 each / 8,000 total**, plus small generated truncation notices.
- Error messages are capped at **8,000 characters**, followed by `[Truncated]`. Final Markdown and structured `text` also use Pi's head limits (**2,000 lines or 50 KiB**) with `[Truncated]`.

Applicable clipping adds warnings. Character budgets use JavaScript string lengths, not tokens. Citation URLs and result counts are not shortened: this is **not a hard total serialized byte cap**. No full-output recovery file is written; follow citations or narrow the request for more evidence. Network response bodies have a separate **10 MiB per-response cap**.

## Timeouts, fallback, and errors

The default **20-second operation budget** covers retrieval plus optional judgment, starting after local config reading and input normalization. Stages share that budget; no time is reserved for fallback. Legacy Exa/grep.app MCP teardown has an independent best-effort deadline of up to **2 seconds per session**; native Parallel MCP connection lifecycle is owned by Pi, so do not interpret `timeoutMs` as an exact wall-clock limit. Fully framed, correlated streamed MCP replies can complete without waiting for stream EOF.

| Situation | Behavior and next step |
| --- | --- |
| `invalid_config` | Inspect the named path/field. Fix JSON or unsupported settings; `/reload` if changing tool exposure. |
| `missing_credentials` | Can mean no eligible source **or** no loaded transport. Check the message and settings report rather than assuming default search always needs a key. |
| `rate_limited`, `network_error`, retryable `http_error` | An eligible same-family fallback may run. Check upstream/network/quota; optional keys add sources, not guaranteed availability. Ordinary HTTP 4xx (other than 429) and parse failures generally stop fallback. |
| Empty or unparsed success | No automatic fallback. Shorten a literal query, remove qualifiers, or inspect warnings; absence is inconclusive. |
| URL extraction failure | Successful search evidence is retained with warnings while the operation remains live. Check URL-specific warnings before claiming page coverage. |
| Retrieval `timeout` or caller `aborted` | Fatal to the call, even if a research sibling already returned results. Narrow the request/check the network before considering a larger budget. Cancellation does not start fallback. |
| Jev unavailable, skipped, or timed out | Already-retrieved evidence is returned with status/warnings; genuine caller cancellation remains fatal. |
| Missing research tool / duplicate tool name | Enable research and `/reload`; for a conflict, disable the conflicting resource/package and reload rather than deleting unrelated tools. |

## Data handling

- Queries and supplied URLs leave the machine for the selected retrieval services. Do not submit secrets, private code, credential-bearing URLs, or private-document links expecting local-only access. HTTP(S) validation does not remove URL credentials or make content safe.
- Research can send the query to every eligible provider in scope. Optional Jev sends the query, candidate titles, URLs, and provider-returned excerpts to TypeSafe or Vercel **before** output clipping or suppression—more than the model's 400-character preview.
- GitHub's public-result filter runs **after** authenticated upstream search. It does not restrict the token's permissions or prevent GitHub from processing the original query.
- Returned pages, code, links, and warnings are untrusted. There is no general secret scrubber, content sanitizer, or prompt-injection firewall. Jev may retain uncertain content or fail open; do not follow retrieved instructions as trusted commands.
- The extension does not persist a result cache or send local workspace files/session history as search payloads. Tool arguments/results can still enter Pi session history and model context. Provider and model retention policies are external; no zero-retention claim is made.
- Read-only/open-world annotations are hints, not a sandbox. Like other Pi extensions, this code runs with Pi's operating-system permissions.

## Development and package checks

From the repository root:

```bash
cd pi-web-search
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run typecheck
npm run pack:check
```

Development uses locked dependencies and Node's native TypeScript stripping. Tests use injected transports and isolated config/auth environments plus a local stdio MCP fixture loaded through the real Pi SDK nested tool pipeline; they do not establish live upstream availability. `pack:check` validates an actual source-only tarball, installs it in an isolated consumer, loads its entrypoint through Pi, and runs regressions against extracted source. No bundler output, tests, credentials, or validation tooling ship in the package. The pack check also requires `tar`. The CLI loads Pi’s native MCP and codemode built-ins automatically. SDK embeddings do not: put `createMcpExtension()` and `createCodemodeExtension()` in `DefaultResourceLoader.extensionFactories` alongside the package path, reload that loader, pass it into `createAgentSession()`, call `session.bindExtensions({})`, and wait for native MCP connection before searching. See [Pi's checked SDK example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/14-codemode-mcp.ts) and the repository's offline [`native-sdk.test.ts`](https://github.com/GaganSD/pi-extensions/blob/main/pi-web-search/tests/native-sdk.test.ts) for the complete loader/fixture setup. An SDK session without built-in MCP support cannot use this package's Parallel provider.

[llms.txt](llms.txt) is a short navigation index for agents to find these docs and source contracts. It does not change Pi tool routing, retrieval quality, or performance.

## License

[MIT](LICENSE).
