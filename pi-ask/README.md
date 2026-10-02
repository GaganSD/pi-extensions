# pi-ask

Gives your agent a way to interview you in a structured form — brainstorming, auth, missing requirements. Structured answers keep the thread small.

One skill (~20-token description), built for context minimisation.

![Multi-select](https://cdn.jsdelivr.net/npm/@gagansd/pi-ask@0.1.2/assets/multi.png)

![Single-select](https://cdn.jsdelivr.net/npm/@gagansd/pi-ask@0.1.2/assets/single.png)

![Text](https://cdn.jsdelivr.net/npm/@gagansd/pi-ask@0.1.2/assets/text.png)

## Install

```bash
pi install npm:@gagansd/pi-ask
```

Then `/reload`.

Releases: [CHANGELOG](CHANGELOG.md).

From a clone of this repo: `pi install .` at the repo or package root.

## Everyday use

The agent calls `ask_user`. `/answer` if it asked in prose instead.

| Need | What you do |
| --- | --- |
| Choose one, or several | `single` / `multi` |
| Type freely | `text`, or **Type your own** on a choice question |
| Understand a choice first | Notes |
| The question is the wrong shape | `t` switches `single` ↔ `multi` |

### Commands

| Command | What it does |
| --- | --- |
| `/answer` | Turn the latest completed assistant message into a form |
| `/ask-settings` | Settings overlay. `?` inside a form opens the same overlay |

TUI-only. Non-TUI callers get `status: "unavailable"`.

## Contract

Input: `{ title?, questions: [{ id, label?, prompt, type: single\|multi\|text, options? }] }`.

- `text` questions have no options.
- `single` / `multi` need real options. Do not invent filler.
- Recommended options get a `description`. Never preselected.
- Typed text is never merged into option `values`.

Output:

- `status`: `submitted` | `cancelled` | `unavailable` | `invalid`
- `answers[id]`: `{ values, labels, customText?, note?, optionNotes? }`
- `unanswered: id[]`

Optional config: `~/.pi/agent/extensions/pi-ask.json`. `/answer` uses the current chat model unless `answer.extractionModels` is set.
