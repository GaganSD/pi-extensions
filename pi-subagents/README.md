# pi-subagents

## Subagents benchmark · 3 seeded trials per model

**Kimi K3 · medium is independently reconciled.** Grok 4.6 is still collecting.
OpenAI Luna was abandoned and is not in this table. Compared with
[`nicobailon/pi-subagents`](https://github.com/nicobailon/pi-subagents).

| Metric | `@gagansd/pi-subagents` | `nicobailon/pi-subagents` |
| --- | ---: | ---: |
| Unpacked package size | 103,349 | 11,602,458 |
| Estimated startup declared-context tokens | 718 | 6,158 |
| Estimated delegation-active declared-context tokens | 718 | 6,158 |
| Dynamic workflow patterns verified | 0 / 5 | 0 / 5 |
| Successful workflow episodes | 15 / 30 | 15 / 30 |

Kimi: **15 / 15** per package across all five patterns. A pattern is fully
verified only after both models’ three seeds pass, so the pattern row stays 0/5
until Grok is reconciled. Episode totals are out of 30 because Grok is pending.

### Token usage · median of 3 five-pattern suites

| Model · thinking | `@gagansd/pi-subagents` | `nicobailon/pi-subagents` | Change |
| --- | ---: | ---: | ---: |
| Kimi K3 · medium | 331,346 | 638,964 | −48% |
| Grok 4.6 · medium | — | — | — |

Kimi token cells are a **consistent character proxy**: each provider request is
rebuilt from the session tree (system/tools + prior visible messages, including
repeated context), then `ceil(JS UTF-16 chars / 4)`, summed over parent and
child sessions. Median of three five-pattern suite totals. Not provider billing.
Provider SDK usage was incomplete on 13/30 Kimi episodes, so that ledger is not
used here.
Declared-context figures are character proxies for system/tool declarations,
not billing counts; on-demand guide reads are excluded here, included in total usage.
Token usage includes reported parent **and child** usage, including cached tokens;
it is not a dollar-cost estimate. Package size uses pinned local release builds.
Unknown/aborted usage is not free.
[Protocol, prompts, model routes, and measurement boundaries](../benchmarks/README.md).
[Protocol, prompts, model routes, and measurement boundaries](../benchmarks/README.md).

## What it does

- Delegate bounded work from one parent session to worker and reviewer children
- Fresh native Pi sessions, session-bound, no nested delegation
- `subagent` tool: run (1–4 tasks), list, status, steer, stop, reply
- `/subagents` to attach, steer, reply, or stop
- Live widget for running children
- Markdown agent profiles
- Local reports and transcripts
