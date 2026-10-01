# Pi extensions

Extensions for the [Pi coding agent](https://pi.dev).

| Package | Description | Install |
| --- | --- | --- |
| [pi-slate](./pi-slate) | Terminal UI with Kitty graphics, context controls, and observability | `pi install npm:pi-slate` |
| [pi-ask](./pi-ask) | Interactive questions for the human operator | `pi install npm:@gagansd/pi-ask` |
| [pi-web-search](./pi-web-search) | Cited web and public-code search, with keyless defaults and opt-in research | `pi install npm:@gagansd/pi-web-search` |

See each package's README for requirements, configuration, and development commands. Packages live directly in this repository; each has its own manifest and tests. The root manifest loads all three extensions when this repository is installed as a Pi package.

`pi-subagents/` and `pi-canvas-mode/` are placeholders, not installable packages.

## Development

Install development dependencies in each package with `npm ci --prefix <package>`, then run:

```bash
npm test
npm run typecheck
```

## Recommended third-party tools

- [pi-context-view](https://www.npmjs.com/package/pi-context-view): context usage inspection.
- [pi-subagents](https://www.npmjs.com/package/pi-subagents): delegated agent workflows.
- [pi-plan-mode](https://www.npmjs.com/package/@narumitw/pi-plan-mode): implementation planning.

## License

MIT — [Gagan Devagiri](https://github.com/GaganSD).
