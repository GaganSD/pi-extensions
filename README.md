# pi-extensions

Monorepo of Pi Coding Agent extensions I build and use.

Local install of this repo still loads Slate:

```bash
pi install /Users/gagandevagiri/GitHub/pi-extensions
```

Publish and npm installs stay per-package (`cd pi-slate && npm publish`).

## First-party

| Folder | Status |
| --- | --- |
| [pi-slate](./pi-slate) | Quiet TUI. Published as `npm:pi-slate`. |
| [pi-clarify](./pi-clarify) | Empty. Next. |
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
| @geoqiao/pi-ask | `npm:@geoqiao/pi-ask` |
| @narumitw/pi-plan-mode | `npm:@narumitw/pi-plan-mode` |
| ponytail | `git:github.com/DietrichGebert/ponytail` |
| pi-goal-x | `npm:pi-goal-x` |
| @dev.fast/pi-whiteboard | `npm:@dev.fast/pi-whiteboard` |

Config for those lives in [pi-configs](https://github.com/GaganSD/pi-configs).
