# Human / sub-agent UX plan

## Decisions (operator-approved)

- Inline roster below the main editor, followed by a dedicated conversation.
- Down leaves the editor only at its lower navigation boundary. It focuses a row;
  Enter/Space activates it. Never open merely because selection moved.
- Replace the main chat workspace while retaining the Slate sidebar.
- Keep selected and unread completions visible; collapse viewed completions into
  bounded Recent. Stable ordinals never renumber when other runs finish.
- Narrow cooperative Pi/Slate integration is permitted. No private layout surgery
  from pi-subagents, no replacement of another extension's editor.

CEO review: Astra, run 4c6ecb7e-409c-4341-9528-02eced6423d2. Recommended selective
expansion: navigation, readable conversations, preserved context; no new engine.

## Engineering verdict: ship with a host feasibility gate

### Architecture / data flow

The existing RunManager remains the authority. Presentation state owns human
labels, read/unread status, selection, drafts, and scroll positions only. UUIDs
remain machine routing keys. No tool schema, execution persistence, or model
selection changes.

A small versioned event-bus bridge lets the existing Slate layout/editor owner
lend its own left-hand workspace and report a genuine editor boundary. Subagents
never finds/replaces private host containers. Slate keeps its sidebar and the
original main editor/chat objects intact, including cursor, undo/paste state and
scroll position. On close, restore those same objects, not just their text.

The configured `tui.editor.cursorDown` action (Down by default) is processed by
the actual editor first. Handoff requires a focused editor, no active or
just-consumed selection/autocomplete, and no change in public cursor/text after
normal navigation. This lets wrapped lines/history win
without reimplementing their private state. Validate this with real editor tests
before accepting the bridge. Plain Pi can install its own CustomEditor only when
no other extension owns the editor; /subagents remains the portable entry point.
Without a workspace bridge, a clearly documented opaque full-viewport view is a
fallback, never a claim to preserve a sidebar that the package does not own.

### Blockers

1. Demonstrate focus handoff without stealing autocomplete, dialogs, history or
   wrapped-line navigation.
2. Demonstrate chat-slot replacement and faithful restore while parent output
   continues and Slate resizes. Keep one layout owner.
3. Preserve drafts during busy/failed sends and bind replies to exact questions.
4. Do not lose a selected run on completion or create cross-run send authority.

### Implementation sequence

1. Cooperative workspace/editor bridge and deterministic integration tests.
2. Stable human identities, focusable roster, unread/Recent presentation.
3. Replace inspector with wrapped, scrollable conversation + composer/actions;
   diagnostics become an explicit view, not default headings.
4. Separate bounded async conversation reader from compact model-facing previews.
   Page older content on demand; disclose clipping and retain artifact paths.
5. Human tool/notice renderers without changing model-facing JSON contracts.
6. Regression tests, local integration install, keyboard/resize smoke tests.

### Interaction contract

Main editor -> Down at boundary -> roster. Up/Down moves selection only; Up from
first row or Esc restores the main caret; Enter/Space opens. Mouse selects first,
then an explicit activation opens. In a thread, arrows/Space edit text normally;
Tab moves among composer, transcript and actions. Esc returns to the originating
roster row. Back/Details/Stop are explicit actions; Ctrl-X retains editor meaning.
Opening a question focuses Reply; settled threads cannot send, but keep drafts. No autofocus
jumps on completion/questions, no reordering while navigating. Stop is available
independently of an in-flight send.

### Tests / acceptance

- Stable duplicate-worker labels, no technical IDs/PID in normal human surfaces.
- Focus vs activation; mouse/keyboard parity; editor cursor/undo retained.
- Wrapped drafts, history, autocomplete, other dialogs, IME, configurable keys.
- Full readable questions, scrolling/older pages, expandable tool output,
  narrow/short terminals, Unicode, sanitization, resize/theme changes.
- Successful/failed/busy/newer-draft sends; replaced questions and settled runs;
  stopping while sending; stale async reads; close/reload/session teardown.
- Completion/read state and bounded Recent; exact machine contracts unchanged.
- Pi 1.0 baseline and installed Pi 1.1, with and without Slate.

Idle rosters paint a bounded window with every live worker pinned and explicit
unread/hidden counts; focused navigation reaches all retained entries without
renumbering or switching the selected ID on completion. Failed/unpainted threads
do not mark results read. Failed or withdrawn offered mounts disclose the opaque
fallback, and overlay focus acquisition/restoration remains the host\'s job.

All rendering uses cached data: no filesystem reads or model calls in paint.
Keep I/O, messages and retained UI state bounded. No Pi source fork, new runner,
queue, recursive delegation, or automatic acceptance of worker claims. Host
limitations must be disclosed instead of silently weakening the chosen UX.

## Validation / host limits

- Pi-subagents: full typecheck and tests against Pi 1.0 and 1.1; lint and packed
  package loading pass. Machine JSON/evidence/execution contracts are unchanged.
- Slate: tests on both Pi versions; baseline typecheck/lint pass. Pi 1.1
  production source typecheck passes; its pre-existing unrelated test fixtures
  lack new `durationMs`/`outputPad`/`setProgramStatus` fields, so the full Slate
  fixture typecheck remains a separate compatibility chore, not a UI defect.
- Real offline Pi 1.1 PTY: Slate pane/sidebar replacement, plain opaque fallback,
  separate focus/activation, exact-question reply, worker draft reopening,
  completion, resize and preservation of native main undo history pass.
- Real parent-dialog handoff restores the parent workspace without stealing
  dialog focus; reopening the worker retains its unsent draft.
- Cooperative pane lending requires an owned fullscreen slot and public focused-
  component capability. Older/incompatible hosts use the disclosed fallback.
- Text/IME input is forwarded to the native editor rather than reimplemented;
  Unicode, wrapping, history and autocomplete guards are regression-tested.
  A real IME/clipboard-image terminal matrix was not exercised by the PTY.
