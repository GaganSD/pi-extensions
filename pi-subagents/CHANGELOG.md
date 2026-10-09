# Changelog

## Unreleased

- List the selected model's supported thinking levels in preflight errors, so
  mixed-model batches can be corrected without guessing or automatic fallback.

- Accept stable Pi 1.x, including 1.1.x, in both npm peer dependencies and the
  shared `/subagents`/`subagent` runtime guard. Minor and patch updates no longer
  cause install conflicts or an `Unsupported Pi host` error. Keep the Node-only,
  interactive-host boundary and reject prereleases and new major versions.
- Add host-version, command, and packed-peer regression coverage; retain the
  Pi 1.0.0 development baseline for backward compatibility.

## 0.0.3

Fix provider-neutral tool-schema compatibility and add live native session telemetry.

- Give the `subagent` input schema an explicit object root while retaining its six closed action branches and runtime validation. Resolves the reproduced OpenCode Go/DeepSeek request failure without model-specific exceptions or a Pi-core change.
- Adopt agent/sub-agent terminology. **Migration:** `contact_supervisor` is renamed to `contact_agent`, and `waiting_for_parent` to `waiting_for_agent`; no legacy aliases are retained. Existing run artifacts remain evidence, not resumable sessions.
- Show role, shared owning-process PID, unique native session ID, and current context occupancy in live widget rows. Context estimates remain separate from cumulative billed usage, with exact run UUIDs retained for controls and full identity/usage available in inspection and evidence.
- Cache estimates at finalized native lifecycle boundaries, never on rendering, timer ticks, or individual streaming deltas. Unknown startup/compaction/failed estimates stay unknown; estimator and observer exceptions cannot fail a run.
- Cover prefix collisions, narrow terminals, control-character sanitization, zero/overflow/invalid estimates, cancellation, disposal, and recovery with regression tests.

- Show live shared-PID, native-session, and context rows with best-effort cached
  estimates; estimator failures display unknown usage and observer errors cannot
  fail a run.

- Give the `subagent` input schema an explicit object root for provider-neutral
  compatibility, preserving the closed six-action union and runtime guards.
- Use agent/sub-agent terminology in code, prompts, UI, documentation, and tests.
  Machine contracts now use `contact_agent` and `waiting_for_agent` (no legacy
  aliases); retained run artifacts remain evidence, not resumable runtime state.
- Document reviewed local Pi synchronization and smoke-testing for personal use;
  publishing still requires an explicit request.

## 0.0.2

Maintenance release: refresh the Pi, TypeScript, and GitHub Actions pins.

- pi-slate: focused mode replaces vertical mode (`/slate focused`); the unused `@earendil-works/pi-ai` and `typebox` peers are dropped
- All packages: Pi dev/peer pins to 1.0.0, TypeScript to 7.0.2, typebox to 1.3.34
- pi-subagents: yaml to 2.9.1
- Actions: setup-node v7.0.0, upload-artifact v7.0.1, download-artifact v8.0.1

- Refresh the Pi 1.0.0, TypeScript 7.0.2, and yaml 2.9.1 pins and accept @types/node 26 assertion signatures
- Publish a reproducible comparison of `@gagansd/pi-subagents` against
  `nicobailon/pi-subagents` on five agent-composed workflows.
- Report unpacked package size, declared-context overhead, and character-proxy
  suite tokens (`ceil(JS UTF-16 / 4)`, median of three five-task suites) for
  Kimi K3 and Grok 4.6. These are not provider billing counts.
- Collect each episode in a real interactive Pi TUI. Stall mute sub-agents after
  90s, keep failed episodes in the suite, and leave incomplete evidence in place.
- Add package CI, on-demand npm publish, Dependabot, and secret scanning.
- Set the npm package subtitle to “Tiny yet powerful, benchmarked sub-agents for Pi”.

## 0.0.1

First public release as `@gagansd/pi-subagents`.

