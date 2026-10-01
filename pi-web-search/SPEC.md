# pi-web-search — implementation contract

This file describes the maintained contract. It is not published (`package.json`
`files` ships only `src/`, `README.md`, `LICENSE`). Where the code and this file
disagree, the code wins; update this file with the code.

## Goal and boundary

Expose **`web_search`** and **`code_search`** always, and **`research_search`**
only when research is explicitly enabled. Providers, credential resolution, and
optional Jev judgment stay internal; the model never selects a vendor, a
fallback, or a Jev backend.

Minimum and pinned test baseline: Pi Coding Agent `0.99.0`, Node `>= 22.19.0`.
Older Pi hosts are rejected. Host packages are peers, never bundled.

## Tools

Registered by `src/index.ts`. Schemas are TypeBox; every `query` is
`minLength: 1` and `maxLength: MAX_QUERY_CHARS` (4000), which keeps the crafted
keyless-Exa `objective` (query plus a short prefix) below the server's 4096
character limit.

```ts
WebSearchSchema   = { query: string, urls?: string[] /* maxItems: 20 */ }
CodeSearchSchema  = { query: string }
ResearchSearchSchema = { query: string, scope: "web" | "code" | "both" }
```

Each tool is registered with `promptSnippet` and `promptGuidelines` so it appears
in Pi's "Available tools" section and its guidelines. The guidelines state the
selection rule plainly: local files use `rg`/`grep`, prose/docs use `web_search`,
remote literal code uses `code_search`, and cross-source checking uses
`research_search`. Only `repo:`/`language:` are portable filters.

Every tool declares the `search` namespace, read-only/open-world annotations,
and `SearchOutputSchema`. Successful and failed results return schema-matching
`structuredContent`; scripts receive data, while models receive cited Markdown.

The host validates arguments before `execute` and leaves undeclared keys in the
argument object, so `executeSearch` compares the arguments each tool received
against that tool's declared names and adds a warning naming anything ignored.
This is deliberately not an error: weak models hallucinate provider-specific
keys such as `top_n` or `limit`, and failing the call costs a round trip
without improving the answer. The schemas therefore stay open (no
`additionalProperties: false`), which would otherwise make the host reject the
call with an opaque `schema is false` instead.

`scope: "code"` ignores `urls` with a warning.

## Registration and reload

- `web_search` and `code_search` are always registered.
- `research_search` is registered only when `resolveSettingsSync()` yields
  `researchEnabled === true`, using the same parser as execution.
  Only `research.enabled: true` enables it.
- Tool exposure is load-time. The README documents `/reload` as the way to apply
  an exposure change.
- Execution re-checks the opt-in (`requireResearch`): if `research_search` was
  registered and settings changed without a reload, the call fails with
  `invalid_config` instead of silently running.

## Credentials

One resolver in `src/env.ts`. Resolution order per credential:

1. every nonblank environment alias, highest precedence first;
2. the current stored value in Pi's `auth.json`.

`CREDENTIAL_ENV_ALIASES` is the single source of truth:

| id | aliases |
| --- | --- |
| `exa` | `EXA_API_KEY` |
| `parallel` | `PARALLEL_API_KEY` |
| `github` | `GITHUB_TOKEN`, `GH_TOKEN` |
| `typesafe` | `TYPESAFE_API_KEY`, `JEV_API_KEY` |
| `vercel-ai-gateway` | `AI_GATEWAY_API_KEY` |

Rules:

- `resolveCredential(id, options?)` is the only resolver. `options.env`,
  `options.readCredential`, and `options.authPath` are the hermetic test seams.
- **No immortal cache.** The stored file is read on every call, so rotating or
  removing a key takes effect on the next operation.
- Whitespace-only values are absent.
- `enableStoredCredentials(authPath?)` points the default stored reader at Pi's
  auth file. `src/index.ts` calls it at extension load; a bare import of the
  tools, or the test suite, never reads the operator's secrets.
  `disableStoredCredentials()` restores the no-stored-credential state.
- Keys are read-only. Nothing writes or edits `auth.json`. Nonsecret settings
  never live there.

## Configuration

`src/providers/config.ts` owns one parser. `parseWebSearchConfig` is pure;
`readWebSearchConfig` (async) and `readWebSearchConfigSync` (load-time) share it,
and `resolveSettings` / `resolveSettingsSync` share `applyConfig`.

- Path: `$PI_WEB_SEARCH_CONFIG`, else `<agent-dir>/web-search.json`.
- Missing file is not an error; defaults are used.
- Malformed JSON, a non-object, non-numeric `timeoutMs`/`maxResults`, a bad
  `fallback`, or a non-object `jev` produce an `InvalidConfigError`
  (`code: "invalid_config"`, `configPath`).
