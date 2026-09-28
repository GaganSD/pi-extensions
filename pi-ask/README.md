# pi-ask

First-party TUI clarification for [Pi](https://pi.dev). Answer, correct, or question the agent's question without losing the thread.

Selected source is derived from [`@geoqiao/pi-ask`](https://github.com/geoqiao/pi-tools) under MIT. See [NOTICE](./NOTICE).

## Install

```bash
pi install npm:pi-ask
```

From a clone of this repo, `pi install .` at the repo or package root, then `/reload`. Uninstall `@geoqiao/pi-ask` if both are present — `/answer` overlaps.

## Everyday use

The agent calls `ask_user` to interview you — gaps, requirements, authorization, or brainstorming. `/answer` if it asked in prose.

| Need | Feature |
| --- | --- |
| Choose one answer or several | `single` and `multi` |
| Type freely | `text` questions, or `Type your own` on option questions |
| Understand a choice first | Notes |
| Repair a bad question | Live `single` ↔ `multi` (`t`) |

### Commands

| Command | What it does |
| --- | --- |
| `/answer` | Extract questions from the latest completed assistant message |
| `/ask-settings` | Settings overlay; `?` inside a form opens the same overlay |

These commands are TUI-only. Non-TUI callers get `status: "unavailable"`.

## Contract

Input: `{ title?, questions: [{ id, label?, prompt, type: single\|multi\|text, options? }] }`.

- `text` questions have no options.
- `single` / `multi` need real options. Do not invent filler.
- Recommended options are labeled, never preselected.

Output:

- `status`: `submitted` | `cancelled` | `unavailable` | `invalid`
- `answers[id]`: `{ values, labels, customText?, note?, optionNotes? }`
- typed text is never merged into option `values`
- `unanswered: id[]`

Optional config: `~/.pi/agent/extensions/pi-ask.json`. `/ask-settings` or `?` in a form. `/answer` uses the current chat model unless `answer.extractionModels` is set.
