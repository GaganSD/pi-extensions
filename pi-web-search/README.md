# pi-web-search

Search tools for the [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent). They call search APIs directly, so they work with any model and return cited documents.

## Tools

| Tool | Registered | What it does |
| --- | --- | --- |
| `web_search` | always | Documentation, prose, and current events on the public web. Optionally retrieves supplied `urls`. |
| `code_search` | always | Literal identifiers and snippets in public source code. |
| `research_search` | only when `research.enabled` | Cross-source retrieval in an explicit `scope` (`web`, `code`, or `both`). Optional Jev ranking. |

The agent never picks a vendor. Providers, keys, fallback, and Jev stay internal.

## Requirements

- **Pi `>= 0.99.0`**. Older versions are unsupported and rejected at extension load.
- **Node `>= 22.19.0`**, matching Pi 0.99.0.
- **Zero runtime dependencies.** Providers are reached with the built-in `fetch`.

## Install, update, remove

```bash
pi install npm:@gagansd/pi-web-search         # install
pi install npm:@gagansd/pi-web-search@latest  # update
pi remove npm:@gagansd/pi-web-search          # remove
```

Local development (no registry publish needed):

```bash
cd pi-web-search
npm install
npm test          # node:test, offline, hermetic
npm run typecheck
npm run pack:check
pi install .      # install the local package
```

## Keys and credentials

There is **one secrets location**: Pi's `<agent-dir>/auth.json` (usually `~/.pi/agent/auth.json`). Environment variables are an override and always win over the file. Only *presence* and *source* are ever reported; a key value is never printed.

Consolidated `auth.json` example covering every provider id:

```json
{
  "exa": { "type": "api_key", "key": "exa-..." },
  "parallel": { "type": "api_key", "key": "par_..." },
  "github": { "type": "api_key", "key": "ghp_..." },
  "typesafe": { "type": "api_key", "key": "ts_..." },
  "vercel-ai-gateway": { "type": "api_key", "key": "vck_..." }
}
```

Only add the entries you need. The matching environment aliases, highest precedence first:

| Credential id | Env aliases | Unlocks |
| --- | --- | --- |
| `exa` | `EXA_API_KEY` | Keyed Exa REST. Keyless Exa MCP works without it. |
| `parallel` | `PARALLEL_API_KEY` | Parallel web search and URL extraction. |
| `github` | `GITHUB_TOKEN`, `GH_TOKEN` | GitHub code search (public repositories only). |
| `typesafe` | `TYPESAFE_API_KEY`, `JEV_API_KEY` | Native Jev. |
| `vercel-ai-gateway` | `AI_GATEWAY_API_KEY` | Jev via the Vercel AI Gateway. |

- Every nonblank env alias beats the stored value. Values are read at call time, so **rotating or removing** a key in `auth.json` takes effect on the next search (no reload needed for keys).
- Whitespace-only values count as absent.
- GitHub uses its REST code-search API so repository visibility is checked before any snippets reach the model or Jev. Private or unverifiable hits are withheld; a valid GitHub API token is required.
- **Exa and grep.app are keyless.** `web_search` and `code_search` work out of the box; keys only add higher-rate/paid paths. Parallel and GitHub need a key.

## Configuration

Nonsecret settings live in `<agent-dir>/web-search.json` (override the path with `PI_WEB_SEARCH_CONFIG`). Plain JSON only — no comments. Configure providers inside `web` and `code`; only `research.enabled` enables research. Removed top-level settings (`provider`, `fallback`, `family`, `mode`) are rejected, not migrated.

```json
{
  "web": { "provider": "exa", "fallback": ["parallel"] },
  "code": { "provider": "grep", "fallback": ["github"] },
  "research": { "enabled": false },
  "timeoutMs": 20000,
  "maxResults": 8,
  "jev": { "enabled": false, "backend": "auto", "model": "jev-1.13.0" }
}
```

- `timeoutMs` is one **end-to-end** budget: retrieval plus optional Jev judgment. It is not renewed per request. If only judging exhausts it, the retrieved results return with a warning. User cancellation still fails the call.
- `research.enabled: true` is the only way to register `research_search`; omitted or false means disabled.
- Ordinary `web_search` never fans out and never calls Jev.
- Unsupported top-level keys or malformed settings fail with `invalid_config` and the file path. Unknown `jev` keys or ranking-weight names also fail, so typos cannot silently change safety policy. There are no compatibility or config-migration paths.

### Reloading

Tool exposure is fixed when the extension loads. After changing whether `research_search` is registered, run `/reload` (Pi reloads extensions). Changing keys in `auth.json` does not need a reload; changing `timeoutMs`/`maxResults` applies to the next call.

### Code search qualifiers

`code_search` takes one `query` string. It understands `repo:<owner/name>` and `language:<name>` (quote a value that contains spaces). The default grep.app provider receives the qualifiers as filters, not as part of the literal pattern. Only `repo:` and `language:` are portable filters. Other GitHub-specific syntax is provider-dependent and is not translated into grep.app filters. Queries are capped at 4000 characters.

## Troubleshooting

- **`... failed (missing_credentials)`** — the family has no usable key. Set the credential shown in the message and re-run; no reload is needed.
- **`... failed (invalid_config)`** — the message names the file and why. Fix the JSON, then re-run.
- **`research_search` is missing** — it only registers when `research.enabled` resolves to true. Set it and run `/reload`.
- **A provider timed out** — raise `timeoutMs`. The whole call shares that budget.
- **Status view** — run `/web-search-settings` for the resolved config path, credential presence/source (never keys), research/Jev state, and setup guidance. It performs no network calls and is safe headless.

## Conflicting `web_search` extensions

If another extension also registers `web_search`/`code_search`, disable or remove it so the model sees one definition. Pi reports the source of each registered tool; remove the conflicting package and run `/reload`.

## Tool examples

```json
{ "query": "Node.js AbortSignal timeout", "urls": ["https://nodejs.org/api/globals.html"] }
```

Call `web_search` with the object above. For `code_search`, use
`{ "query": "useState( repo:facebook/react" }`. When enabled, `research_search`
accepts `{ "query": "AbortSignal.timeout", "scope": "both" }`.

## Observability

All tools belong to the `search` namespace, declare read-only/open-world annotations, and expose `outputSchema`. Codemode callers receive `structuredContent` containing `status`, `text`, citation arrays, coverage, warnings, and usage rather than having to parse Markdown.

Failures return `isError: true` with a structured `error` (`code`, `message`, and relevant status/config fields). Pi marks them as failed calls while preserving their data for scripts and renderers. Successful calls expose the same citation metadata in `details`.

## License

MIT
