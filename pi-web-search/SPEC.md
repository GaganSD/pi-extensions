# pi-web-search — implementation contract

Parent-owned architecture contract. Every worker implements exactly this. Do not
invent new public exports, rename symbols, or add files outside your assigned seam.

## Goal

A minimal, self-hosted replacement for `npm:pi-web-search` that exposes **only** a
`web_search` agent tool backed by **Exa** and **Parallel** search APIs.

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
    providers/
      types.ts         shared result + error types
      config.ts        ~/.pi/agent/web-search.json loading + resolution
      http.ts          fetch wrapper: timeout, abort, error normalization
      mcp.ts           minimal MCP streamable-HTTP JSON-RPC client
      exa.ts           Exa transport
      parallel.ts      Parallel transport
      index.ts         provider registry + fallback chain
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
| `PI_WEB_SEARCH_CONFIG` | Overrides the config file path. |

Config file: `$PI_WEB_SEARCH_CONFIG` else `join(getAgentDir(), "web-search.json")`.
`getAgentDir` is imported from `@earendil-works/pi-coding-agent`.

```jsonc
{
  "provider": "exa" | "parallel",   // optional, default "exa"
  "fallback": ["parallel"],         // optional, default ["parallel"] — tried in order after provider fails
  "timeoutMs": 20000,               // optional, default 20000
  "maxResults": 8                   // optional, default 8, clamp 1..20
}
```

Rules:

- The file is optional. Missing file is **not** an error.
- Malformed file (bad JSON, not an object, unknown `provider`, non-numeric
  `timeoutMs`/`maxResults`) is an error that must be surfaced to the model with
  `details.error === "invalid_config"` and the path. Never throw raw.
- Unknown keys are ignored, not rejected.
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
