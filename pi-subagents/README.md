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


- Delegate bounded work from one parent session to worker and reviewer children
- Fresh native Pi sessions, session-bound, no nested delegation
- `subagent` tool: run (1–4 tasks), list, status, steer, stop, reply
- `/subagents` to attach, steer, reply, or stop
- Live widget for running children
- Supports Markdown agent profiles
- Local reports and transcripts

## Notes: I've stressed tested the library to work well locally. TODO: Improve UI & Developer Experience. Support Cloud Sub-agents. Message me if you feedback, TIA!
