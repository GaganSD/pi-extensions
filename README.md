# Pi extensions

## Subagents benchmark · 3 seeded trials per model

**Results pending:** 5 workflow patterns × 2 models × 3 trials, compared with
[`nicobailon/pi-subagents`](https://github.com/nicobailon/pi-subagents).
No live trials have been scored yet.

| Metric | `@gagansd/pi-subagents` | `nicobailon/pi-subagents` |
| --- | ---: | ---: |
| Unpacked package size | — | — |
| Estimated startup declared-context tokens | — | — |
| Estimated delegation-active declared-context tokens | — | — |
| Dynamic workflow patterns verified | — / 5 | — / 5 |
| Successful workflow episodes | — / 30 | — / 30 |

### Token usage · median of 3 five-pattern suites

| Model · thinking | `@gagansd/pi-subagents` | `nicobailon/pi-subagents` | Change |
| --- | ---: | ---: | ---: |
| Kimi K3 · medium | — | — | — |
| Grok 4.6 · medium | — | — | — |

Declared-context figures are character proxies for system/tool declarations,
not billing counts; on-demand guide reads are excluded here, included in total usage.
Token usage includes reported parent **and child** usage, including cached tokens;
it is not a dollar-cost estimate. Package size uses pinned local release builds.
Unknown/aborted usage is not free. Token cells and savings remain withheld unless
completion and complete accounting can be independently reconciled.
[Protocol, prompts, model routes, and measurement boundaries](./benchmarks/README.md).

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
