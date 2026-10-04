<h1 align="center">pi-subagents</h1>

<p align="center">
  Small, session-bound Pi delegation with worker and reviewer agents
</p>

<p align="center">
  <a href="https://github.com/GaganSD/pi-extensions/actions/workflows/ci.yml"><img src="https://github.com/GaganSD/pi-extensions/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://www.npmjs.com/package/@gagansd/pi-subagents"><img src="https://img.shields.io/npm/v/@gagansd/pi-subagents.svg" alt="npm" /></a>
  <a href="https://github.com/GaganSD/pi-extensions/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT" /></a>
</p>

## Benchmark

**Kimi K3 · medium is independently reconciled.** Grok 4.6 is still collecting.
Compared with [`nicobailon/pi-subagents`](https://github.com/nicobailon/pi-subagents).

| Metric | `@gagansd/pi-subagents` | `nicobailon/pi-subagents` | Reduction |
| --- | --- | --- | --- |
| Package Size | **103.35 KB** | **11.60 MB** | **99.11%** |
| Initial Token Overhead | 718 | 6,158 | **88.34%** |
| Dynamic Workflow Patterns Supported | 15 / 15 | 15 / 15 | - |
| Avg Tokens (Kimi-K3 · k@3) | 331,346 | 638,964 | **48.14%** |
| Avg Tokens (Grok-4.6 · k@3) | — | — | — |

Protocol and measurement boundaries: [`benchmarks/README.md`](../benchmarks/README.md).

## Installation

```bash
pi install npm:@gagansd/pi-subagents
```

Then `/reload`. From a clone of this repo: `pi install .` at the repo or package root.

Requires interactive npm Pi **1.0.x**.

## Features

- Delegate bounded work from one parent session to worker and reviewer children
- Fresh native Pi sessions, session-bound, no nested delegation
- `subagent` tool: run (1–4 tasks), list, status, steer, stop, reply
- `/subagents` to attach, steer, reply, or stop
- Live widget for running children
- Markdown agent profiles
- Local reports and transcripts
