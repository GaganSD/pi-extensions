# Multi-source search and Jev reference

[`multi_search`](../src/multi_search.ts) is opt-in concurrent retrieval, not a long-running research agent. External Jev judgment is a second opt-in. Ordinary `web_search` and `code_search` never run it. See the [package README](../README.md) for installation, retrieval defaults, credentials, and privacy limits.

## Enable multi-source search

Merge into the config file printed by `/web-search-settings`, then run `/reload`:

```json
{ "research": { "enabled": true } }
```

Call `multi_search` with a required query and explicit scope:

```json
{ "query": "AbortSignal.timeout", "scope": "both" }
```

`web` consults eligible Exa/Parallel sources; `code` consults eligible grep.app/GitHub sources; `both` sends the same query to both families. There is no `urls` parameter. Use identifiers/snippets rather than prose for code or mixed scope. Without retrieval keys, Exa, Parallel native MCP, and grep.app remain eligible. Check `/mcp` for native connection status; a same-name `pi_web_search_parallel` entry in `mcp.json` overrides the package server. Pi SDK embeddings must load Pi’s MCP and codemode extensions and call `bindExtensions()` (see the README).

Research appends family defaults to the configured preferences and runs all eligible sources concurrently. Empty fallback arrays do not exclude providers. Successful responses are concatenated, with source-index URLs deduplicated but same-URL hits retained. Within a live operation deadline, one failed source becomes a warning if another succeeds. All-source failure, caller cancellation, or a shared deadline expiring during retrieval fails the call, even after a sibling succeeded. Coverage is not agreement analysis or proof of exhaustive search.

Multi-source tool registration is fixed at extension load. Execution rechecks the current opt-in: disabling it without reloading makes an already-registered call fail with `invalid_config`. The settings report reads configuration; it is not a live tool-registration or provider-health test.

## Enable external judgment

Already authenticated in Pi? Run `/web-search-settings openrouter`, `vercel`, or `typesafe`, then `/reload`. The command atomically merges nonsecret settings, preserves tuning and search configuration, and refuses malformed files. It does not write credentials or make a classifier call. `/web-search-settings off` disables judgment only.

If necessary, authenticate using Pi's `/login openrouter`, `/login vercel-ai-gateway`, or `/login typesafe`. Existing Pi credentials are reused. Environment alternatives are `OPENROUTER_API_KEY`, `AI_GATEWAY_API_KEY`, and `TYPESAFE_API_KEY` respectively. Parallel retrieval remains anonymous without a Parallel key.

For manual configuration, this minimal OpenRouter example enables both independent opt-ins:

```json
{
  "research": { "enabled": true },
  "jev": { "enabled": true, "backend": "openrouter" }
}
```

Run `/reload` if research was not already exposed. Other judgment config changes are read next operation; Pi owns model availability and auth, and new shell exports still require starting Pi with that environment. `/web-search-settings` uses Pi's authentication snapshot and registered classifier catalog. It never independently resolves classifier keys and does not validate credentials or upstream health.

**Data sent:** at most one judgment request contains the query and every retained candidate's index, title, URL, and complete provider-returned `citedText`. This happens before formatter preview caps and before safety suppression. All candidates share one request with relevance, off-topic, self-contained, safety, and set-sufficiency questions. Do not enable it for evidence you are unwilling to send to the selected external service. This is a heuristic, not a security firewall or verified-answer guarantee.

## All Jev settings

All fields are optional. This block shows the defaults; it deliberately leaves both opt-ins off:

```json
{
  "research": { "enabled": false },
  "jev": {
    "enabled": false,
    "backend": "auto",
    "model": "jev-latest",
    "weights": {
      "answers": 0.45,
      "offtopic": -0.3,
      "selfcontained": 0.25
    },
    "safetyThreshold": 0.75,
    "maxStateChars": 24000
  }
}
```

| Field | Behavior |
| --- | --- |
| `enabled` | Only literal `true` enables judgment. Other values leave it off. Research must also be enabled to expose the tool that uses it; ordinary web/code tools never classify. |
| `backend` | `typesafe`, `vercel`, or `openrouter`. Legacy `auto` selects TypeSafe only; it no longer silently selects a gateway. Invalid backend values fail as `invalid_config` rather than silently selecting a different provider. No classifier provider fallback. |
| `model` | Nonempty Pi catalog identifier. Invalid known values default with a warning. The default `jev-latest` and legacy `jev-1.13.0` alias map to the selected provider's Jev model; an explicit unknown ID fails open with a warning rather than silently switching models. |
| `weights.answers` | Weight for answer relevance. |
| `weights.offtopic` | Signed weight for off-topic score; default negative penalizes off-topic evidence. |
| `weights.selfcontained` | Weight for usability without missing context. |
| `safetyThreshold` | A non-safe classification is suppressed when its winning-choice probability reaches this threshold. Policy clamps it to `[0,1]`. It is **not** a minimum confidence required to admit a `safe` result. |
| `maxStateChars` | Skip judgment if query + candidate title/URL/excerpt string lengths exceed this budget. It measures JavaScript characters, not encoded request bytes or tokens. Retrieval is still returned. |

