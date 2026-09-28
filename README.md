# pi-extensions

Monorepo of Pi Coding Agent extensions I build and use.

## First-party

| Package | Install |
| --- | --- |
| [pi-slate](./pi-slate) | `pi install npm:pi-slate` |
| [pi-ask](./pi-ask) | `pi install npm:@gagansd/pi-ask` |

`pi-ask` is the TUI interview tool (`ask_user`, `/answer`, `/ask-settings`). Uninstall `@geoqiao/pi-ask` if both are present.

A clone of this repo loads Slate and pi-ask together:

```bash
pi install .
```

Publish stays per-package (`cd pi-ask && npm publish`).

| Folder | Status |
| --- | --- |
| [pi-subagents](./pi-subagents) | Empty. Next. |
| [pi-canvas-mode](./pi-canvas-mode) | Empty. Next. |

## External (installed from pi-configs, not vendored)

This GitHub repo is public, so third-party sources stay as install specs.

| Package | Install |
| --- | --- |
| pi-mcp-adapter | `git:github.com/nicobailon/pi-mcp-adapter` |
| pi-context-view | `npm:pi-context-view` |
| pi-subagents | `npm:pi-subagents` |
| pi-web-search | `npm:pi-web-search` |
| @narumitw/pi-plan-mode | `npm:@narumitw/pi-plan-mode` |
| ponytail | `git:github.com/DietrichGebert/ponytail` |
| pi-goal-x | `npm:pi-goal-x` |
| @dev.fast/pi-whiteboard | `npm:@dev.fast/pi-whiteboard` |

Config for those lives in [pi-configs](https://github.com/GaganSD/pi-configs).
