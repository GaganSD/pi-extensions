# Changelog

## Unreleased

- Refresh the Pi 1.0.0 and TypeScript 7.0.2 dev pins and validate packaged imports with the TypeScript 7 scanner

## 0.2.0

Improve code fallbacks and first-run setup.

- Keyless Sourcegraph search for public code
- Continue when one code source is empty instead of failing the tool
- Reuse `gh` auth for GitHub, pinned to github.com
- One-time TUI setup prompt for existing Exa, GitHub, and Parallel credentials
- Pin one Pi classifier (`provider`/`model`); drop gateway ladders and remapped Jev IDs
- Production audit on publish; host Pi peers are optional so install stays audit-clean

## 0.1.0

First public release as `@gagansd/pi-web-search`.

- `web_search`, `code_search`, and opt-in `multi_search`
- Keyless Exa web, Parallel MCP fallback, and grep.app code
- Optional Jev ranking, filtering, and coverage checks
