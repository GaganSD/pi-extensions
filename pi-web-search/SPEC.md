# pi-web-search — implementation contract

Parent-owned architecture contract. Every worker implements exactly this. Do not
invent new public exports, rename symbols, or add files outside your assigned seam.

## Goal

A minimal, self-hosted replacement for `npm:pi-web-search` that exposes **only** a
`web_search` agent tool. Default path is Exa (+ Parallel fallback). Optional
`mode: "parallel"` fans out Exa, Parallel, grep.app and GitHub, then Jev judges.

The third-party package required a paid LLM provider with native web search. We
search through dedicated search APIs instead, so a search costs a fraction of a
model call and works with any conversation model.

Package layout mirrors the repo conventions of `pi-ask` (`src/` + `tests/`,
`node --test --experimental-strip-types`, `tsc --noEmit`, `pi.extensions` in
`package.json`).

```
pi-web-search/
  package.json
  tsconfig.json
  LICENSE
  README.md
  SPEC.md              (this file, not published)
  src/
    index.ts           register the web_search tool
    web_search.ts      WebSearchSchema + webSearch() orchestration
    format.ts          StreamResult -> AgentToolResult
    utils.ts           error / missing-credential results
    env.ts             trimmed credential env reads
    jev/               decision layer (not a provider)
    providers/
      types.ts         shared result + error types
      config.ts        ~/.pi/agent/web-search.json loading + resolution
      http.ts          fetch wrapper: timeout, abort, error normalization
      mcp.ts           MCP client + shared withMcpSession
      results.ts       sourcesFromResults + mergeStreamResults
      exa.ts           Exa transport
      parallel.ts      Parallel transport
      grep.ts          grep.app transport
      github.ts        GitHub code-search transport
      index.ts         fallback chain + parallel fan-out
  tests/
    *.test.ts
```

## Tool contract

Tool name **`web_search`** (drop-in replacement). Parameters are **exactly**:

```ts
Type.Object({
    query: Type.String({ description: "The search query or question to answer" }),
    urls: Type.Optional(Type.Array(Type.String(), {
        description: "Additional URLs to analyze along with search (up to 20)",
        maxItems: 20
    })),
})
```

No other parameters. The tool description names Exa and Parallel, not LLM
providers. `index.ts` provides `renderCall` and `renderResult` using
`Text` from `@earendil-works/pi-tui` exactly like the third-party package:
`renderCall` shows the query plus `+ N URLs`; `renderResult` returns an empty
`Text` unless expanded or errored.

## Credentials and configuration

| Env var | Meaning |
| --- | --- |
| `EXA_API_KEY` | Optional. When set, Exa uses its REST API. |
| `PARALLEL_API_KEY` | Optional. Required for the Parallel transport. |
| `GITHUB_TOKEN` / `GH_TOKEN` | Optional. Required for GitHub code search. |
| `TYPESAFE_API_KEY` / `JEV_API_KEY` | Optional. Native Jev. |
| `AI_GATEWAY_API_KEY` | Optional. Jev via Vercel AI Gateway. |
| `PI_WEB_SEARCH_CONFIG` | Overrides the config file path. |

Config file: `$PI_WEB_SEARCH_CONFIG` else `join(getAgentDir(), "web-search.json")`.
`getAgentDir` is imported from `@earendil-works/pi-coding-agent`.

```jsonc
{
  "mode": "simple" | "parallel",    // optional, default "simple"
  "provider": "exa" | "parallel" | "grep" | "github",
  "fallback": ["parallel"],
  "timeoutMs": 20000,
  "maxResults": 8,
  "family": "web" | "code",
  "jev": { "enabled": false, "backend": "auto" | "typesafe" | "vercel" }
}
```

Rules:

- The file is optional. Missing file is **not** an error.
- Malformed file (bad JSON, not an object, non-numeric `timeoutMs`/`maxResults`)
  is an error that must be surfaced to the model with
  `details.error === "invalid_config"` and the path. Never throw raw.
- Unknown keys are ignored, not rejected.
- Unknown `provider` (including leftover LLM vendor names from the third-party
  package) is a notice and the default `exa` is used. Do not fail the search.
- `simple` walks `[provider, ...fallback]` inside one family.
- `parallel` fans out every available source (or the pinned family). One failure
  is a warning. User abort fails the whole fan-out. If every source fails, the
  last error surfaces.
