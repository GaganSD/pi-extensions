# pi-subagents

## Subagents benchmark · 3 seeded trials per model

**Results pending:** 5 workflow patterns × 2 models × 3 trials, compared with
[`nicobailon/pi-subagents`](https://github.com/nicobailon/pi-subagents).
No live trials have been scored yet.

| Metric | `@gagansd/pi-subagents` | `nicobailon/pi-subagents` |
| --- | ---: | ---: |
| Unpacked package size | — | — |
| Estimated startup declared-context tokens | — | — |
| Estimated delegation-active declared-context tokens | — | — |
| Dynamic workflow patterns verified | — / 5 | — / 5 |
| Successful workflow episodes | — / 30 | — / 30 |

### Token usage · median of 3 five-pattern suites

| Model · thinking | `@gagansd/pi-subagents` | `nicobailon/pi-subagents` | Change |
| --- | ---: | ---: | ---: |
| Kimi K3 · medium | — | — | — |
| Grok 4.6 · medium | — | — | — |

Declared-context figures are character proxies for system/tool declarations,
not billing counts; on-demand guide reads are excluded here, included in total usage.
Token usage includes reported parent **and child** usage, including cached tokens;
it is not a dollar-cost estimate. Package size uses pinned local release builds.
Unknown/aborted usage is not free. Token cells and savings remain withheld unless
completion and complete accounting can be independently reconciled.
[Protocol, prompts, model routes, and measurement boundaries](../benchmarks/README.md).

## What it does

- Delegate bounded work from one parent session to worker and reviewer children
- Fresh native Pi sessions, session-bound, no nested delegation
- `subagent` tool: run (1–4 tasks), list, status, steer, stop, reply
- `/subagents` to attach, steer, reply, or stop
- Live widget for running children
- Markdown agent profiles
- Local reports and transcripts
