<div align="center">

```text
                 .--------------------------.
                /                          / |
               +--------------------------+  |
               | .----------------------. |  |
               | | /> π_                | |  |
               | |                      | |  |
               | |                      | |  |
               | |                      | |  |
               | |                      | |  |
               | '----------------------' |  |
               |        [====]  (o)  (*)   | /
               +--------------------------+'
          .-----------------------------------------.
         /                                         /|
        +-----------------------------------------+ |
       /  [][][] [] [][]   [][][] [] [][] [] [][] / |
      /                                          /  |
     /  [][][][][][][][]   [][][][][][][][][]   /   /
    /   [][][][][][][][]   [][][][][][][][][]  /   /
   /    [][][][][][][][]   [][][][][][][][][] /   /
  +-----------------------------------------+    /
  |                                         |   /
  '-----------------------------------------'--'

```
</div>

**Minimal Pi extensions and tooling for the Pi Coding Agent**


## Extensions

| Package | Status | Description | Install Command |
| --- | --- | --- | --- |
| [`pi-slate`](./pi-slate) | `Stable` | Terminal UI & UX built with Kitty graphics protocol support; adds zero context bloat | `pi install npm:pi-slate` |
| [`pi-web-search`](./pi-web-search) | `Stable` | Parallel, Jev-ranked search engine optimized for coding agent context windows | `pi install npm:@gagansd/pi-web-search` |
| [`pi-ask`](./pi-ask) | `Stable` | Interactive prompt modal for blocking agent queries to the human operator. | `pi install npm:@gagansd/pi-ask` |
| [`pi-jev-tool-output-compact`](./pi-jev-tool-output-compact) | `Beta` | Context-pruning middleware for tool responses before injection into chat history. | `pi install npm:@gagansd/pi-compact` |
| [`pi-subagents`](./pi-subagents) | `Planned` | Forked task orchestration layer to spawn sandboxed sub-workers. | TODO |
| [`pi-canvas-mode`](./pi-canvas-mode) | `Planned` | Scratchpad canvas buffer for side-by-side code generation and live diffing. | TODO |

---

## Architecture for AI Agents

```text
pi-extensions/
├── packages/
│   ├── pi-slate/                     # Zero-context TUI + Kitty graphics driver
│   ├── pi-web-search/                # Parallel search with Jev-ranking
│   ├── pi-ask/                       # Interactive CLI user prompt module
├── package.json                      # Workspace root manifest 
└── pnpm-workspace.yaml               # Monorepo boundary definition

```

---

## Quick Setup

* **Prerequisites:** `node >= 20.0.0`, `pi` CLI installed globally.
* **Install all stable extensions:**
```bash
pi install npm:pi-slate npm:@gagansd/pi-web-search npm:@gagansd/pi-ask

```


---

## Recommended Third-Party Tools

| Package | Purpose | Install Command |
| --- | --- | --- |
| `pi-context-view` | Token inspector & context usage analyzer | `pi install npm:pi-context-view` |

TODO: merge this into pi-slate 

---

## License

MIT © [Gagan Devagiri](https://www.google.com/search?q=https://github.com/gagansd)
