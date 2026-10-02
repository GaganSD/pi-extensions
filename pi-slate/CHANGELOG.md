# Changelog

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