- Unsupported top-level keys, malformed family/research blocks, and unknown
  Jev settings or ranking-weight names are errors.
- Provider chains exist only under `web` and `code`; research is enabled only
  by `research.enabled: true`.
- No top-level `provider`/`fallback`/`family`/`mode` migration, implicit research
  activation, or older-host compatibility code.

## Errors

Failures return `isError: true`, model-facing `<tool> failed (<code>): <detail>`,
and a structured `error` payload retaining code, HTTP status, JSON-RPC code,
retryability, and config path where applicable. `src/utils.ts` formats this
boundary result; transport errors still throw internally for fallback policy.
The host preserves `details` and `structuredContent` on failed calls.

## Operation deadline and progress

- One bounded deadline per tool call: `withTimeout(signal, settings.timeoutMs)`
  composed with the caller's signal, disposed in `finally`. Retrieval and Jev
  share it. A retrieval deadline abort is a `timeout`, never a user abort.
  If only optional judging exhausts that budget, return the cited retrieval
  results with a warning. Genuine user cancellation always fails the call.
- Progress is a typed, **best-effort** observer owned by the runner
  (`ProgressObserver`): cancellation is checked before every emit, a throwing
  callback never fails or reshapes the search, and nothing is emitted after
  `finish()`. No event bus.
- A collapsed successful result renders a compact summary (providers, result
  count, warning count, scope, jev status) rather than a blank row.

## Providers and transports

`src/providers/index.ts` owns chain and fan-out policy:
`resolveProviderChain`/`listRunnableProviders` keep the walk inside one family
(`web` = Exa/Parallel, `code` = grep.app/GitHub). `runSearch` walks the chain,
continues on retryable errors, and throws the last error. `runParallelSearch`
fans out available sources, records per-source warnings, and fails only when no
source succeeds or on abort.

Transport detail, parsers, MCP framing, and provider-specific identifiers live in
`src/providers/{exa,parallel,grep,github,http,mcp}.ts`. GitHub code search is
public-only and uses the REST `/search/code` endpoint: its repository visibility
and browsable `html_url` are retained (the minimal MCP response omits them).
Non-public or unverifiable hits are withheld and reported; unfiltered raw code
payloads are never used as fallback results. Exa URL-content responses retain
only requested URL identities; unrequested/unidentified documents are withheld
with a count warning, on both keyed REST and keyless MCP paths.

A keyless Exa quota refusal is returned in-band with HTTP success, so it would
otherwise be rendered as a fake result and never trigger fallback. It is
promoted to `rate_limited` only when the parser found no results at all, the
reply names the service as a standalone token, and it matches the refusal
wording. Pages *about* rate limits are ordinary results and a citation with thin
or empty highlights is still a citation, so the check is deliberately biased
toward saying nothing: the accepted cost is that a refusal which happens to
parse into a citation is kept as a citation, with no warning. A refused *fetch*
only adds a warning and never discards content.

## Jev (optional judgment)

Jev is not a provider and never appears in `ProviderKind`. It is gated on
`jev.enabled` plus a resolvable credential (`typesafe` native, then
`vercel-ai-gateway`). Absent or failing, results pass through with a warning; a
down decision layer degrades a search rather than failing it. Suppressions are
reported (`suppressed`, `suppressedUrls`), never silent. An enabled, authenticated
judge with no candidates is `skipped`, not `disabled`. See `src/jev/`.

## `/web-search-settings`

A headless-safe command using host custom messages or UI notifications: the resolved config path, each
family's provider and fallback, `research_search` and Jev state, credential
presence **and source only** (never a key), and setup guidance. It performs no
network calls and never writes secrets.

## Non-goals

- No `url_context` tool; `urls` on `web_search` is the only URL path.
- No LLM provider calls beyond the optional Jev judgment, no proxy support, no
  telemetry, no additional secret stores.
- No classes, global pools, watchers, or reactive configuration frameworks.
- No older-host shims, deprecated setting migration, or redundant error wrappers.

## Test requirements

`node --test --experimental-strip-types`, offline. Required coverage:

- config: scoped defaults, invalid JSON/types, rejected unsupported settings,
  `maxResults` clamp, `PI_WEB_SEARCH_CONFIG`, and research opt-in with the sync
  and async resolvers agreeing;
- credentials: every alias, env-over-auth precedence, rotation/removal observed
  through an injected `authPath`, whitespace absence, unreadable file;
- registration: default set, enabled/disabled research, declared namespace,
  annotations/output schema, invalid config, prompt snippets, settings command;
- tool boundary: schema-valid structured successes and `isError: true` failures
  with preserved tool name/code/status/config path;
- providers/transport: chain order, fallback, abort propagation, parsers, MCP
  envelope correlation, cancellation, teardown (see `tests/`).
