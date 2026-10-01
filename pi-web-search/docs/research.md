# Research and Jev reference

[`research_search`](../src/research_search.ts) is opt-in concurrent retrieval, not a long-running research agent. External Jev judgment is a second opt-in. Ordinary `web_search` and `code_search` never run it. See the [package README](../README.md) for installation, retrieval defaults, credentials, and privacy limits.

## Enable research

Merge into the config file printed by `/web-search-settings`, then run `/reload`:

```json
{ "research": { "enabled": true } }
```

Call `research_search` with a required query and explicit scope:

```json
{ "query": "AbortSignal.timeout", "scope": "both" }
```

`web` consults eligible Exa/Parallel sources; `code` consults eligible grep.app/GitHub sources; `both` sends the same query to both families. There is no `urls` parameter. Use identifiers/snippets rather than prose for code or mixed scope. Without retrieval keys, Exa and grep.app remain eligible.

Research appends family defaults to the configured preferences and runs all eligible sources concurrently. Empty fallback arrays do not exclude providers. Successful responses are concatenated, with source-index URLs deduplicated but same-URL hits retained. Within a live operation deadline, one failed source becomes a warning if another succeeds. All-source failure, caller cancellation, or a shared deadline expiring during retrieval fails the call, even after a sibling succeeded. Coverage is not agreement analysis or proof of exhaustive search.

Research registration is fixed at extension load. Execution rechecks the current opt-in: disabling it without reloading makes an already-registered call fail with `invalid_config`. The settings report reads configuration; it is not a live tool-registration or provider-health test.

## Enable external judgment

Merge these independent switches, and provide a [supported judgment credential](../README.md#credentials):

```json
{
  "research": { "enabled": true },
  "jev": { "enabled": true }
}
```

Run `/reload` if research was not already exposed. Other judgment config/key changes are read next operation; new shell exports still require starting Pi with that environment.

**Data sent:** at most one judgment request contains the query and every retained candidate's index, title, URL, and complete provider-returned `citedText`. This happens before formatter preview caps and before safety suppression. All candidates share one request with relevance, off-topic, self-contained, safety, and set-sufficiency questions. Do not enable it for evidence you are unwilling to send to the selected external service. This is a heuristic, not a security firewall or verified-answer guarantee.

## All Jev settings

All fields are optional. This block shows the defaults; it deliberately leaves both opt-ins off:

```json
{
  "research": { "enabled": false },
  "jev": {
    "enabled": false,
    "backend": "auto",
    "model": "jev-1.13.0",
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
| `enabled` | Only literal `true` enables judgment. Other values leave it off. Research must also be enabled to expose the tool that uses it. |
| `backend` | `auto`, `typesafe`, or `vercel`; invalid known values default with a search warning. Explicit selection restricts credentials to that backend, with no cross-backend retry on failure. |
| `model` | Nonempty configured identifier. Invalid known values default with a warning. Backend catalog mapping below applies; this is not an upstream model-availability guarantee. |
| `weights.answers` | Weight for answer relevance. |
| `weights.offtopic` | Signed weight for off-topic score; default negative penalizes off-topic evidence. |
| `weights.selfcontained` | Weight for usability without missing context. |
| `safetyThreshold` | A non-safe classification is suppressed when its winning-choice probability reaches this threshold. Policy clamps it to `[0,1]`. It is **not** a minimum confidence required to admit a `safe` result. |
| `maxStateChars` | Skip judgment if query + candidate title/URL/excerpt string lengths exceed this budget. It measures JavaScript characters, not encoded request bytes or tokens. Retrieval is still returned. |

Finite numeric values are accepted for weights and the two numeric settings; bad known values default with warnings. Weights are not normalized to sum to one. Unknown Jev fields/weight names or malformed blocks fail as `invalid_config`. These settings are parsed in [`providers/config.ts`](../src/providers/config.ts); ranking/suppression policy lives in [`jev/judge.ts`](../src/jev/judge.ts).

There is no `jev.timeoutMs` config field. The judge has a fixed **8,000 ms request deadline**, limited by the remaining shared `timeoutMs` operation budget. Increasing `timeoutMs` does not increase that judge-specific deadline.

## Credentials, backends, and model mapping

Per credential, nonblank environment aliases beat the current literal key in Pi's `auth.json`:

- Native `typesafe`: `TYPESAFE_API_KEY`, then `JEV_API_KEY`, then stored `typesafe.key`.
- Gateway `vercel-ai-gateway`: `AI_GATEWAY_API_KEY`, then stored `vercel-ai-gateway.key`.

For `backend: "auto"`, selection order is **native environment → gateway environment → native stored → gateway stored**. Thus a gateway environment key beats a native stored key. Explicit `typesafe` or `vercel` selects only that backend's environment/stored credential. Resolved key values are not included in the settings report; this does not imply all upstream messages are secret-redacted.

| Backend | Endpoint | Default model identifier |
| --- | --- | --- |
| `typesafe` | `https://api.typesafe.ai/v1/systemone` | `jev-1.13.0` |
| `vercel` | `https://ai-gateway.vercel.sh/typesafe/v1/systemone` | `typesafe-ai/jev` |

Native-looking `jev-*` identifiers and `jev-latest` map to `typesafe-ai/jev` on Vercel. Identifiers containing `/` map to the native default on TypeSafe. The gateway catalog ID is unversioned; do not assume it pins the same native version. Selection and mapping are defined in [`jev/auth.ts`](../src/jev/auth.ts).

## Outcomes and limits

`jevStatus` in structured output and coverage distinguishes:

| Status | Meaning |
| --- | --- |
| `disabled` | Not requested by this tool or config. Ordinary searches always use this status. |
| `unavailable` | Missing selected credential, service/parse failure, or a deadline during optional judgment. Retrieval remains, with warnings. |
| `skipped` | No candidates after enabling/authenticating, or the state exceeds `maxStateChars` (with a budget warning). |
| `ran` | A response was processed; it does not certify complete or trustworthy judgments. |

Ranking is local weighted scoring; missing relevance scores use `0.5`. Confident non-safe classifications are suppressed, while uncertain/missing safety judgments can remain with safety-unverified warnings. There is no separate minimum safe-confidence gate. Missing sufficiency is treated as insufficient. Any suppression prevents a positive sufficiency claim for the surviving set because the global judgment saw the withheld candidates; survivors are not judged again.

When suppression occurs, aggregate provider prose and original provider warnings are conservatively withheld because they may quote suppressed content. Count-based notices, admitted results, citation audit URLs, and local config/input notices remain. This can hide otherwise useful upstream diagnostics. Structured `jev` records `sufficient`, `lowConfidence`, `suppressed`, and `suppressedUrls`; an unknown suppressed URL is reported as `(unknown)`, not the withheld title.

Missing credentials, over-budget state, failures, and judgment deadlines **fail open** to the retrieved evidence, subject to normal output clipping. Genuine caller cancellation remains fatal. Jev does not guarantee truth, safe instructions, independence among sources, or agreement, and does not trigger another search. Inspect warnings and citations rather than treating `ran` or `sufficient` as a security decision. The implementation boundary is [`jev/augment.ts`](../src/jev/augment.ts).
