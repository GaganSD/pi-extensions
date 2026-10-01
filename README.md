# Pi extensions

<div align="center">

```text
                 .--------------------------.
                /                          /|
               +--------------------------+ |
               | .----------------------. | |
               | | /> π_                | | |
               | |                      | | |
               | |                      | | |
               | |                      | | |
               | '----------------------' | |
               |      [====]  (o)  (*)    |/
               +--------------------------+
                          |____|
                     _____|____|_____
                    /________________\
                     .------------------.
                    /                  /|
                   +------------------+ /
                   '------------------'
```

</div>

Extensions for the [Pi coding agent](https://pi.dev). Install only the package you need.

## Packages

| Package | Use it when you want to… | Install |
| --- | --- | --- |
| [pi-slate](./pi-slate/README.md) | See files, activity, and context usage in a customizable terminal UI with rich-media previews. | `pi install npm:pi-slate` |
| [pi-ask](./pi-ask/README.md) | Answer the agent through single-select, multi-select, or text forms. | `pi install npm:@gagansd/pi-ask` |
| [pi-web-search](./pi-web-search/README.md) | Look up public docs or code and inspect source links, excerpts, and coverage warnings. | `pi install ./pi-web-search` from a checkout; not on npm yet |

Each package has its own requirements and tests. Slate replaces Pi's header, footer, and editor — check for conflicts with other UI extensions. Ask's forms need the interactive TUI. `pi-subagents/` and `pi-canvas-mode/` are placeholders, not installable packages.

Agents: start at [llms.txt](./llms.txt).

## Try search from a checkout

Search needs **Pi >=0.99.0** and **Node >=22.19.0**. It is not published to npm. From a checkout that contains `pi-web-search`:

```bash
pi -e ./pi-web-search
```

Run `/web-search-settings`, then ask Pi to look up a public docs page with `web_search`. Expand the tool result and read **Coverage** and **Warnings** before using the answer.

Default Exa web, native Parallel MCP fallback, and grep.app code endpoints need no search-provider key. `/mcp` shows Parallel connection status; Pi owns the MCP lifecycle and optional Jev classifier authentication. Pi still needs its own model auth. Queries and URLs go to external services — do not submit secrets. Full setup, tools, and limits: [pi-web-search README](./pi-web-search/README.md).

To keep search installed: `pi install ./pi-web-search`. Local installs load in place, so keep the checkout. Installing the **repository root** also loads Slate and Ask; it is not search-only.

## Development

Packages live at the repository root. Install each package's deps with `npm ci --prefix <package>`, then from the root:

```bash
npm test
npm run typecheck
```

Search-only checks: [Web Search development](./pi-web-search/README.md#development-and-package-checks).

## Recommended third-party tools

- [pi-context-view](https://www.npmjs.com/package/pi-context-view): context usage inspection
- [pi-subagents](https://www.npmjs.com/package/pi-subagents): delegated agent workflows
- [pi-plan-mode](https://www.npmjs.com/package/@narumitw/pi-plan-mode): implementation planning

## License

MIT — [Gagan Devagiri](https://github.com/GaganSD).
