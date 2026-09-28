# pi-ask contract

Tool name: `ask_user`.

## Input

```ts
{
  title?: string
  questions: Array<{
    id: string
    label?: string
    prompt: string
    type?: "single" | "multi" | "text"
    options?: Array<{
      value: string
      label: string
      description?: string
      recommended?: boolean
    }>
  }>
}
```

Rules:

- `text` questions have no options.
- `single` / `multi` need real options. Do not invent filler.
- There is no `required` field and no `preview` type.
- Recommendations are labels only; they are never preselected.

## Output

```ts
{
  status: "submitted" | "elaborated" | "cancelled" | "unavailable" | "invalid"
  answers: Record<string, {
    values: string[]
    labels: string[]
    customText?: string
    note?: string
    optionNotes?: Record<string, string>
  }>
  unanswered: string[]
  questions: Array<{ id: string; label: string; prompt: string; type: string; presentedType?: string }>
  title?: string
  elaboration?: {
    instruction: string
    explain: Array<{
      questionId: string
      prompt: string
      note: string
      optionValue?: string
      optionLabel?: string
    }>
    keep: Record<string, { values: string[]; labels: string[]; customText?: string }>
  }
  error?: { kind: "invalid_input"; issues: Array<{ path: string; message: string }> }
}
```

- Typed text is never merged into option `values`.
- `cancelled`, `unavailable`, and `invalid` are distinct.
- Cancellation, omission, and uncertainty are not approval.
- Non-TUI returns `status: "unavailable"` and does not open a form.

## Commands

`/answer` extracts the last completed assistant message. It must preserve offered choices or fail visibly.

`/answer:again` and `/ask:replay` reopen the last matching form on the current branch. There is no automatic reopen on session start.
