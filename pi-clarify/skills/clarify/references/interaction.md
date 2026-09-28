# Interaction guide

## Payload and presentation

- Include a stable question `id` and a non-empty `prompt`. Question ids must be unique within a call.
- Use `single` for one expected answer, `multi` for several, and `text` when the user should type freely.
- `text` questions have no options. `single` / `multi` need real distinct options with non-empty `value` and `label`. Do not add filler options.
- Use `description` for meaningful trade-offs. Mark grounded preferences with `recommended: true` and explain the reason in `description`; recommendations are presentation-only and never preselected.
- TUI provides tabbed questions, native single/multi selection, first-class text questions, and `Type your own` on option questions.

## Follow-ups and interrupted interactions

Explain a blocking gap and its consequence briefly. Use the tool for a needed decision, not a plain-text multiple-choice detour. Bundle questions only when independently answerable; respect the user's interview pacing.

After an elaboration or note, answer it first. Respect `elaboration.keep`; ask only questions still unresolved. Reopen a settled decision only for materially new information and explain what changed.

Cancellation, skipped questions, and unclear answers are not high-risk approval. Do not repeatedly ask the same unanswered authorization question or silently pick a risky default. Continue independent authorized work. `status` is not approval.

For exact result fields and lifecycle behavior, see the [contract](../../../docs/contract.md).
