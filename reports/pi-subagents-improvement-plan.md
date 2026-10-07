# pi-subagents improvement plan

> Audit baseline: monorepo commit `4f1f37b` (before this branch's changes). File/line references describe that snapshot and Pi 1.0.0 dependencies. Findings are source-reviewed, not executed reproductions. The schema and terminology changes were subsequently implemented and validated in `827ed08` (69 passing tests). The separately authorized PID/native-session/context widget telemetry was implemented in `de670a6`, including exception isolation for optional estimates/observers. The revised package passes 79 tests against both Pi 1.0.0 and installed Pi 1.0.4. Remaining phases are proposals, not approved implementation scope. The operator has approved synchronization into `~/GitHub/pi-subagents`, preserving unrelated local edits.

## 1. Verdict

**Keep the architecture; harden policy loading, cancellation, and human controls before expanding features.**

The package already has useful foundations: serialized admission, canonical workspace conflict checks, exact-owner controls, bounded previews, retained cleanup fences, native SDK settlement checks, and local evidence. The inspected tests address many meaningful failure paths—not merely happy-path delegation.

The highest-value product improvement is **making existing delegation easier to understand and control**, not adding another execution engine.

The operator-confirmed provider-schema fix and authorized terminology migration should proceed as small, separate changes. Neither requires redesigning the package.

**Evidence qualification:** “Source-verified” below means the behavior follows from inspected code and the stated failure trace. I did not execute these reproductions or run tests.

---

## 2. Prioritized findings

### F1 — Invalid profile overrides silently select a different policy
**P1 · High confidence · Source-verified**

**Evidence:** `pi-subagents/src/agents.ts:36–50` loads bundled definitions first, then silently catches invalid user/project definitions without removing the lower-precedence definition.

**Reproduction trace:**
1. Create a project `worker.md` intended to restrict that role to `mode: inspect`.
2. Introduce invalid frontmatter, an unsupported field, or a currently rejected colon-containing model ID.
3. `parseProfile()` throws.
4. `loadProfiles()` suppresses the error.
5. Launching `worker` selects the bundled **edit-capable** worker instead.

This is more consequential than an omitted catalog entry: an intended restriction can silently become a different capability set. `list` does not disclose the failed override or selected source.

**Smallest useful correction:** Preserve isolation between unrelated profiles, but make an invalid higher-precedence definition disable **that role name** rather than fall back. Return bounded source-specific diagnostics and expose profile provenance.

**Test gap:** `test/contract.test.ts:40–65` covers valid precedence and parser rejection separately, not invalid-override launch behavior.

---

### F2 — Unreadable instruction files can be omitted without blocking the task
**P1 · High confidence in the inspected Pi 1.0.0 dependency · Source-verified**

**Evidence:**
- `pi-subagents/src/session.ts:72–79` uses `DefaultResourceLoader`, then checks only extension-loading errors.
- `pi-subagents/node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.js:115–134` catches instruction-file read failures, prints a warning, and continues.
- `pi-subagents/VISION.md:21–24,31–32` requires applicable policy to be preserved or the task blocked.

**Reproduction trace:** An existing, applicable `AGENTS.md` is unreadable → Pi warns and omits it, potentially continuing to another filename → the package sees no extension error → the sub-agent starts without that instruction file.

**Smallest useful correction:** Make failure to read an existing, selected applicable instruction file a startup blocker. Preserve Pi’s instruction precedence and worktree behavior; ordinary absence of an optional instruction file must remain valid. Prefer structured upstream diagnostics over intercepting console output.

**Test gap:** `test/native.test.ts` checks successful global/project and append-instruction inheritance, but not failed reads.

This is a policy-loading defect, not a claim that working directories or prompts constitute an OS sandbox.

---

### F3 — Stopping before startup completes can skip the eventual sub-agent’s awaited abort
**P2 · High confidence in manager behavior; native operational impact needs fault injection**

**Evidence:** `pi-subagents/src/runs.ts:243,251–253,273–276`.

**Reproduction trace:**
1. Hold `PreparedTask.start()` before it returns/transfers a sub-agent.
2. Call `stop()`.
3. `awaitStopped()` assigns `run.aborting = Promise.resolve()` because `run.child` is absent.
4. Release startup before the cleanup deadline.
5. `execute()` detects cancellation, but reuses that already-resolved abort promise.
6. The eventual sub-agent’s `abort()` is never awaited—or called through the manager—and successful disposal can release capacity.

A fake sub-agent whose `abort()` rejects but whose `dispose()` succeeds demonstrates the false cleanup confirmation.

The native wrapper complicates this further: its abort-signal listener independently calls `session.abort()` and suppresses rejection (`src/session.ts:122–124`), while the exposed abort method calls it again (`:145`). Pi’s `dispose()` is synchronous and is not an awaited-idle substitute.

**Smallest useful correction:** Do not memoize a no-sub-agent placeholder as completed abort work. Share one real, per-sub-agent abort promise between the signal listener and manager; observe its rejection.

**Test gap:** `test/runs.test.ts:175–185` asserts no prompt and one disposal after slow startup, but does not assert that abort occurred or that abort failure retains the fence.

---

### F4 — Artifact cancellation can arrive before publication and still allow the rename
**P2 · High confidence · Source-verified race**

**Evidence:** `pi-subagents/src/artifacts.ts:52–60` checks cancellation before `handle.sync()`, then awaits sync and close before renaming without another check.

**Reproduction trace:** Start replacing existing evidence → pause during fsync → abort the I/O controller → release fsync → the code still renames the replacement over the target.

`RunManager` aborts artifact controllers on deadlines, so this is reachable through the package’s own timeout mechanism. Serialized metadata writes reduce later overwrite races, but do not make this publication cancellation-aware.

**Smallest useful correction:** Recheck cancellation immediately before submitting the rename, after asynchronous sync/close. Explicitly define rename submission as the publication boundary; cancellation cannot reliably retract an already-submitted OS rename.

Also move the post-directory-creation cancellation check inside rollback protection: `artifacts.ts:26–32` currently permits an aborted allocation to leave an empty directory.

**Test gap:** `test/files.test.ts:96–102` tests immediate cancellation, not cancellation during sync/close.

---

### F5 — Cancelling admission does not stop subsequent allocations
**P2 · High confidence · Source-verified responsiveness defect**

**Evidence:** `pi-subagents/src/runs.ts:65,81–93,189–193`.

The caller’s signal is checked before and after the entire allocation loop. Each `store.create()` receives a separate I/O-deadline signal, not the caller’s signal.

**Reproduction trace:** Launch four tasks → cancel while the first allocation is pending → let allocations resolve slowly, each below its I/O deadline → the remaining three allocations still happen → only afterward does launch reject and persist failure records.

No sub-agent starts, which is good, but cancellation unnecessarily performs more I/O and can hold the tool call for roughly four allocation windows plus failure publication.

**Smallest useful correction:** Check caller cancellation before every allocation; propagate it into allocation I/O alongside the I/O deadline. Keep failure-evidence cleanup independently bounded. Preserve the existing distinction: cancellation **after admission** must not implicitly cancel already-launched session-bound work.

**Test gap:** `test/runs.test.ts:149–173` covers pre-aborted admission and shutdown during allocation, not caller cancellation midway through a multi-task allocation.

---

### F6 — Exact model validation rejects legitimate physical model IDs
**P2 · High confidence · Source-verified**

**Evidence:** `pi-subagents/src/validation.ts:24–27` rejects every colon in the model identifier. Exact catalog resolution already occurs in `src/session.ts:47–56`.

**Reproduction trace:** Configure a physical model such as `ollama/qwen2.5-coder:7b` → explicitly select it in a task or profile → validation rejects it before catalog lookup.

Pi’s model documentation explicitly uses colon-containing Ollama IDs. Inherited selection from the owning agent takes a different path and can avoid this validator, making behavior inconsistent.

**Smallest useful correction:** Treat the bounded ID after the first `/` as an exact catalog identifier. Let exact physical-model lookup reject unavailable aliases or suffix constructions. Do not interpret or strip thinking suffixes; thinking remains a separate field.

For profiles, this currently compounds F1 by silently selecting a lower-precedence definition.

---

### F7 — Model/auth snapshots become stale for the remainder of the runtime
**P2 · High confidence · Source-verified**

**Evidence:**
- `pi-subagents/index.ts:199–202` caches a separately created `ModelRuntime`.
- `src/session.ts:51–54` uses its synchronous model/auth snapshot.
- The inspected Pi implementation refreshes configuration and availability through `ModelRuntime.refresh()`, but this package does not call it.

**Reproduction trace:** Attempt delegation before authenticating provider B → private runtime is cached → authenticate B through Pi → retry delegation → cached `hasConfiguredAuth()` still rejects B. Likewise, adding a model and refreshing Pi’s model picker does not refresh this private runtime.

Reloading the extension works around this, but also ends live sub-agents.

**Smallest useful correction:** Give each launch batch a current, cancellable, offline model/auth snapshot without changing an already-running batch’s provider configuration. Compare per-batch runtime creation against safe cache invalidation before choosing the implementation.

Keep extension-only providers and runtime-only credentials explicitly unsupported unless the operator approves a supported inheritance design; do not silently copy credentials or provider behavior.

---

### F8 — The global Down-key hook steals navigation from other UI components
**P2 · High confidence · Source-verified**

**Evidence:**
- `pi-subagents/index.ts:121–130` consumes Down whenever a live run exists and the main editor text has no newline.
- It checks neither editor focus nor another dialog/autocomplete interaction.
- Pi routes these raw input listeners before the focused component: `pi-subagents/node_modules/@earendil-works/pi-tui/dist/tui.js:685–690,739–746`.

**Reproduction trace:** Keep a sub-agent live → open `/subagents`’ run selector or another selection dialog → press Down → the package opens the first live sub-agent instead of moving the selection.

**Smallest useful correction:** Remove the global unmodified-Down interception unless focus can be established through supported APIs. Use a configurable, non-conflicting shortcut plus the existing command/click path. Down inside the package’s own inspector can remain.

---

### F9 — Inspector submissions discard unsent text
**P2 · High confidence · Source-verified**

**Evidence:** `pi-subagents/src/inspect.ts:164–186` clears input before checking `inflight`, run state, or successful delivery.

**Reproduction trace:** Hold a reply’s persistence → type a second message and press Enter → the inspector clears it and returns because another operation is in flight. Failed submissions likewise lose the draft.

**Smallest useful correction:** Retain drafts when busy, rejected, or failed. Clear only the successfully submitted draft, without deleting newer text typed during the await. Show a busy state rather than silently ignoring submission.

The existing target-ID capture is useful and should be retained.

**Test gap:** `test/inspect.test.ts:57–102` exercises rendering and disposal, not interactive submission races.

---

### Known authorized fix — Provider input-schema compatibility
**Operator-confirmed; not independently reproduced here**

Apply explicit root `type: "object"` to the existing input union at `pi-subagents/src/tool.ts:14–21`, preserving its action branches.

Add serialized-provider-request coverage, not just parser tests. **Do not mechanically apply the same change to `OutputSchema`: its valid results include the profile array** (`src/tool.ts:156–173`).

---

## 3. Useful features and unresolved risks

### Recommended features, grounded in current friction

| Priority | Improvement | Evidence and bounded scope |
|---|---|---|
| High | **Profile diagnostics and provenance** | `src/agents.ts:34–54` and `index.ts:169–173` hide failed overrides and omit selected source. Show source, mode, configured model/thinking, and bounded errors—not entire prompts. |
| High | **Readable questions and evidence in the inspector** | `src/inspect.ts:122–132` reduces a question to one terminal-width line and has no scrollable detail view. Provide wrapped/scrollable question text, report/metadata/transcript paths, and delivery warnings using Pi components. |
| High | **Actionable admission feedback** | `src/runs.ts:68–75` gives generic capacity/conflict errors. Include conflicting run IDs/workspaces and remaining concurrent/cumulative capacity. No queue or automatic retry. |
| Medium | **Drafts associated with run/question identity** | `src/inspect.ts:170–174` chooses the current question at submission. If a question changes while the operator composes, warn rather than silently applying the draft to the replacement question. |
| Medium | **Read-only evidence discovery after reload/tree changes** | `index.ts:81–84,140–155` preserves artifact locations but discards the live registry. Offer bounded, on-demand browsing of the same owner’s old evidence; never reconstruct execution authority. |
| Medium | **Explicit local-install tracking** | README documents npm installation only (`README.md:23–29`). Document and verify the operator’s chosen development-to-installed-copy update route, including loaded origin/version and rollback. |

### Confirmed behavior whose impact still needs measurement or integration testing

- **Ambient resources are still discovered, although not loaded.**  
  `src/session.ts:72–77` calls `DefaultResourceLoader.reload()`. In the inspected Pi version, that resolves packages/resources before applying the `no*` flags (`…/core/resource-loader.js:362–363,394–420`), including automatic resource traversal (`…/core/package-manager.js:736,1986–2066`).  
  The traversal is source-verified; noticeable latency is **not measured**. Benchmark large ambient catalogs before replacing the loader. Prefer an upstream selective-discovery option or a small policy-preserving adapter, not a parallel resource framework.

- **Notification submission is not delivery confirmation.**  
  `index.ts:95–98` acknowledges this correctly. Pi’s `sendMessage()` returns `void`; asynchronous failures become host errors (`…/core/agent-session.js:2667–2674`). The manager’s injected-notification rejection test does not establish handling of those host-level failures. Preserve authoritative status/artifacts and show submission uncertainty honestly; do not introduce a durable notification queue.

- **Independent question-tool cancellation needs an explicit state policy.**  
  `src/runs.ts:313–315,340–347` can reject and remove a question without restoring `waiting_for_parent` to another state. A manager fixture can exercise that path; whether ordinary native operation supplies an independently aborted tool signal needs confirmation. Test it before treating it as a demonstrated production defect.

- **Dependency/platform support is narrower than a broad compatibility claim.**  
  The package fixture checks tarball loading with host peers (`test/package.test.ts:12–45`), but does not establish every Pi 1.0.x patch, OS, installation layout, or provider serializer. Keep declared support tied to tested combinations.

---

## 4. Ordered small implementation phases

### Phase 0 — Land already-authorized compatibility work
- Root input-schema type fix.
- Agent/sub-agent terminology migration.
- Preserve persisted identifiers, admission records, artifact paths, and compatibility fences unless deliberately migrated.

**Acceptance:** Existing valid actions still validate; cross-action fields remain rejected; profile-array output remains valid; captured provider request has an explicit object root.

### Phase 1 — Fail closed on selected policy; improve preflight diagnostics
- Fix invalid-profile fallback.
- Detect unreadable selected instruction files.
- Allow legitimate exact model IDs.
- Refresh model/auth state safely per launch batch.
- Add profile provenance and actionable configuration errors.

**Acceptance:** No launch silently substitutes another role policy; unavailable model/thinking fails without fallback; valid colon IDs resolve exactly; missing optional files remain valid; changed credentials/models become usable without ending unrelated runs.

### Phase 2 — Harden cancellation and publication boundaries
- Fix late-start abort ownership and duplicate native abort invocation.
- Propagate pre-admission cancellation.
- Close the fsync-to-rename cancellation window.
- Cover question/reply/stop/notification races with deterministic gates.

**Acceptance:** A late sub-agent is never prompted after cancellation; actual abort failure retains the cleanup fence; cancelled admission stops allocating siblings; aborted pre-publication writes preserve existing evidence; stop/shutdown remains bounded.

### Phase 3 — Make existing human controls reliable
- Replace unsafe global Down interception.
- Preserve drafts and make busy states visible.
- Make long questions fully readable.
- Show evidence paths, current tool, model/thinking, and known notification errors.
- Bind reply drafts to question identity.

**Acceptance:** Other Pi dialogs retain navigation; failed/busy sends lose no text; long questions are accessible without asking the owning agent to read them; stale drafts cannot silently answer replacement questions; stop remains available during pending UI operations.

### Phase 4 — Evidence discovery and measured performance
- Add bounded, same-owner, read-only evidence browsing after reload.
- Measure resource discovery, launch latency, event-loop delay, and retained memory.
- Optimize only demonstrated costs; preserve event-fed previews and avoid filesystem work in rendering.

**Acceptance:** Old artifacts remain evidence only; no resume/control operations are enabled for them; browsing is bounded and on demand; performance changes preserve instruction precedence and capability isolation.

### Phase 5 — Package integration and explicit operator rollout
- Exercise a packed installation with production dependencies and host-supplied peers.
- Verify `yaml` resolution, absence of duplicate host SDK loading, and schema behavior against the supported host.
- Update documentation and changelog.
- Roll out to the operator-approved local installation source; verify loaded origin/version after reload.

**Acceptance:** The installed package—not just the worktree—contains the approved improvements; user profiles/settings remain intact; rollback is documented; no publishing or incidental installation mutation occurs.

---

## 5. Regression-test matrix

Existing coverage below was **inspected, not executed**.

| Area | Existing anchors | Required additions / acceptance |
|---|---|---|
| Admission | `test/runs.test.ts:32–62,149–173` | Cancel during every allocation stage; no later sibling allocation/start; all-or-none admission and post-admission budget semantics preserved. |
| Workspace identity | `test/files.test.ts:19–33`; `test/integration.test.ts:22–77` | Nested non-repositories, aliases, containment, supported case-insensitive filesystems; overlapping readers allowed, any overlapping writer rejected. |
| Trust and profiles | `test/contract.test.ts:40–65`; `test/native.test.ts` | Invalid overriding role must not fall back; unreadable selected policy blocks; trusted owning project still authorizes named target directories without another prompt. |
| Lifecycle/reload/tree | `test/extension.test.ts:53–73`; `test/runs.test.ts:288–328` | Real session-entry admission restoration across abandoned branches; reload/tree with live work, pending startup, and unknown cleanup; no ownership transfer or late wake-up. |
| Cancellation/cleanup | `test/runs.test.ts:175–227,330–367`; native bash cancellation test | Assert actual abort invocation and shared abort promise; late ownership; rejected/hung abort/dispose; retained process fence. |
| Deadlines/publication | `test/files.test.ts:96–102`; `test/runs.test.ts:346–367` | Abort during write, fsync, close, and around rename; explicit publication boundary; late evidence cannot promote a failed/uncertain run. |
| Questions/replies | `test/runs.test.ts:64–116` | Reply versus stop, deadline, persistence failure, notification failure, and replacement question; independent tool-signal cancellation; listener cleanup on every exit. |
| Notifications | `test/runs.test.ts:141–147`; `test/extension-native.test.ts` | Sync throw, rejection, hung submission, answer-before-notification-failure, and actual Pi async delivery failure; never duplicate work to recover a notice. |
| Reports/privacy | `test/files.test.ts:83–102`; action-view tests | Private directories/files under permissive umask; transcript access protection; failed/cancelled evidence; no report/question/error text in turn-triggering notices; no automatic uploads. |
| Provider schemas | `test/contract.test.ts`; `test/extension.test.ts:84–122` | Validate serialized input schemas and representative provider payloads; root object plus preserved union; output arrays unaffected. |
| Exact model/thinking | `test/native.test.ts:90–105` | Colon/slash IDs, unsupported thinking, scoped models, missing auth, login/config changes, explicit task → profile → owner precedence; no substitution. |
| Resource discovery | Native isolation/inheritance tests | Global/project/ancestor and override precedence; SYSTEM/APPEND behavior; absent versus unreadable files; large ambient catalogs; no extension execution or skill catalog exposure. |
| Human UI | `test/inspect.test.ts:57–102` | Selectors/autocomplete/other overlays, slow sends, failed sends, typing during awaits, question replacement, short/narrow terminals, wide characters, disposal/reload. |
| Memory/performance | `test/inspect.test.ts:38–55` | Repeated settlement up to configured `maxRuns`; retained SDK wrappers/listeners; bounded previews; allocation/event-loop measurements with large catalogs. |
| Packaging/install | `test/package.test.ts` | Clean packed installation, production-only dependencies, supported Node/Pi versions, host peer mapping, and operator-selected local update path. |

---

## 6. Decisions needing operator approval

1. **Keyboard behavior:** Prefer a configurable modified shortcut over global Down. Keep the command and mouse paths.
2. **Model/auth inheritance:** Recommend disk-backed native providers with fresh per-batch state. Supporting runtime-only credentials or provider extensions needs an explicit boundary decision.
3. **Historical evidence UX and retention:** Approve read-only browsing separately from deletion. Default to preserving evidence; do not add automatic pruning without an agreed policy.
4. **Tree-navigation cancellation semantics:** Currently `session_before_tree` ends runs even if navigation is subsequently cancelled (`index.ts:153–155`). Retaining this conservative behavior is reasonable, but it should be documented and tested.
5. **Installed-copy update source:** Choose a stable local source path or reproducible package artifact. Do not point the operator’s installation at this temporary audit worktree.
6. **Vision/documentation alignment:**
   - Clarify `VISION.md:71–72`: explicitly authorized installed-copy rollouts are allowed; incidental development mutations remain prohibited.
   - Remove or qualify “Support Cloud Sub-agents” in `README.md:41`; remote runners conflict with the current boundary.
   - Preserve fresh session-bound execution, owning-agent orchestration, no recursive delegation, and no runner/graph/queue/fallback.
   - Clarify that read-only historical evidence browsing does not confer execution authority.

A smaller documentation correction is also warranted: `README.md:18–21` says “Avg Tokens,” while `CHANGELOG.md:17–19` describes **median character-proxy suite counts, not provider billing tokens**. Align the labels and cite the benchmark methodology; I did not verify the benchmark numbers.

---

## 7. Deferred / not worth it

- Cloud/detached runners, durable work queues, recursive delegation, workflow graphs, automatic fallback, and automatic review.
- Worktree allocation, merging, staging, or acceptance automation.
- A new permission/sandbox system inside this package. Keep host-permission limitations explicit.
- A general policy-language or required-capability inference engine. The owning agent must recognize unavailable task requirements.
- Automatic evidence deletion, transcript uploads, and silent profile/settings migration.
- Replacing Pi’s resource loader before measuring the demonstrated discovery overhead.
- Broad UI rewrites or continuous full-transcript scanning. Improve the existing inspector with Pi components.
- Claims of guaranteed notification delivery without host-level acknowledgements.

---

## 8. Limitations and parent checks

I read `AGENTS.md`, `VISION.md`, `README.md`, `index.ts`, every `src/` module, both bundled profiles, all test files/helpers, and relevant package metadata and local Pi documentation/implementations. The diff tool reported no working-tree changes.

I did **not** run shell commands, tests, provider requests, benchmarks, or installation operations; edit files; or inspect the operator’s active package configuration. The provider rejection is accepted as operator-confirmed evidence.

Before accepting implementations, the parent should run:

- `npm run check`
- `npm run pack:check`
- The new deterministic fault/race tests above
- Interactive checks with another Pi dialog open and live sub-agents
- A clean packed-install smoke test
- An explicitly authorized, bounded request through the affected provider
- Verification of the operator’s actual loaded package origin/version after rollout

**Recommended order:** authorized schema fix → policy fail-closed fixes → cancellation/publication hardening → reliable human controls → evidence/performance work → explicit installed-copy rollout.
