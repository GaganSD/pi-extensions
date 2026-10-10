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

<h1 align="center">pi-extensions</h1>

<p align="center"><strong>High-performance, context-efficient extensions and tools for the <a href="https://pi.dev">Pi</a> agent harness.</strong></p>

<p align="center">
  <a href="https://github.com/GaganSD/pi-extensions/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/GaganSD/pi-extensions/ci.yml?branch=main&style=flat-square&label=CI&color=10b981&labelColor=18181b" alt="CI Status" /></a>
  <a href="https://snyk.io"><img src="https://img.shields.io/badge/security-snyk%20monitored-10b981?style=flat-square&labelColor=18181b&logo=snyk&logoColor=white" alt="Security: Snyk" /></a>
  <a href="https://github.com/GaganSD/pi-extensions/actions"><img src="https://img.shields.io/badge/vulnerabilities-0%20reported-10b981?style=flat-square&labelColor=18181b" alt="Vulnerabilities: 0" /></a>
  <br />
  <a href="https://pi.dev"><img src="https://img.shields.io/badge/pi-%3E%3D1.0.0-27272a?style=flat-square&labelColor=18181b" alt="Pi >= 1.0.0" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-27272a?style=flat-square&labelColor=18181b" alt="License: MIT" /></a>
  <a href="./benchmarks/README.md"><img src="https://img.shields.io/badge/benchmarks-verified-10b981?style=flat-square&labelColor=18181b" alt="Benchmarks Verified" /></a>
</p>

---

A monorepo of modular extensions engineered specifically for the Pi coding agent. Each package adheres to strict context-efficiency principles, zero-bloat architecture, and native Pi integration. Detailed subagent delegation benchmarks live in [`benchmarks/README.md`](./benchmarks/README.md).

## Design Principles

- **Minimal by Design** — Engineered for zero-context bloat and preserve the agent's context window. Prompts and schemas stay minimal while benchmaxxing every tool for effectiveness.
- **Keyless by Default** — Essential utilities like public web and code retrieval work instantly out of the box.
- **Pi-Native** — Built strictly around Pi's extension lifecycle, tools, custom slash commands, themes, and configuration store.

---

## Packages

| Package | Description | Install |
| :--- | :--- | :--- |
| [pi-slate](./pi-slate/) | Minimal full-screen terminal UI with split sidebars and media previews. Zero context bloat. | `pi install npm:pi-slate` |
| [pi-subagents](./pi-subagents/) | Tiny, benchmarked subagent harness with 88% less token overhead ([benchmarks](./benchmarks/README.md)). | `pi install npm:@gagansd/pi-subagents` |
| [pi-web-search](./pi-web-search/) | Cited public web and code search. Keyless by default with optional ranking. | `pi install npm:@gagansd/pi-web-search` |
| [pi-ask](./pi-ask/) | Structured interactive TUI interviews for human-in-the-loop decisions. | `pi install npm:@gagansd/pi-ask` |

---

## Installation

### All-in-One Suite (Monorepo)

Point Pi to a clone of this repository to register all 4 extensions, skills, and Slate themes simultaneously:

```bash
git clone https://github.com/GaganSD/pi-extensions.git
cd pi-extensions
pi install .
```

Then reload Pi with `/reload`.

### Standalone (NPM)

Install individual extensions directly:

```bash
pi install npm:pi-slate               # Terminal UI & themes
pi install npm:@gagansd/pi-subagents  # Subagent delegation
pi install npm:@gagansd/pi-web-search # Public web & code search
pi install npm:@gagansd/pi-ask        # Clarification interviews
```

---

## Development & Building

**Prerequisites**: Node.js `>=22.19.0`, npm `>=10.0.0`, Pi `>=1.0.0`.

```bash
npm ci --ignore-scripts
npm test              # unit & integration
npm run typecheck
npm run test:tooling
npm run secrets:scan
npm run build --prefix pi-slate       # or pi-subagents, pi-web-search, pi-ask
```

After `pi install .`, local edits apply on `/reload`.

---

## Benchmarks & Performance

`@gagansd/pi-subagents` is continuously benchmarked against standard delegation alternatives on dynamic multi-step workflows (parallel join, bounded repair, conditional fanout):

| Metric | `@gagansd/pi-subagents` | `pi-subagents` | Improvement |
| :--- | :--- | :--- | :--- |
| **Package Size** | **103.35 KB** | 11.60 MB | **99.11% reduction** |
| **Initial Token Overhead** | **718** | 6,158 | **88.34% reduction** |
| **Avg Tokens (5 tasks · Kimi-K3)** | **331,346** | 638,964 | **48.14% fewer tokens** |
| **Avg Tokens (5 tasks · Grok-4.6)** | **256,451** | 979,286 | **73.81% fewer tokens** |

See [`benchmarks/README.md`](./benchmarks/README.md) for full benchmark methodology, runner scripts, and scoring criteria.

---

## Repository Structure

```text
pi-extensions/
├── pi-slate/           # Minimal TUI, custom surfaces, diff viewers & themes
├── pi-subagents/       # High-efficiency subagent delegation harness
├── pi-web-search/      # Multi-provider web & code search with classifier
├── pi-ask/             # Structured TUI interview & clarification modal
├── benchmarks/         # Multi-model workflow benchmarking suite
├── docs/               # Architecture, CI/CD, and release guides
└── scripts/            # Build, test, security scanning, and release tools
```

---

## Quality & Security

- **Continuous Integration**: Every change runs type checks, unit/integration suites, clean consumer installations, and secret scans via GitHub Actions.
- **Secret Protection**: Automated pre-commit and CI scans with [Gitleaks](https://github.com/gitleaks/gitleaks) to prevent credential leaks.
- **Dependency Auditing**: Vulnerability scans with Snyk and `npm audit`.

See [CI/CD Documentation](./docs/ci-cd.md) for release workflows and release preparation details.

---

## License

[MIT](./LICENSE) © [Gagan Devagiri](https://github.com/GaganSD)
