# Changelog

## Unreleased

### Fixed

- Support Pi 1.4.0's native MCP configuration validation, removing the sidebar's false `1 Error` when no servers are configured. Accept BOM-prefixed MCP configuration files as Pi 1.4.0 does; unsupported host versions still report unknown state.

## 0.1.17

Slimmer README with fast-loading screenshots and session lifecycle stability fixes.

### Changed

- The Claude Code-style tool transcript is now the default for the `tool-cards` surface. Set `"toolStyle": "default"` in `pi-slate.json` and `/reload` to restore Slate's original cards.

### Fixed

- Stopped Slate from crashing Pi after `/new`, fork, session switch, or `/reload`: render loops, timers, and deferred callbacks now treat a stale session context as absent and fall back to the last live theme instead of throwing mid-paint.
- Cancel pending prompt-picker UI and bug-report feedback when their owning session shuts down, including shortcut contexts without stale-accessor guards.

## 0.1.16

Release the current extension updates together.

### Security

- Pin the transitive `undici` dependency to 8.12.2 in every package lock to clear critical and high-severity Snyk findings from the Pi SDK development tree.

### Highlights

- Slate adds the opt-in Claude Code-style tool transcript and focused prompt-layout refinements.
- Automode releases its decision-model panel and safety updates, including the breaking beta configuration rename from classifier settings to `decisionModel`.
- Ask, Subagents, and Web Search receive the dependency security refresh.

### Added

- Optional Claude Code-style tool transcripts with compact statuses, result summaries, diff counts, and grouped call trees while preserving Pi's native expanded renderers.
- Quiet Workbench refinements: bordered sidebar/context meter, turn-completion receipts, cleaner header, safer image tokens, and a focused prompt with directory/branch, resource cost, context, and model metadata.

### Changed

- Simplified session identity to `Session <id> · PID <pid>`, reorganized usage/resource rows, aligned prompt and sidebar chrome, and made `/slate theme default` restore Pi's system theme.

### Fixed

- Removed duplicate focused-mode cost metadata, false native-read conflict warnings, and transcript grouping/rendering issues found during review.

### Security

- Updated the development dependency lock to `undici` 8.12.2 to clear Snyk's critical/high findings.

## 0.1.15

Pick the composer's working animation instead of always getting the wave.

### Added

- Working indicator styles: `/slate progress [waves|dna-helix|snake|cylon-scanner]`, also in the `/slate` menu. `waves` stays the default; `dna-helix` turns a double helix, `snake` glides an ornate diamondback through the slot, and `cylon-scanner` sweeps an `==` eye along a bracketed track. The choice saves to `pi-slate.json` as `progress` and applies immediately.

### Changed

- The snake and cylon-scanner indicators grow to the composer border's width budget, capped at their natural size; the wave and helix keep the word-sized seven columns.
- Indicator glyphs render upright — the animation no longer inherits the old working word's italic.

## 0.1.14

A cleaner, theme-consistent workbench.

- Sidebar: blends into the terminal with no panel background, a one-line shaded context meter, de-cluttered MCP/Skills rows (just a status dot and name), and a foldable Prompts section with keyboard navigation
- New working indicator: a rolling sine wave in the composer border, with the host working message restored when it stops
- Switching themes restyles the whole interface consistently — headings, inline code, links, and the context bar all follow your theme's accent (Tokyo Night inline code is its signature blue again; Black Metal uses its rose accent)
- Diffs follow your theme: tinted from your palette with matching syntax highlighting
- Prompt editing: image placeholder tokens delete atomically, and select-all plus shift+backspace/delete clears the whole prompt

### Changed

- Cleaner sidebar: blends into the terminal with no panel background; a one-line context meter with a shaded track replaces the old context rows; MCP and Skills rows show just a status dot and the name — redundant enabled/disabled/available labels, source columns, and scroll counters are gone; Prompts section gains a keyboard fold menu and completions.
- New working indicator: a rolling sine wave in the composer border replaces the status word, and the host working message returns when it stops.
- Consistent theming: switching themes restyles the whole interface — sidebar headings, inline code, links, the context bar, and diffs all follow your theme's accent. Tokyo Night inline code uses its signature blue instead of a mismatched cyan; Black Metal code and links use its rose accent; diffs are tinted from your palette with matching syntax highlighting. Themes are now built from a single source of truth, keeping every shipped theme consistent.
- Prompt editing: image placeholder tokens delete atomically, and select-all plus shift+backspace/delete clears the whole prompt.

## 0.1.13

Quiet Slate workbench: Tokyo Night default, restored Pi header, rail cache/rate, slim image preview, hide leftover peeks, and a single new-session chip. Settled sub-agents leave the roster and publish display-only dashboard snapshots.

### Added

- Tokyo Night as the default theme choice: `/slate theme default` or `/slate theme tokyo-night`. Existing theme selections are not overwritten on load; explicit Catppuccin default/style aliases remain available.
- Header restores the stock Pi mark, version, model, path, update hairline, and `✓ New session started`. Composer keeps project/branch and model.
- Rail usage lane now includes Cache, Uncached, and Rate. Commands stay behind `/` and `/slate session commands`.
- Short/narrow fullscreen layouts hide the rail below 30 rows or 100 columns, preserve preferences and previews, and return condensed context/cost metadata to the composer.
- Native MCP configuration parity verified for Pi 1.1.0; unsupported host versions still report unknown state.

### Changed

- Composer shows project/branch and model on the frame. Density still restores after the host copies native padding. Native cursor, draft, paste, selection and working/thinking behavior are preserved.

### Fixed

- Unpinned image previews now hide when the caret leaves the image token; previously the shelf stayed painted until `[clear]`.
- Image preview chrome is just Preview plus `[open]` `[copy]`; the caret/pin chips, filename caption, and `[clear]` control are gone.
- With `header` selected, `/new` no longer duplicates `✓ New session started` in the chat transcript; the chip lives only in the header. Stock update cards and ordinary chat remain untouched.

## 0.1.12

Support stable Pi 1.x and replace diagnostic subagent navigation with human conversations.

- Accept Pi 1.x hosts, including 1.1, in peers and the runtime guard. List supported thinking levels when a batch is rejected; no silent model or thinking fallback.
- Add a focusable roster, dedicated wrapped conversations, unread completions, and bounded Recent. Down hands off only after normal editor navigation; Enter/Space opens.
- Let Slate lend its owned fullscreen chat slot while keeping the sidebar and original editor/chat objects. Disclose an opaque full-viewport fallback when that workspace is unavailable.
- Preserve drafts, exact-question targeting, parent native undo, and confirmed Stop during sends. Failed mounts release the loan; overlay focus restore stays with the host.
- Keep configured Down/select keys on the roster after handoff, page saturated lists, tick live elapsed, show the current tool, and hit-test only painted action buttons.

### Added

- Versioned UI-only conversation bridge for pi-subagents: editor-owned Down
  boundary handoff and scoped lending of Slate's fullscreen chat slot. Preserve
  sidebar and original editor/chat objects, yield to parent dialogs, and release
  leases without taking unselected surfaces or model authority. Same-TUI editor
  remounts keep the Down handler and an open conversation loan.

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
