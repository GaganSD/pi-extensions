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

These frozen figures are from a prior measured campaign, not measurements or a
rebenchmark of this new release's changed artifact. Both models ran through the
same five dynamic workflow tasks using different subagents packages. See the
[benchmark methodology](https://github.com/GaganSD/pi-extensions/blob/main/benchmarks/README.md).

## Installation

```bash
pi install npm:@gagansd/pi-subagents
```

Then `/reload`. Supports stable Pi **1.x** (`>=1.0.0 <2.0.0`), including **1.1.x**,
using the local npm installation on Node in interactive mode. Prereleases, Bun,
and print/RPC/standalone hosts are not supported.

## Features

- Delegate bounded work from one agent session to worker and reviewer sub-agents
- Fresh native Pi sessions, session-bound, no nested delegation
- `subagent` tool: run (1–4 tasks), list, status, steer, stop, reply
- `/subagents` to attach, steer, reply, or stop
- Focusable worker roster, dedicated conversations, unread completions and Recent
- Supports Markdown agent profiles
- Local reports and transcripts

### Model and thinking selection

Model and thinking resolve from the task, then the profile, then the owning agent.
Models can support different thinking levels. If a selected level is unsupported,
the batch is rejected before any sub-agent launches and the error lists the valid
levels. Set `tasks[].thinking` or the profile's `thinking` explicitly; the package
never silently falls back to a different model or thinking level.

### Human navigation

Rows use stable names such as `Worker 1 · Implement the parser · Running`.
Ordinals distinguish duplicate roles and never renumber when a sibling finishes.
Run/session UUIDs and PID are not primary navigation labels.

- **Down at the editor boundary** focuses the roster, without opening anything
  (`tui.editor.cursorDown`, Down by default). Native movement, history,
  autocomplete and selection run first. If Down still moves your caret or clears
  a selection, press it again after that movement finishes.
- **Up/Down** selects; **Enter/Space** opens. **Esc**, or Up from the first row,
  returns to the original editor. Typing returns there with that input intact.
- Click selects; double-click opens. `/subagents` remains the portable entry point.
- In a thread, Space/arrows edit normally. **Tab/Shift+Tab** moves among message,
  conversation and actions; **PageUp/PageDown** scrolls. **Esc/Back** returns.
- **Details** exposes technical evidence; **Tools** expands tool output;
  **Older/Latest** pages conversation history. **Stop** requires confirmation and
  stays available independently of an in-flight send.

The thread paints the whole conversation workspace, not a translucent diagnostic
popup. With cooperative Slate and a compatible fullscreen Pi 1.1+ host, it borrows
Slate's chat slot while retaining its sidebar. The sidebar still describes the
parent workspace; worker-specific usage/workspace is in Details. Parent dialogs
reclaim the workspace without losing focus, and the worker draft is retained.

Without an owned workspace bridge (plain Pi, regular mode or older hosts), an
opaque full-viewport conversation is the disclosed fallback; it does not claim
sidebar preservation. If an offered workspace becomes unavailable or fails to
mount, a warning and thread note disclose the fallback. Other custom editors are not replaced or assigned global
Down interception. The original main editor/chat objects survive switching,
including native undo/paste/cursor state and background parent output.

Per-run drafts and reading positions survive switching. Send failures keep the
text; success clears only the submitted revision. A draft bound to an old question
cannot silently answer a replacement question. Completions never jump focus:
unread/selected results stay in the roster; viewed results collapse into bounded
**Recent** after you leave their selection. Large rosters keep every live worker
in the idle window, show unread/hidden counts, and page through all entries with
focused Up/Down navigation. Only a focused, displayed thread marks results read. Finished means a saved report, not
verified work.

### Telemetry and evidence

**Details** shows exact run/session IDs, shared process PID, cwd, model/thinking,
context estimate, usage and artifact paths. `/subagents <run-id-or-prefix>` still
routes by the manager's run UUID, never a native session ID. Exact machine-facing
JSON and saved `run.json`/reports/transcripts are unchanged.

Sub-agents are **in-process native Pi SDK sessions**, not separate worker
processes. Context occupancy is Pi's estimated current usage divided by the
selected context window, not cumulative billed tokens. Unknown remains unknown;
real zero and values above 100% are preserved. Estimates refresh at finalized
lifecycle/compaction boundaries, never on streamed tokens or paint.

Conversation pages are asynchronous bounded reads of finalized messages. Long
entries/older content disclose omission; original transcript/report paths remain
available in Details. Rendering does no filesystem reads or model calls.
