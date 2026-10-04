# Pi extensions

<table align="center"><tr><td>

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
 /____________________________\
'------------------------------'
```

</td></tr></table>

Monorepo of extensions I've built and maintain for the [Pi Agent Harness](https://pi.dev).

## Packages

| Package | Use it when you want to… | Install |
| --- | --- | --- |
| [pi-slate](./pi-slate/README.md) | Minimal customizable terminal UI with rich-media previews | `pi install npm:pi-slate` |
| [pi-ask](./pi-ask/README.md) | Interactive Agent-Human Experience for questions and clarifications | `pi install npm:@gagansd/pi-ask` |
| [pi-web-search](./pi-web-search/README.md) | A fast and tiny web search tool with native Jev support for filtering and ranking | `pi install npm:@gagansd/pi-web-search` |
| [pi-subagents](./pi-subagents/README.md) | Delegate bounded work to worker and reviewer children | `pi install npm:@gagansd/pi-subagents` |


## Other recommended third-party tools

- [pi-context-view](https://www.npmjs.com/package/pi-context-view): context usage inspection

## Development and releases

GitHub Actions validates package changes before merge. npm releases are requested
explicitly through a release PR; ordinary merges do not publish.
See [CI, release commands, and secret protection](docs/ci-cd.md).

## License

MIT — [Gagan Devagiri](https://github.com/GaganSD).