- Precedence: config file `provider` > default `exa`.

## Exa transport

Two paths, chosen automatically:

1. **REST, when `EXA_API_KEY` is set.**
   `POST https://api.exa.ai/search` with header `x-api-key`.
   Body: `{ query, numResults, type: "auto", contents: { highlights: { numSentences: 3 }, text: false, summary: false } }`.
      Response: `{ requestId, results: [{ title, url, publishedDate, author, score, highlights, text, summary }], searchType }`.
   (`/search` and `/contents` both answer 402 with an x402 pay-per-request body
   when called without a key, and 401 when a key is present but invalid. That is
   why the keyless MCP path exists.)

2. **Keyless hosted MCP, when `EXA_API_KEY` is absent.** This is the free path and
   the reason the extension needs no key to work.
   `POST https://mcp.exa.ai/mcp` (JSON-RPC 2.0, streamable HTTP, SSE responses).
   Call `tools/call` with `{ name: "web_search_exa", arguments: { query, numResults, objective } }`.
   `objective` is required by that tool; derive it as
   `Find the most relevant web pages that answer: ${query}`.
   The tool returns one text block: repeated
   `Title: <t>\nURL: <u>\nPublished: <p>\nAuthor: <a>\nHighlights:\n> <h>...` groups.
   Parse those groups into results. If parsing finds nothing usable, still return
   the raw text as a single synthetic result so the model keeps the content.

3. **Fetch, when `urls` were supplied.** Both paths genuinely retrieve those URLs;
   neither folds them into the query text.
   - Keyed: `POST https://api.exa.ai/contents` with header `x-api-key` and body
     `{ urls, text: true }`. Response: `{ requestId, results: [{ id, title, url,
     text, summary }], status }`. Merge those results after the search results.
   - Keyless: call `web_fetch_exa` with `{ urls, maxCharacters: 3000 }` in
     addition to `web_search_exa`, and append its returned text blocks.

Both paths must populate the same `StreamResult` shape.

## Parallel transport

`POST https://api.parallel.ai/v1/search`
Headers: `Content-Type: application/json`, `x-api-key: $PARALLEL_API_KEY`.

Body (GA shape, `search_queries` is required by the API):

```jsonc
{
  "objective": "<query>",
  "search_queries": ["<query>"],
  "mode": "fast",
  "max_chars_total": 20000,
  "advanced_settings": {
    "max_results": 8,
    "excerpt_settings": { "max_chars_per_result": 2500 }
  }
}
```

Response: `{ search_id, session_id, results: [{ url, title, publish_date, excerpts: string[] }], warnings, usage }`.

`/v1/search` is the documented endpoint for new integrations. Do not use
`/v1beta/search`. When `urls` are supplied, also call `POST /v1/extract` with
`{ urls, objective }` and merge those results.

## Shared result types (`src/providers/types.ts`)

```ts
export type ProviderKind = "exa" | "parallel";

export interface Source { title: string; url: string }

export interface SearchResultDetail {
    title?: string;
    url?: string;
    query?: string;
    source?: string;          // provider name, e.g. "exa" | "parallel"
    pageAge?: string | null;  // publishedDate / publish_date
    citedText?: string;       // joined excerpts / highlights
    status?: string;
    type?: string;
}

export interface StreamResult {
    text: string;             // markdown summary; "" when the provider only returns documents
    sources?: Source[];
    providerKind: ProviderKind;
    searchResults?: SearchResultDetail[];
    requestId?: string;       // Exa requestId or Parallel search_id
    usage?: { name: string; count: number }[];  // Parallel only
    warnings?: string[];      // Parallel only
}

/** Thrown by transports; `code` is stable and used for fallback + error details. */
export interface ProviderError extends Error {
    code: "missing_credentials" | "invalid_config" | "http_error" | "rate_limited"
        | "network_error" | "timeout" | "aborted" | "parse_error" | "unknown";
    status?: number;
    retryable?: boolean;
}
```

Both transports throw `ProviderError`. `missing_credentials` is **not**
retryable; `http_error` with 5xx, `network_error`, `timeout` and `rate_limited`
are.

## Provider registry and fallback (`src/providers/index.ts`)

