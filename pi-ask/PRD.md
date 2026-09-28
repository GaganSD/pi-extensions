# PRD: pi-ask

First-party TUI clarification for Pi. Replaces `@geoqiao/pi-ask` for personal daily use.

Source: GPT-5.4-astra [CEO review](./ceo-review.md) (`plan-ceo-review`, selective expansion).

## Problem

Own the clarification experience I already rely on, including repair when the agent asks badly, without depending on a third-party package.

A clone that only answers well-formed questions will fail. I will keep going back to pi-ask.

## User

Me, in Pi TUI, every day. Not RPC clients. Not a public integration platform.

## Promise

Answer, correct, or question the agent’s question without losing the thread or repeating settled decisions.

## Decisions

| Open question | Call |
| --- | --- |
| Compatibility | Personal replacement with a documented new contract. Not drop-in `ask_user` parity. Uninstall `@geoqiao/pi-ask` during the trial. Do not register the same tool name while both are installed. |
| Repair | v1 keeps `/answer`, notes, Elaborate, custom text, and live single/multi correction. Frequency is measured in the trial, not assumed. |
| Recovery | v1 is branch-aware `/ask:replay` (and `/answer:again`). Automatic startup/resume/fork reopen is v1.1. |
| Code | Derivative of selected pi-ask code under MIT, with attribution. Not a clean-room rewrite. |
| Config | New path. Copy extraction models and the few live behaviour flags once. No `eko24ive` migration framework. Do not rewrite old files. |

## Jobs

1. Answer a well-formed question quickly.
2. Repair a bad question without restarting.
3. Carry settled answers forward.

## v1 in

- Tool + skill: ask only for material gaps or an explicit interview. Policy is advisory.
- TUI form: single, multi, custom text, notes, review (submit / elaborate / cancel).
- First-class free-text question. No fake option required.
- `/answer` extracts the last assistant message into a form. Preserve offered choices; never silently truncate. Fail visibly.
- Live type change (`single` ↔ `multi`) with confirm when it would drop selections.
- Branch-aware replay of the last tool form and last `/answer` form.
- Keyboard-first editing, `@` file refs, dirty-dismiss protection, no auto-submit.
- Waiting notification (bell).
- Recommended options are labeled, never preselected.
- Honest outcomes: answered, unanswered, needs explanation, cancelled, invalid, no UI.

## v1 out

- Interactive RPC. Non-TUI returns needs-input.
- Remote event bus.
- Preview question type. Use descriptions.
- Global present-single-as-multi.
- Config schema migrations and legacy paths.
- Enforced `required`. Drop the field. Unanswered stays unanswered. Cancel is not approval.
- Auto-reopen on session start.

## Contract

Input: `{ title?, questions: [{ id, label?, prompt, type: single|multi|text, options? }] }`.

`text` questions have no options. `single`/`multi` need real options. Do not invent filler.

Output, compact and truthful:

- `status`: `submitted` | `elaborated` | `cancelled` | `unavailable` | `invalid`
- `answers[id]`: `{ values, labels, customText?, note?, optionNotes? }`
- typed text is never merged into option `values`
- `unanswered: id[]`
- elaborate carries only what the model needs to explain and which answers to keep

Normal `ask_user` does not call an extraction model. `/answer` does, on demand, with the configured fallbacks.

## Success

A short daily trial with `@geoqiao/pi-ask` removed. I do not reinstall it for repair, explanation, or replay. No accidental submits. No lost in-form work. No extra interviews for settled choices.

Judge interruptions and re-entry, not file count.

## Trial cuts

If unused after the trial, drop in this order: live type change, Elaborate, `/answer`. Do not cut them before the trial.

## Name and files

- Package: `pi-ask`
- Tool: `ask_user`
- Commands: `/answer`, `/answer:again`, `/ask:replay`, `/ask-settings`
- Config: `~/.pi/agent/extensions/pi-ask.json`
- Seed from current extraction models (luna, sol, grok-4.6) and: no auto-submit, dirty-dismiss on, review double-press on, type change `t`

## Attribution

Keep MIT notices for reused geoqiao / eko24ive source. Operational names are first-party only.
