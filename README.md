# Pi extensions

Three extensions for developers using the [Pi coding agent](https://pi.dev): **Slate** for the terminal workspace, **Ask** for structured decisions, and **Web Search** for public web and code evidence. Choose the package that fits your workflow and follow its setup guide; each can be installed separately.

## Choose an extension

| Package | Use it when you want to… | Install one package |
| --- | --- | --- |
| [pi-slate](./pi-slate/README.md) | See files, activity, and context usage in a customizable terminal UI with rich-media previews. | `pi install npm:pi-slate` |
| [pi-ask](./pi-ask/README.md) | Answer the agent's questions through single-select, multi-select, or text forms instead of a long back-and-forth. | `pi install npm:@gagansd/pi-ask` |
| [pi-web-search](./pi-web-search/README.md) | Look up documentation or public code and inspect source links, excerpts, and coverage warnings in Pi. | `pi install ./pi-web-search` from a checkout; not yet on npm |

Each package has its own requirements, configuration, and tests. Slate replaces Pi's header, footer, and editor; check for conflicts with other UI extensions. Ask's forms require the interactive TUI. `pi-subagents/` and `pi-canvas-mode/` are placeholders, not installable packages.

## Try search from a checkout

Start with one documentation lookup. Search requires **Pi >=0.99.0** and **Node >=22.19.0**, with no build step or additional runtime dependencies beyond Pi. From the root of a checkout containing `pi-web-search`, load that package for one invocation without adding it to settings:

```bash
pi -e ./pi-web-search
```

1. Run `/web-search-settings` in Pi. It shows the config path and credential presence, not key values or provider health. Missing optional keys are expected.
2. Ask: **“Use web_search to look up Node.js setImmediate with https://nodejs.org/api/timers.html in urls. Cite the page if retrieved and report coverage warnings.”**
3. Expand the tool result. Inspect the returned link and excerpt, then read **Coverage** and any **Warnings** before using the answer. If the requested page was not retrieved, don't treat search success as proof that it was read.

**Do I need search-provider keys?** Not for the default Exa web and grep.app code endpoints. Pi still needs its own model configuration and authentication. Public search availability, quotas, and coverage are best effort; results are not verified answers.

Queries and URLs go to external retrieval services—do not submit secrets or private-document links. Continue with the [tool examples](./pi-web-search/README.md#tools-and-examples), [data-handling limits](./pi-web-search/README.md#data-handling), or [troubleshooting](./pi-web-search/README.md#timeouts-fallback-and-errors). Research and external Jev judgment are separate opt-ins, both off by default.

## Install packages separately

### Can I install only search?

Yes. From the same repository checkout, persist just the search package with:

```bash
pi install ./pi-web-search
pi
```

For Slate or Ask alone, use the npm command in the package table. Local installs load in place without copying, so keep the checkout available. Restart Pi or run `/reload` after adding a package to an existing session.

### What does installing the repository root select?

The [root manifest](./package.json) declares Slate, Ask, and Web Search, plus Ask's skills and Slate's themes. A repository-root git installation uses that same manifest: **it is not a search-only install**. Use the package-specific setup guides above for requirements and configuration; avoid enabling the collection alongside separate installations of its packages.

`pi install` saves a personal package setting. Add `--local` to save it for the project instead; Pi requires project trust before loading project packages. Extensions run with Pi's operating-system permissions, so review code before installing. See [Pi's package guide](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) for package scope and resource selection, and each package's README for its own configuration paths.

## Development

Packages live directly in this repository. Install development dependencies in each with `npm ci --prefix <package>`, then run the collection's checks from the repository root:

```bash
npm test
npm run typecheck
```

For search-only tests, typechecking, and an actual source-package check, follow [Web Search development](./pi-web-search/README.md#development-and-package-checks). These checks validate code and packaging, not provider availability or search quality.

## Recommended third-party tools

- [pi-context-view](https://www.npmjs.com/package/pi-context-view): context usage inspection.
- [pi-subagents](https://www.npmjs.com/package/pi-subagents): delegated agent workflows.
- [pi-plan-mode](https://www.npmjs.com/package/@narumitw/pi-plan-mode): implementation planning.

## License

MIT — [Gagan Devagiri](https://github.com/GaganSD).