```ts
export interface SearchRequest {
    query: string;
    urls?: string[];
    signal?: AbortSignal;
    onUpdate?: AgentToolUpdateCallback;
    settings: ResolvedSettings;
}

export function resolveProviderChain(settings: ResolvedSettings): ProviderKind[];
// [provider, ...fallback] filtered to transports that currently have credentials
// or that are keyless-capable (exa is always present; parallel needs a key).

export async function runSearch(req: SearchRequest): Promise<StreamResult>;
// Tries the chain in order. On a retryable error, continues to the next entry.
// On the last failure (or a non-retryable error), rethrows.
// Aborts propagate immediately and are never retried.
```

`runSearch` must not swallow the first provider's error when no fallback
succeeded — the last error is what surfaces.

## Transport contract (exact export names)

`src/providers/exa.ts` MUST export exactly:

```ts
export interface ExaSearchOptions { fetchImpl?: FetchLike }
export async function exaSearch(req: SearchRequest, options?: ExaSearchOptions): Promise<StreamResult>
```

`src/providers/parallel.ts` MUST export exactly:

```ts
export interface ParallelSearchOptions { fetchImpl?: FetchLike }
export async function parallelSearch(req: SearchRequest, options?: ParallelSearchOptions): Promise<StreamResult>
```

`options.fetchImpl` defaults to `globalThis.fetch`. It is the test-injection
seam and lives on the transport, NOT on `SearchRequest`: `SearchRequest` is the
production contract that the tool layer constructs, so it must not carry a
field only tests ever set. `SearchTransport = (req: SearchRequest) => Promise<StreamResult>`
still accepts both functions because the second parameter is optional.

The export NAMES `exaSearch` / `parallelSearch` are the compile-time contract
that `src/providers/index.ts` dynamically imports. A transport file that is
missing, or that throws while importing, leaves that provider absent so the
chain skips it; `runSearch` raises its normal "no transport available" error
only when the chain ends up empty. A renamed export must be a `tsc` error,
never a silent runtime "No transport is registered".

## `src/format.ts`

- `formatResult(text, details)` uses `truncateHead` with
  `DEFAULT_MAX_LINES` / `DEFAULT_MAX_BYTES` imported from
  `@earendil-works/pi-coding-agent`, appends `\n\n[Truncated]` when truncated.
- `formatWebSearchResult(result)` builds:
  - a `## Sources` numbered link list from `result.sources`
  - a `## Results` section listing each `searchResults` entry as
    `N. [title](url)` plus a `> excerpt` blockquote of the first ~400 characters
    of `citedText` (single newlines only, collapsed whitespace)
  - a `## Warnings` section when `warnings` is non-empty
- `details` must include: `provider`, `requestId`, `resultCount`, `sources`,
  `searchResults`, `warnings`, and `grounded: sources.length > 0`.
- Output must be deterministic given the same `StreamResult`, so tests can assert
  on it.

## `src/utils.ts`

- `missingCredentialResult(kind, hint)` → `details.error === "missing_credentials"`.
- `invalidConfigResult(path, error)` → `details.error === "invalid_config"`.
- `errorResult(e)` → maps `ProviderError.code` to `details.error`, includes
  `details.code` and `details.status`, message is `web_search failed (<code>): <message>`.
- Always returns `AgentToolResult`, never throws.

## Tests

`node --test --experimental-strip-types`. No network. Every transport is tested
by injecting a `fetch` implementation (dependency injection through an options
parameter, default `globalThis.fetch`) so the suite is hermetic and offline.

Required coverage:

- config: missing file, valid file, invalid JSON, unknown provider, defaults,
  clamp of `maxResults`, `PI_WEB_SEARCH_CONFIG` override
- exa: REST body/headers with key, keyless MCP initialize + `tools/call` +
  highlight-group parsing, `urls` path, HTTP 401 → `http_error`,
  `missing_credentials` never raised for exa
- parallel: body shape matches the GA schema, headers, `urls` → `/v1/extract`,
  missing key → `missing_credentials`, 401 → `http_error`
- registry: chain order, fallback on retryable, no fallback on
  `missing_credentials`, abort propagates, last error surfaces
- format: sources section, results section with excerpts, truncation marker,
  details shape
- utils: each error result's `details.error`

## Sources: two families, four providers (added 2026-09-30)

