# pi-extensions

Monorepo of extensions I've built for the Pi Coding Agent Harness

| Package | Description | Install |
| --- |---| --- |
| [pi-slate](./pi-slate) | Minimal vertical-first TUI with graphics, observability, and context controls | `pi install npm:pi-slate` |
| [pi-ask](./pi-ask) | Interactive tool to ask user questions | `pi install npm:@gagansd/pi-ask` |
| [pi-web-search](./pi-web-search) | `web_search` backed by Exa and Parallel. Works with no API key | `pi install npm:@gagansd/pi-web-search` |

| Folder | Status |
| --- | --- |
| [pi-jev-tool-output-compact] | beta-testing |
| [pi-subagents](./pi-subagents) | beta-testing|
| [pi-canvas-mode](./pi-canvas-mode) | TODO |

## External

Few third-party sources

| Package | Install |
| --- | --- |
| pi-context-view | `npm:pi-context-view` | (TODO: Merge this with pi-slate)
| pi-subagents | `npm:pi-subagents` |
| pi-web-search | `npm:pi-web-search` | (Replaced by [pi-web-search](./pi-web-search) in this repo: same tool, Exa + Parallel only, no key needed)
| @narumitw/pi-plan-mode | `npm:@narumitw/pi-plan-mode` | (TODO: replace with canvas mode with tldraw support)
| ponytail | `git:github.com/DietrichGebert/ponytail` | (TODO: Move to /prompts)
