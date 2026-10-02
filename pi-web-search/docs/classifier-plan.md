# Classifier provider support plan

**Status:** planned, not implemented. `multi_search` is the renamed tool; its existing `research.enabled` opt-in remains unchanged.

## Current architecture

- `src/jev/model.ts` selects only TypeSafe and Vercel models.
- `src/jev/api.ts` calls Pi's `modelRegistry.classify()` with typed boolean/choice questions and validates the answers.
- `src/jev/judge.ts` owns ranking weights, suppression thresholds, and sufficiency policy. Search providers do not own classification.
- `src/jev/augment.ts` preserves retrieved evidence when optional judgment fails; caller cancellation remains fatal.

Pi already supports arbitrary registered classifier providers, including local llama.cpp models. The missing piece for local/custom support is configurable model selection, not a new search transport. OpenAI Decisions requires a verified API contract and an adapter; it is not currently supported by this package or the installed Pi classifier catalog.

## 1. Make model selection provider-independent

Add a preferred `classifier` configuration block:

```json
{
  "research": { "enabled": true },
  "classifier": {
    "enabled": true,
    "provider": "llama.cpp",
    "model": "<exact-registered-model-id>"
  }
}
```

- Normalize this block into the existing judgment settings. Carry over `weights`, `safetyThreshold`, and `maxStateChars`; keep judgment disabled by default.
- Continue accepting existing `jev` configuration. Reject simultaneous `classifier` and `jev` blocks with an actionable `invalid_config` error rather than silently choosing one.
- With no explicit provider/model, retain today's TypeSafe-first, Vercel-second default mapping. An explicit provider requires an exact model ID.
- Resolve explicit selections through `findOfType("classifier", provider, model)` and `getAvailableOfType()`. Never select a chat model by mistake or silently change providers.
- In particular, an unavailable local model must not fall back to a cloud classifier. Return unjudged evidence with a warning.
- Update `/web-search-settings` to report configured classifier selection and setup guidance without secrets or network calls; presence is not proof of availability.
- Retain existing `jev`/`jevStatus` result fields for compatibility in this change; document them as legacy names for judgment metadata.

## 2. Enable local and custom classifiers

- Reuse Pi's built-in llama.cpp classifier through its model registry; do not build a second HTTP client or install/download models automatically.
- Document router setup, `/login llama.cpp`, `/llama`, and exact model selection. Other local classifiers must register a Pi classifier provider with a compatible `classify()` implementation.
- Require valid boolean probabilities and choice distributions/confidence. Labels alone or invented confidence values are not equivalent to this contract. Validate finite values, ranges, option coverage, and normalization before applying policy.
- Preserve the 8-second judgment deadline, remaining operation budget, state-size guard, usage accounting, and caller cancellation. Local classifiers may evaluate questions sequentially; expensive requests should skip/fail open, not silently acquire a larger budget.
- Explain that local classification keeps judgment on the selected local endpoint; Exa/Parallel/grep.app/GitHub retrieval still sends queries externally. Local model probabilities need task-specific evaluation before reusing suppression thresholds.

## 3. Add an OpenAI adapter only after verification

**Gate:** obtain official Decisions API documentation, model IDs, access requirements, authentication, request/response schemas, probability semantics, usage, limits, and cancellation behavior. Public search did not establish an authoritative contract during this change.

- Implement the verified protocol as a Pi classifier provider, preferably upstream or in a separate provider extension. Search should continue calling Pi's registry rather than making a hidden OpenAI request.
- Translate Pi boolean/choice questions and state to that API; normalize supported outputs to Pi's `ClassifierResult` contract and preserve usage/errors/abort signals.
- If the API lacks the probabilities needed by the current policy, explicitly redesign and evaluate the adapter/policy boundary. Do not fabricate probabilities.
- OpenAI Responses with Structured Outputs is a separately documented alternative, not proof of a Decisions endpoint and not a drop-in calibrated classifier. Do not market one as the other.
- Mark OpenAI available in the README only after contract tests and a credentialed live smoke test pass.

## Tests and acceptance

- Config: new block, legacy Jev, conflicting blocks, missing model IDs, invalid providers/models, and default-off behavior.
- Selection: TypeSafe/Vercel regression tests; exact local/custom provider selection; no arbitrary model or cloud fallback; unavailable local server.
- Contract: identical policy outcomes from normalized backend fixtures; missing/malformed/nonfinite probabilities; option coverage; injection-like excerpts; suppression audit/provenance.
- Lifecycle: state budget, classifier deadline, shared timeout, caller cancellation, fail-open evidence retention, and usage counted once.
- Integration: registered custom classifier through Pi's real tool pipeline; optional live llama.cpp smoke test; OpenAI smoke test only after the verification gate.
- Run `npm test`, `npm run typecheck`, and `npm run pack:check` from `pi-web-search`. Keep SDK examples and documentation accurate.

## References

- [Pi classifier models](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md#use-classifier-models)
- [Pi llama.cpp classification](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/llama-cpp.md#classification)
- [Pi custom classifier providers](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/custom-provider.md)
- [TypeSafe API](https://docs.typesafe.ai/api)
- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