- Harden the reviewer Git boundary: reject non-object-id diff baselines and magic
  pathspecs, assert launch HEAD before and after the snapshot, neutralize pager and
  case-insensitive `GIT_*` environment leaks, force a C locale, and preserve stderr/exit
  detail on Git failures. Resolve symlinks before the write-conflict overlap check.
- Fix run lifecycle races: a failed question notification no longer aborts an already
  answered sub-agent, stop deadlines never rewrite a published terminal state, sub-agent abort is
  serialized per run, and metadata writes snapshot at write time and never start after
  their deadline. Stop wake-up turn messages from carrying sub-agent-controlled free text;
  question/error content stays behind status and on-disk metadata.
- Make evidence storage rollback-safe and durable: failed allocations remove the run
  directory, the artifact root is chmod 0700 even when pre-existing, and atomic writes
  fsync the temp file and parent directory. The per-owner artifact root is stable across
  reload and /tree so admitted-run reports stay resolvable.
- Serialize host shutdown behind a lock so a reminted manager never overlaps teardown;
  rebind the Down key when the UI context changes. Inspector disposal always settles the
  attach promise; in-flight send/stop completions can no longer stamp the wrong thread;
  transcript fallback failures surface as a note and retry. Widgets unmount when no live
  runs remain, chrome-row clicks no longer open threads, and later ticks refresh `onOpen`.
- Tighten validation: length/NUL bounds run before trimming (and trimmed values are
  returned), `Object.prototype` is not a plain object, and model ids reject thinking
  suffixes. The model-facing tool schema is a closed per-action union matching the
  request contract, and oversized-result previews narrow defensively and cap run lists.
- One broken user/project agent profile no longer disables the whole catalog, and
  malformed frontmatter errors name the offending file. Retired `historyLimit` settings
  keep their tested strict validation. A torn transcript tail window and an
  entries-less tail are disclosed honestly instead of misparsed or masked.

- Keep the live widget mounted and show natural elapsed time (`12s`, `2m 5s`,
  `1h 2m`). Down or a click on `↓` opens a sub-agent thread; Down again cycles to the
  next live sub-agent or back to the agent.
- Accept optional per-task `thinking` (`task` → profile → agent), persist the
  resolved level on `run.json`, echo model/thinking on launch receipts and
  status-by-id, and identify completion notices with agent plus task preview.
- Shrink model/native results to allowlisted action views: ordered `id` / `cwd` /
  `workspace` launch receipts, compact status, and unverified completion notices.
  Remove redundant indices and constant validation/compliance fields; control
  receipts are `{ ok: true }`. Full run evidence stays on disk and in exact-status details.
- Preserve valid JSON and every run id in oversized text previews; flag clipped
  questions/errors with a metadata pointer instead of slicing serialized JSON.
- Add `list.cwd` for target-specific profile discovery and share discovery within a batch.
- Keep exact run ids addressable until shutdown. Retired `historyLimit` settings
  remain accepted without rewriting configuration.
- Inherit `APPEND_SYSTEM.md` with normal Pi precedence. Transfer cleanup ownership
  before startup validation, and recheck cleanup fences during admission.
- Bound artifact I/O and stop/shutdown waiting. Preserve the cause of uncertain
  cleanup across reload; do not mislabel confirmed cleanup as uncertain when storage fails.
- Preserve available usage on failed/cancelled runs and release settled SDK wrappers.
- Feed inspector previews from finalized sub-agent events. Remove filesystem reads
  from rendering, bound async fallback reads, sanitize terminal controls, and
  keep input visible on narrow/short terminals.
- Let the operator attach through `/subagents`; list every live run and clear the
  widget after settlement. Agent project trust suffices for named working directories.
- Expose one direct/native structured tool with no join, fallback, or resume.
  Document agent-composed fan-in, failed siblings, and committed-range artifacts.

## 0.1.0

- Bundle worker and reviewer only.
- Fresh, session-bound native Pi SDK sub-agents with flat bounded batches.
- Exact-owner status, stop, steer, agent replies, local evidence, and a
  compact run widget backed by one manager.
- Private package. No install-time migration of user profiles or settings.
