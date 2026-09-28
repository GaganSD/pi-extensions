# pi-ask

First-party TUI clarification for [Pi](https://pi.dev). Answer, correct, or question the agent's question without losing the thread.

Selected source is derived from [`@geoqiao/pi-ask`](https://github.com/geoqiao/pi-tools) under MIT. See [NOTICE](./NOTICE).

## Install

From this monorepo:

```bash
pi install /Users/gagandevagiri/GitHub/pi-extensions
```

Or from the package:

```bash
pi install npm:pi-ask
```

Then `/reload`. `/answer` overlaps if `@geoqiao/pi-ask` is also installed; keep only this package.

Do not edit `~/.pi/agent/settings.json` for this install.

## Everyday use

The agent calls `ask_user` for a material gap or an explicit interview. You can also run `/answer` if it asked in prose.

| Need | Feature |
| --- | --- |
| Choose one answer or several | `single` and `multi` |
| Type freely | `text` questions, or `Type your own` on option questions |
| Understand a choice first | Notes and Elaborate |
| Repair a bad question | Live `single` ↔ `multi` (`t`) |
| Reopen a form | `/answer:again`, `/ask:replay` |

### Commands

| Command | What it does |
| --- | --- |
| `/answer` | Extract questions from the latest completed assistant message |
| `/answer:again` | Reopen the latest `/answer` form on this branch |
| `/ask:replay` | Reopen the latest `ask_user` form on this branch |
| `/ask-settings` | Settings overlay; `?` inside a form opens the same overlay |

These commands are TUI-only. Replay is branch-aware. Non-TUI callers get `status: "unavailable"`.

## Contract

Input: `{ title?, questions: [{ id, label?, prompt, type: single\|multi\|text, options? }] }`.

- `text` questions have no options.
- `single` / `multi` need real options. Do not invent filler.
- Recommended options are labeled, never preselected.

Output:

- `status`: `submitted` | `elaborated` | `cancelled` | `unavailable` | `invalid`
- `answers[id]`: `{ values, labels, customText?, note?, optionNotes? }`
- typed text is never merged into option `values`
- `unanswered: id[]`
- elaborate carries only what to explain and which answers to keep

Config: `~/.pi/agent/extensions/pi-ask.json`

See [configuration](./docs/configuration.md) and [contract](./docs/contract.md).
