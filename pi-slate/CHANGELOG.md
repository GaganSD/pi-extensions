# Changelog

## 0.1.9

Scroll a long prompt, copy it without wiping the draft, and collapse consecutive `read` cards.

### Composer

- Wheel over an overflowing prompt scrolls hidden lines; a fully visible prompt still gives the wheel to the transcript
- `Ctrl+C` copies a non-empty prompt, including collapsed `[paste #N]` bodies, and leaves the draft in place
- Empty `Ctrl+C` still reaches Pi (`app.clear`)
- `Ctrl+X` stays Pi's `app.message.copy`
- Drop a large prompt with `Ctrl+A` then Backspace, or `Esc` `Esc`
- Drag-select uses Pi's screen selection again
- Composer `│` rails stay out of the highlight and the clipboard
- Copy confirmation is one `Copied!` flash, same as drag-select

### Transcript

- Consecutive `read` cards share one line: `read x.md`, then `read 2 files`
- Expand / `Ctrl+O` lists the paths
- A user message, later-turn assistant text, or any other tool starts a new streak
- Grouping is O(1) per event and one O(N) pass on session restore

### Docs

- README screenshots load from the repo on GitHub; `npm pack` rewrites them to the versioned npm CDN

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
