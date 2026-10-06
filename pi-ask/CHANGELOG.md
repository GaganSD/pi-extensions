# Changelog

## Unreleased

## 0.1.3

Maintenance release: refresh the Pi, TypeScript, and GitHub Actions pins.

- pi-slate: focused mode replaces vertical mode (`/slate focused`); the unused `@earendil-works/pi-ai` and `typebox` peers are dropped
- All packages: Pi dev/peer pins to 1.0.0, TypeScript to 7.0.2, typebox to 1.3.34
- pi-subagents: yaml to 2.9.1
- Actions: setup-node v7.0.0, upload-artifact v7.0.1, download-artifact v8.0.1

- README screenshots use stable GitHub URLs on GitHub, npm, and the Pi gallery; packing no longer rewrites the README
- Refresh the Pi 1.0.0 and TypeScript 7.0.2 dev pins

## 0.1.2

- README screenshots served from the npm CDN

## 0.1.1

- Document single, multi, and text modes in the README

## 0.1.0

First public release as `@gagansd/pi-ask`.

- `ask_user` interviews: one question at a time
- Single-select, multi-select, and free-text
- `/answer` turns the latest assistant message into a form
- `/ask-settings` for the settings overlay