`ProviderKind` gains two members. They are **not peers** — they fall into two
families, and the fallback chain must never cross a family boundary.

```ts
export type ProviderKind = "exa" | "parallel" | "grep" | "github";
export type ProviderFamily = "web" | "code";
export const PROVIDER_FAMILY: Record<ProviderKind, ProviderFamily> = {
  exa: "web", parallel: "web", grep: "code", github: "code",
};
```

Cross-family fallback is a correctness bug, not a config choice: if Exa fails
and the chain falls through to grep.app, a web question silently receives code
results. `resolveProviderChain` becomes family-aware and returns a chain
confined to one family.

### grep.app — keyless, MCP only

- **REST `GET https://grep.app/api/search` is UNUSABLE.** Verified 2026-09-30: it
  returns a Vercel bot-challenge HTML page, not JSON, from a plain script.
  Do not implement it.
- **Use `POST https://mcp.grep.app`** (streamable HTTP). Verified working.
  No `mcp-session-id` header is returned, so `McpClient.close()` correctly no-ops.
  `searchGitHub` args: `query`, `matchCase`, `matchWholeWords`, `useRegexp`,
  `repo`, `language`, `path`.
- Response is plain text: repeated `Repository:/Path:/URL:/License:` groups with
  `--- Snippet N (Line X) ---` bodies. Parse in the style of `parseExaSearchText`.
- **The `language` filter is nondeterministically broken.** Verified: identical
  query and `language: ["typescript"]` returned 504, empty, and 504 across three
  attempts; `["TypeScript"]` returned 504, 504, OK. Neither an empty result nor
  a 504 from a filtered query is trustworthy.
  - 504 is already retryable (5xx) and falls through the chain.
  - **Zero results while a filter was applied MUST surface as a warning**, never
    as an empty result. Otherwise the model concludes the pattern does not exist
    in the ecosystem, which is a confidently wrong answer. Silent failure.

### GitHub — official MCP, needs a token

- `POST https://api.githubcopilot.com/mcp/`, `Authorization: Bearer $GITHUB_TOKEN`.
  Without a token: 401. Returns a real `mcp-session-id`, so sessions must be
  closed. `notifications/initialized` returns 202 with an empty body.
- `search_code` is present among 45 tools. Args: `query`, `perPage` (max 100),
  `page`, `order`, and `fields`.
  - **Always pass `fields: ["path","sha","repository","text_matches"]`.** Omitting
    `repository`/`text_matches` is what makes responses huge, and `sha` is
    required to build a citable URL.
  - Build the source URL as `https://github.com/{repository}/blob/{sha}/{path}`.
    Verified working. `grounded` depends on real URLs, so this is load-bearing.
  - The response is JSON **wrapped inside** a text content block; unwrap it.
  - Sorting is deprecated — results are always best-match and the ordering is not
    ours to control. `order` exists in the schema; do not rely on it.
- **Code search has its own 10 req/min limit**, separate from other search types.
  Observed live: back-to-back probes returned transient failures. Treat 429 and
  5xx as retryable and back off.

### MCP framing caveat

GitHub's server is inconsistent **within one session**: `initialize` and
`tools/call` use `event: message\ndata: {...}`, but `tools/list` uses
`event: message\n{...}` with no `data:` prefix. `extractSseData` collects only
`data:` lines, so it would return zero payloads for the bare form. Production
calls are unaffected, but make `extractSseData` tolerate a bare JSON line after
`event: message` rather than depend on that holding.

## Jev decision layer (`src/jev/`)

**Jev is not a provider.** It never appears in `ProviderKind` or the fallback
chain. It judges results the providers already returned. `grep`/`github` are
real providers; Jev is not.

Gated on config `jev.enabled` and a resolvable Jev credential. Absent either, or
on any error, results pass through byte-identically. A decision layer that is
down must degrade a search, never fail it. Every failure becomes a warning.

Two backends, same request body:

- Native TypeSafe: `POST https://api.typesafe.ai/v1/systemone`, model `jev-1.13.0`.
  Keys: `TYPESAFE_API_KEY` or `JEV_API_KEY`, then Pi `auth.json` `typesafe`.
- Vercel AI Gateway: `POST https://ai-gateway.vercel.sh/typesafe/v1/systemone`,
  model `typesafe-ai/jev`. Keys: `AI_GATEWAY_API_KEY`, then Pi `auth.json`
  `vercel-ai-gateway`.

