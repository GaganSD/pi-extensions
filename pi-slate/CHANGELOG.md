# Changelog

## Unreleased

### Added

- Versioned UI-only conversation bridge for pi-subagents: editor-owned Down
  boundary handoff and scoped lending of Slate's fullscreen chat slot. Preserve
  sidebar and original editor/chat objects, yield to parent dialogs, and release
  leases without taking unselected surfaces or model authority.

- Independent surfaces: `header`, `footer`, `editor`, `sidebar`, `tool-cards`, `transcript`. `/slate surfaces` shows the set; `set <names...>`, `full`, and `none` save it for `/reload`.
- Fresh settings select editor, sidebar, and tool-cards; focused mode keeps the selected sidebar hidden. Valid legacy settings without surfaces retain all six and preserve appearance preferences. Invalid settings activate nothing, warn, and preserve the file.
- `/exit` quits Pi, same as `/quit`
- TUI thinking status uses the existing composer edge: `Pondering · 7s · ↑↓42`, with elapsed seconds and an available estimated token rate. Timers stop on thinking end, message boundaries, abort, and shutdown; missing or changed thinking events fall back to native behavior.

### Changed

- Unselected surfaces leave host setters, patches, watchers, and cleanup untouched. Theme/fullscreen are explicit preferences, not automatic install defaults.
- Composer metadata is named `composerMetadata` in settings; the legacy `footer` key is still read and written, and `/slate footer` remains an alias. Footer-slot ownership only hides Pi's footer with the existing zero-row component.
- Image rewrites patch only Slate's composer instance; foreign editors and `Editor.prototype` remain untouched. `/prompts` and thinking timing are editor-scoped; `/exit` is always registered.
- Sidebar and transcript attach independently through a zero-row below-editor widget. No overlay fallback or fullscreen forcing. Sidebar yields to a replacement layout root. Stock notices are no longer deleted.
- Last-writer-wins chrome and first-registration-wins tools are respected without conflict repair. Tool-card registration losses are reported.

### Limitations

- Sidebar/transcript need a compatible fullscreen host. Header/footer ownership cannot be inspected through the host API, so shutdown disposes local resources without clearing chrome; `/reload` resets it.
- Native thinking visibility and streaming labels remain untouched. Settled per-message `Thought 12s` needs a Pi per-message hidden-label API; the current global setter would incorrectly relabel older thoughts.

## 0.1.11

Add a searchable prompt-template picker and optional PID display; improve compact context labels and narrow-terminal rendering.

### Added

- `/prompts` and `Ctrl+Alt+P` open a searchable prompt-template picker. Search by filename, name, description, or body; Enter inserts into the composer without sending. Esc or Ctrl+C leaves your draft unchanged. Pi's configured selection keys are supported.
- Templates are reread when the picker opens. Unreadable files are reported and skipped; missing or empty names fall back to filenames.
- `/slate pid [on|off]` toggles a saved agent process-ID label on the composer's top edge. Off by default; hidden when the frame is too narrow.

### Changed

- Focused-mode context uses `2%/250k tokens · ↑↓42`: usage percentage, context-window size, and estimated streamed tokens per second. Skill and MCP labels are shorter.
- Composer borders keep status and overflow indicators ahead of resource labels and fit narrow terminal widths, including with PID display enabled.

## 0.1.10

Maintenance release: refresh the Pi, TypeScript, and GitHub Actions pins.

- pi-slate: focused mode replaces vertical mode (`/slate focused`); the unused `@earendil-works/pi-ai` and `typebox` peers are dropped
- All packages: Pi dev/peer pins to 1.0.0, TypeScript to 7.0.2, typebox to 1.3.34
- pi-subagents: yaml to 2.9.1
- Actions: setup-node v7.0.0, upload-artifact v7.0.1, download-artifact v8.0.1

### Renamed

- The default sidebar-hidden layout is now focused mode: `/slate vertical` is `/slate focused` (menu, completions, and the saved `focused` config key)
- The saved `vertical` setting is not migrated; focused mode remains the default

### Changed

- Drop the unused `@earendil-works/pi-ai` and `typebox` peers
- Refresh dev tooling to Pi 1.0.0 and TypeScript 7.0.2

## 0.1.9

Scroll a long prompt, copy it without wiping the draft, and collapse consecutive `read` cards.

### Composer

- Wheel over an overflowing prompt scrolls hidden lines without spilling into the transcript at either boundary; a fully visible prompt still gives the wheel to the transcript
- `Ctrl+C` copies a non-empty prompt, including collapsed `[paste #N]` bodies, and leaves the draft in place
- Empty `Ctrl+C` still reaches Pi (`app.clear`)
- `Ctrl+X` stays Pi's `app.message.copy`
- Drop a large prompt with `Ctrl+A` then Backspace, or `Esc` `Esc`
- Drag-select uses Pi's screen selection again
- Leave screen selection untouched; prompt copy excludes frame characters
- Copy confirmation is one `Copied!` flash, same as drag-select

### Transcript

- Consecutive `read` cards share one line: `read x.md`, then `read 2 files`
- Expand / `Ctrl+O` lists the paths
- A user message, later-turn assistant text, or any other tool starts a new streak
- Failed reads remain visible, including failures in a grouped card
- Grouping is O(1) per event and one O(N) pass on session restore

### Docs

- Use Markdown screenshots and stable GitHub URLs so GitHub, npm, and the Pi gallery render all seven images without pack-time README mutations
- Update the package subtitle

## 0.1.8

Syntax-highlighted `edit` and `write` results in the transcript.

- Split before/after for edits at 100+ columns; unified stacked view for writes and narrower panes
- Word-level emphasis on the characters that changed
- 190+ languages via Shiki; unknown types stay readable as plain text
- Colors follow `/slate theme` — Black Metal or Catppuccin Mocha styles
- Compact until you expand the tool card
- Host Pi packages are optional peers, so `pi install` does not pull a second, auditable copy of the agent
- Dev pin is Pi 0.99.0 so `npm ci` is audit-clean

## 0.1.7

- README screenshots served from the npm CDN
- Repository metadata linked in the npm package

## 0.1.6

- Vertical workspace is the default; `/slate vertical` sets it
- Working, compacting, and other editor status stay on the prompt edge
- Select-all, double-escape clear, and click-to-expand paste tokens
- Update notices as a header hairline instead of transcript cards
- Native MCP counts in the context dock
- Catppuccin Mocha styles and Black Metal as the install default

## 0.1.5

Unify Slate chrome and add Catppuccin Mocha themes.

- Prompt, Summary, and Context share one rounded frame
- Six Mocha styles: Default, Quiet, Mauve, Sapphire, Peach, Teal
