# Vision

## One agent, focused native sub-agents

This is a small, personal Pi delegation package. One interactive Pi session can
ask a worker to implement a bounded task or a reviewer to inspect it, see their
progress, answer questions, steer or stop them, and collect local reports.
The agent remains the orchestrator and decision maker.

The bundled roles are **worker** and **reviewer**. Additional roles are trusted
Markdown files, not new execution engines.

## The boundary is the product

There is one execution path: fresh Pi SDK sessions inside the owning agent
process. Launches are asynchronous but session-bound. They do not survive agent
exit, reload, or session replacement. Old artifacts are evidence, not permission
to resume work. There is no detached runner, durable queue, recursive delegation,
workflow language, mission ledger, scheduler, or external agent adapter.

The supported host is stable local npm Pi 1.x (>=1.0.0, <2.0.0) on Node in
interactive mode. Minor and patch upgrades remain supported; prereleases and
new major versions require compatibility review. Sub-agents receive
only package-owned tools and Pi builtins; no ambient extensions, MCP servers,
skill catalog, or copied agent conversation. Required capabilities or policies
that this boundary cannot provide must block the task rather than be dropped.

## Authority and evidence

Delegate only when the operator requests it, directly or through applicable
instructions. Complexity is not authorization. The agent project must be trusted to launch.
Named sub-agent working directories are the agent's choice and do not prompt again.
Applicable global and project instructions, exact model selection, and bounded
capabilities matter.
Inspection roles have no shell or file-writing tools. Editing roles have the
host's OS permissions; neither a tool allowlist nor a working directory is an OS
sandbox.

Every live run must remain visible and controllable by its exact owner. Concurrency,
cumulative admissions, task duration, and previews are bounded. Questions cannot
wait forever. Uncertain cleanup remains visible and retains its workspace slot.

A completed run means a sub-agent settled and its report was saved, not that the work
is correct. Preserve transcripts, errors, and reported usage. Do not promote a
sub-agent's claims into verified evidence. The agent runs checks, commissions review
when requested, and decides whether the task is accepted.

## Human conversations, not a diagnostic dashboard

Make switching among the agent and its sub-agents feel like editor navigation.
Focus and activation are separate. Use human names in normal surfaces; retain
exact IDs for routing and on-demand evidence. Preserve drafts, native parent
editor state and readable conversations. Cooperative layout owners lend their
own slots; unavailable host capabilities require a disclosed fallback, not
private container discovery or damage to another extension's UI.

## Compose before inventing

Reuse Pi's agent loop, sessions, tools, model/auth services, and events. The agent
sequences ordinary batches. Existing Git worktrees can be passed as working
directories; the package does not allocate, merge, stage, or delete them.

Use one small tool contract and one human control command, backed by the same
run manager. Keep configuration and Markdown profiles explicit. Do not add a
second path when a normal Pi action or a task brief already expresses the need.

## Stay small

No automatic fallback to another model, harness, or execution mode. No automatic
reviewer on every edit, no transcript uploads, and no CI, merge, release, or
project-management policy. Do not add a second execution path to recreate work
the agent can already do with ordinary Pi tools.

## Acceptance

Judge changes by whether they improve useful delegation with the same or better
control, evidence, and responsiveness. Measure hot-path work. Prefer event-driven
status over filesystem scans. Initial source budgets are at most 40 TypeScript
files and 20,000 physical source lines, excluding tests. Budgets are ceilings,
not goals; safety and clarity win over gaming line counts.

Keep the MIT license. On completing package changes, synchronize/install reviewed
changes into the operator's local Pi setup and smoke-test them, preserving unrelated
local edits. This explicitly authorized dogfooding is not npm publishing; do not
publish unless the operator explicitly requests it.
