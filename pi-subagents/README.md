<h1 align="center">pi-subagents 👾</h1>

<p align="center">
Tiny yet powerful, benchmarked sub-agents for Pi
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@gagansd/pi-subagents"><img src="https://img.shields.io/npm/v/@gagansd/pi-subagents.svg" alt="npm" /></a>
  <a href="https://github.com/GaganSD/pi-extensions/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT" /></a>
</p>

## Benchmark

| Metric | `@gagansd/pi-subagents` | `nicobailon/pi-subagents` | Reduction |
| --- | --- | --- | --- |
| Package Size | **103.35 KB** | **11.60 MB** | **99.11%** |
| Initial Token Overhead | 718 | 6,158 | **88.34%** |
| Avg Tokens for 5 tasks (Kimi-K3 · k@3) | 331,346 | 638,964 | **48.14%** |
| Avg Tokens for 5 tasks (Grok-4.6 · k@3) | 256,451 | 979,286 | **73.81%** |

Both models ran through the same five dynamic workflow tasks using different subagents packages. 

## Installation

```bash
pi install npm:@gagansd/pi-subagents
```

Then `/reload`. Built for Pi **1.0.x**.

## Features

- Delegate bounded work from one agent session to worker and reviewer sub-agents
- Fresh native Pi sessions, session-bound, no nested delegation
- `subagent` tool: run (1–4 tasks), list, status, steer, stop, reply
- `/subagents` to attach, steer, reply, or stop
- Live widget for running sub-agents
- Supports Markdown agent profiles
- Local reports and transcripts

### Live telemetry

Running rows show `worker · PID-12345 01a11744… · 12%/272K`.
Sub-agents are **in-process native Pi SDK sessions**: every row shares the owning
agent's real OS PID, not a separate worker process. The shortened ID is the native
session ID (prefixes expand to distinguish live sessions), **not** the run UUID.
Clicks and down-arrow controls still route by the exact run UUID; the inspector
shows that UUID and the full native session ID. Full IDs and the latest observed
context estimate remain in `run.json`, including failed/cancelled runs.

The percentage is Pi's **estimated current context occupancy** divided by the
selected model's context window, not cumulative billed tokens. Limits use decimal
K/M. Estimates refresh at finalized message/lifecycle/compaction boundaries, not
on each streamed token or widget paint. Unknown startup/usage displays, for example,
`PID-12345 starting · ?%/272K` or `?%/?`; after compaction occupancy may stay unknown
until the next response. Real zero and values over 100% are preserved. Narrow
terminals shorten roles/IDs and drop decoration before context fields. Ask/error/
stop indicators remain useful; elapsed time is in the inspector.

**Note:** I've stressed tested the library to work well locally. TODO: Improve UI & Developer Experience. Support Cloud Sub-agents. Message me if you feedback, TIA!