`backend: "auto"` prefers native, then Vercel. A pinned native model id is
remapped on the Vercel catalog and vice versa. **Do not add `@typesafe-ai/sdk`**
— zero runtime deps is a hard constraint. **Pin `jev-1.13.0` on native, never
`jev-latest`**; the alias moves.

### Two calls, in this order

**1. Route (pre-dispatch, query only).** `Choice` over `{web, code}` selects the
family. Small state, cheap. Skipped when config pins a family.

**2. Judge (post-retrieval, query + candidates).** All questions share one state
and go in a single request, so every candidate fits one round trip — instructions
reference candidates by backticked path (`candidates[0].excerpt`).

Per candidate:

| question | type | purpose |
| --- | --- | --- |
| `c{i}_answers` | noul | answers the query, vs merely sharing vocabulary |
| `c{i}_offtopic` | noul | different subject / product / version |
| `c{i}_selfcontained` | noul | citable without missing context |
| `c{i}_safety` | choice | `safe`, `prompt_injection`, `harmful_content`, `phishing`, `other` |

Once per request:

| question | type | purpose |
| --- | --- | --- |
| `sufficient` | noul | do these results contain what's needed to answer |
| `direct` | choice | which candidate (or `none`) answers the query outright |

### Policy lives in code, never in the prompt

- **Ranking** composes the three nouls with configurable weights, sorts in code.
  Never return empty: if every score is low, keep the best result and set
  `lowConfidence`. Returning nothing is a worse failure than returning something
  mediocre.
- **Safety is a separate axis from quality and must not be folded into the
  ranking weights.** Any non-`safe` outcome suppresses the result. Use a
  `Choice`, not a single noul threshold, so suppression reasons stay auditable.
  Asymmetric costs — a false clear admits unsafe content, a false flag hides a
  good result — so the safety threshold sits well above the rerank threshold, and
  the mid-band is **held, not passed**.
- **Suppress, never silently.** Every suppression is reported in
  `details.jev.suppressed` with count and URLs. Silent filtering makes a Jev
  misjudgment invisible, which is the one failure that cannot be debugged later.
- **"Direct text" means extract-and-select, never generate.** Jev returns typed
  judgments, not prose. `direct` selects *which* candidate answers the query and
  we copy that excerpt **verbatim**. Do not synthesize text from it.
- Thresholds and weights are config, not constants. Nothing here is validated on
  real traffic; ship the switch and collect `details.jev` before trusting order.

### Budget

Cap the judged set. State size is `candidates × excerptChars`; at
`maxResults: 20 × 2500` it approaches the 32k state limit. Above a configurable
character budget, skip augmentation entirely and pass results through.

### Injection risk

Jev reads the same untrusted excerpts the model does. Ranking misjudgments cost
bad ordering; a manipulated `sufficient` verdict pushes the model toward
answering on weak evidence. Adversarial fixtures are required, not optional.

## Onboarding (`/web-search-settings`)

Mirrors `pi-ask`'s `/ask-settings` (`pi.registerCommand` + a status panel). One
consistent view of every credential rather than four ad-hoc ones:

- grouped by family, each source with its state: ready / needs key / disabled /
  unreachable
- shows whether Jev is active and which family routing would pick
- shows the resolved config path and current `provider` / `fallback`
- never prints a key, only its presence

Keys live in env only. Never written into the config file or the repo.

## Non-goals

- **No `url_context` tool.** Decided 2026-09-30 (see `.reports/url-context-decision.md`).
  Both transports already fetch URLs, so a second tool would only add schema
  tokens to every request. Reusing that name would also imply Gemini URL Context
  parity the rebuild does not have. `urls` on `web_search` is the only URL path.
  Reserved seam: provider-level URL fetching stays a separate transport call from
  search orchestration, so a provider-neutral URL-only tool can be added later
  without touching the search path. Deferral trigger: agents routinely need to
  read known URLs without searching. When that happens, add a real tool — do not
  manufacture a dummy query to fake a URL-only call through `web_search`.
- No LLM provider calls, no streaming SSE parsing beyond the MCP envelope, no
  HTTP proxy support, no telemetry.
- No new runtime dependencies. `peerDependencies` only, matching `pi-ask`.