Finite numeric values are accepted for weights and the two numeric settings; bad known values default with warnings. Weights are not normalized to sum to one. Unknown Jev fields/weight names or malformed blocks fail as `invalid_config`. These settings are parsed in [`providers/config.ts`](../src/providers/config.ts); ranking/suppression policy lives in [`jev/judge.ts`](../src/jev/judge.ts).

There is no `jev.timeoutMs` config field. The judge has a fixed **8,000 ms request deadline**, limited by the remaining shared `timeoutMs` operation budget. Increasing `timeoutMs` does not increase that judge-specific deadline.

## Pi classifier ownership and model mapping

The package never sends a Jev HTTP request or authenticates Jev itself. Pi’s `ctx.modelRegistry.findOfType("classifier", …)`, `getAvailableOfType()`, and `classify()` select and execute an available classifier with Pi’s own credential resolution. Pi reuses its stored/runtime/model auth or `TYPESAFE_API_KEY`, `AI_GATEWAY_API_KEY`, or `OPENROUTER_API_KEY`. The extension no longer reads classifier credentials. Legacy `JEV_API_KEY` is not supported; configure TypeSafe authentication in Pi instead. Manage alternate keys through Pi, not `web-search.json`. Check Pi’s [model catalog and authentication documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md#use-classifier-models). No key is needed for anonymous Parallel search without judgment.

The default model alias is `jev-latest`: TypeSafe resolves it to `jev-latest`, explicit Vercel selection to `typesafe-ai/jev`, and explicit OpenRouter selection to `~typesafe/jev-latest`. OpenRouter also accepts the exact `typesafe/jev-1.13` model ID. Legacy `auto` uses TypeSafe only; users who relied on automatic Vercel selection should run `/web-search-settings vercel`. The old `jev-1.13.0` alias remains compatible, with a migration warning when explicitly configured. Pi’s catalog owns availability and pricing; classification is billed to the selected provider. A different explicit ID is looked up as-is in the selected provider and is not auto-remapped. Missing model/auth, malformed or nonfinite answers, provider failure, or a classifier deadline leave retrieval unchanged with a warning; caller abort remains fatal. Pi classifier usage (tokens and catalog-priced cost when available) is attached to the tool result; nested MCP usage is counted separately by Pi, not copied twice.

## Outcomes and limits

`jevStatus` in structured output and coverage distinguishes:

| Status | Meaning |
| --- | --- |
| `disabled` | Not requested by this tool or config. Ordinary searches always use this status. |
| `unavailable` | Missing Pi classifier/credentials, service/malformed-answer failure, or a deadline during optional judgment. Retrieval remains, with warnings. |
| `skipped` | No candidates after enabling, or the state exceeds `maxStateChars` (with a budget warning). |
| `ran` | A response was processed; it does not certify complete or trustworthy judgments. |

Ranking is local weighted scoring; missing relevance scores use `0.5`. Confident non-safe classifications are suppressed, while uncertain/missing safety judgments can remain with safety-unverified warnings. There is no separate minimum safe-confidence gate. Missing sufficiency is treated as insufficient. Any suppression prevents a positive sufficiency claim for the surviving set because the global judgment saw the withheld candidates; survivors are not judged again.

When suppression occurs, aggregate provider prose and original provider warnings are conservatively withheld because they may quote suppressed content. Count-based notices, admitted results, citation audit URLs, and local config/input notices remain. This can hide otherwise useful upstream diagnostics. Structured `jev` records `sufficient`, `lowConfidence`, `suppressed`, and `suppressedUrls`; an unknown suppressed URL is reported as `(unknown)`, not the withheld title.

Missing Pi classifier/authentication, over-budget state, failures, and judgment deadlines **fail open** to the retrieved evidence, subject to normal output clipping. Genuine caller cancellation remains fatal. Jev does not guarantee truth, safe instructions, independence among sources, or agreement, and does not trigger another search. Inspect warnings and citations rather than treating `ran` or `sufficient` as a security decision. The implementation boundary is [`jev/augment.ts`](../src/jev/augment.ts).
