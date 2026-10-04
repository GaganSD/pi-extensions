# pi-subagents

## Subagents benchmark · 3 seeded trials per model

**Kimi K3 · medium is independently reconciled.** Grok 4.6 is still collecting. 
Compared with [`nicobailon/pi-subagents`](https://github.com/nicobailon/pi-subagents).


| Metric | `@gagansd/pi-subagents` | `nicobailon/pi-subagents` | Reduction |
| --- | --- | --- | --- |
| Package Size | **103.35 KB** | **11.60 MB** | **99.11%** |
| Initial Token Overhead | 718 | 6,158 | **88.34%** |
| Dynamic Workflow Patterns Supported | 15 / 15 | 15 / 15 | - |
| Avg Tokens (Kimi-K3 · k@3) | 331,346 | 638,964 | **48.14%** |
| Avg Tokens (Grok-4.6 · k@3) | — | — | — |

## What it does

- Delegate bounded work from one parent session to worker and reviewer children
- Fresh native Pi sessions, session-bound, no nested delegation
- `subagent` tool: run (1–4 tasks), list, status, steer, stop, reply
- `/subagents` to attach, steer, reply, or stop
- Live widget for running children
- Markdown agent profiles
- Local reports and transcripts
