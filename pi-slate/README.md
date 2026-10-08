<h1 align="center">Slate 🌱</h1>

<p align="center">
  A minimal-TUI with rich-graphics support that adds zero-context bloat
</p>

![Slate standard mode with the sidebar and context dock](https://raw.githubusercontent.com/GaganSD/pi-extensions/main/pi-slate/assets/slate-overview.png)

## Setup

**Option 1: Pi-agent Prompt**

```text
- Save my pi-agent's tui and themes and safely disable them for now.
- Install pi-slate using: `pi install npm:pi-slate` and enable fullscreen mode.
- pi-slate replaces Pi's existing TUI; resolve any conflicts. Ask me to /reload session once complete.
```

**Option 2: Bash**

```bash
pi install npm:pi-slate
pi --tui-mode fullscreen
```

Explore extension settings using `/slate` after installation. Releases: [CHANGELOG](CHANGELOG.md).

## Features

Slate renders cleanly into your terminal and stays customizable without adding new model-facing tools, prompts, or model calls.

### Focused-first Workspace

Focused mode is the default. It unmounts the sidebar, gives chat the full window, and keeps the prompt compact.

- `/slate focused [on|off]` sets the saved focused-mode state.
- `/slate pid [on|off]` toggles the agent PID label on the prompt's top edge; it stays off by default.
- Choosing a sidebar width returns to standard sidebar mode.
- Working status stays on the left of the prompt's top edge.
- When skills or MCPs are present, spend and nonzero counts stay on the right of the prompt's top edge.
- The context footer shows usage percentage, context-window size, and estimated streamed tokens per second: `5%/1M tokens · ↑↓845`.

![Slate focused mode with the sidebar unmounted](https://raw.githubusercontent.com/GaganSD/pi-extensions/main/pi-slate/assets/slate-focused.png)

### Thinking Status

In the TUI, an observed thinking block adds elapsed whole seconds and the available estimated token rate to the existing prompt-edge working word: `Pondering · 7s · ↑↓42`. Under one second it omits the duration; without a rate it shows `Pondering · 7s`. The timer stops when thinking ends, a response is aborted, or the session shuts down. Print, RPC, and JSON modes are unchanged.

Native thinking visibility, labels, click-to-expand, and `Ctrl+T` remain untouched, including during streaming and on session restore. Settled per-message `Thought 12s` needs a Pi per-message hidden-label API; the current global setter would incorrectly relabel older thoughts.

### Diff

`edit` and `write` results are syntax-highlighted in the transcript. Enabled by default.

- Split edits (before/after) at 100+ columns; unified below that, and for every write.
- Word-level emphasis on paired lines. 190+ languages via Shiki; unknown types stay plain text.
- Compact until you expand the tool card. Long lines clip to the pane.

Native schemas, mutation queue, errors, and model-facing text are unchanged. Write snapshots stay in `slateDiff` result details for session restore. RPC, JSON, and print keep native results. `/slate theme` styles the whole UI, including diffs — there is no separate diff theme.

Consecutive `read` cards collapse into one line: `read x.md` stays as-is, then `read 2 files`. `Ctrl+O` lists the paths. A user message, assistant text from a later turn, or any other tool starts a new streak.

![Split YAML edit with word-level emphasis](https://raw.githubusercontent.com/GaganSD/pi-extensions/main/pi-slate/assets/slate-diff-yaml.png)

![Split Rust edit with syntax highlighting](https://raw.githubusercontent.com/GaganSD/pi-extensions/main/pi-slate/assets/slate-diff-rust.png)

Previews are bounded: 256 KiB snapshots, 2,000 parsed rows, 16 collapsed / 400 expanded. Binary or oversized previous content shows a notice, not a fake overwrite.

### Rich Media Rendering

Slate uses Kitty Graphics Protocol to display rich media inside your terminal.

> Usage: Caret-peek over text to display. Click Preview to copy a path. Double-click to open or edit. Pi-generated clipboard image paths are converted into `[image-N]` tokens.

![Chat with image tokens and the sidebar image preview](https://raw.githubusercontent.com/GaganSD/pi-extensions/main/pi-slate/assets/slate-media.png)

### Interactive Observability

Inspect work-tree files and recent request activity directly from the terminal.

> Usage: Single-click to preview files or drill into activity categories. Double-click to open files in your editor. Expand activity entries to inspect detailed tool executions.

![Sidebar files and last-turn activity](https://raw.githubusercontent.com/GaganSD/pi-extensions/main/pi-slate/assets/slate-observability.png)

### Session Context Overview

Slate keeps usage and spend visible without sending context to your LLM.

- Standard mode keeps detailed token, rate, spend, skill, and MCP facts in the sidebar's Context dock.
- Focused mode uses the shorter prompt-edge format and hides the resource summary when no skills or MCP servers are loaded.
- MCP counts come from Pi's native global `mcp.json` and project `.pi/mcp.json` files.
- Project MCP entries override global entries with the same name; `enabled: false` and `disabled: true` are respected.
- Context usage may be estimated when provider usage is unavailable.

![Context usage, spend, skills, and MCP count](https://raw.githubusercontent.com/GaganSD/pi-extensions/main/pi-slate/assets/slate-context.png)

### Update Notices

Pi and package updates appear as a centered hairline in the Slate header. Duplicate stock Pi/package update cards are removed from the transcript, keeping chat focused on the conversation.

### Themes

The prompt, Summary, and Context share one frame. The Pi logo stays white in every theme.

Black Metal is the install default. Catppuccin Mocha styles: Default, Quiet, Mauve, Sapphire, Peach, Teal.

`/slate` → Theme picks one. Or set it directly:

```text
/slate theme mauve
/slate style quiet
```

Selection is saved and also appears in `/settings`.

### Prompt Templates

`/prompts` or `Ctrl+Alt+P` opens a searchable picker of Pi's loaded prompt templates. Search by filename, name, description, or body; use ↑↓ to choose and Enter to insert at the composer cursor. Esc or Ctrl+C closes without changing your draft. Configured Pi selection keys are respected.

The picker rereads templates when opened, reports unreadable files, and uses the filename when `name:` is missing or empty. Add new templates through Pi's prompt directories or settings, then run `/reload`. Inserting a template does not send a message or expand argument placeholders; edit those before submitting. If your terminal does not send the shortcut, use `/prompts`.

### Composer Keys

These work from the prompt after `pi install npm:pi-slate`. No terminal configuration.

| Action | Keys |
| --- | --- |
| Select all prompt text | `Ctrl+A` |
| Copy the prompt | `Ctrl+C` |
| Scroll a long prompt | Mouse wheel over the composer |
| Replace or drop a large prompt | `Ctrl+A` then Backspace, or `Esc` `Esc` |
| Submit selected prompt | `Enter` |
| Clear the prompt | `Esc` `Esc` |
| Expand or collapse a paste | Click the `[paste #N]` token |

`Ctrl+A` selects the whole prompt instead of jumping to the line start; `Home` still does that. `Ctrl+C` copies the full prompt, including hidden lines and collapsed `[paste #N]` bodies, and leaves the text in place. `Ctrl+X` is left to Pi (`app.message.copy`). To remove a large prompt, copy first if you need it, then `Ctrl+A` Backspace or `Esc` `Esc`. Drag-selecting uses Pi's native screen selection; `Ctrl+C` copies the prompt without frame characters. Wheel over the composer scrolls overflow; wheel outside it still scrolls the transcript. Large pastes stay collapsed as `[paste #N]` until you click that token. Image tokens stay as `[image-N]`. Submit text is unchanged.

## Commands

`/slate` with no args opens the settings picker. `/prompts` opens the prompt-template picker. `/exit` quits Pi, same as `/quit`.

| Setting | Commands | Effect |
| --- | --- | --- |
| Focused | `/slate focused [on\|off]` | Set focused mode. Focused mode hides the sidebar; standard mode restores it. |
| PID display | `/slate pid [on\|off]` | Show the agent process ID on the composer's top edge. Off by default; omitted when the frame is too narrow. |
| Sidebar width | `/slate width [default\|narrow\|medium\|wide\|<percent>]` | Choose the sidebar width and return to standard mode. `default` is 20%. |
| Message length | `/slate message-length [default\|all\|<count>]` | How many chat messages stay on screen. `default` is 100. |
| Density | `/slate density [comfortable\|compact]` | Comfortable shows a › prompt in the composer; compact is tighter. |
| Footer | `/slate footer [standard\|minimal]` | Standard shows model and thinking on the composer; minimal hides them. |
| Theme | `/slate theme [default\|quiet\|mauve\|sapphire\|peach\|teal]` | Catppuccin Mocha style. `/slate style` does the same. |
| Bugs | `/slate bug [file\|open]` | Copy a bug report, or open the npm package page. |

## Model Display

`~/.pi/agent/pi-slate.json` accepts a `modelDisplay` object to restyle model labels in the header and composer footer. It is provider-agnostic and display-only; the model id sent to the API never changes.

```json
{
  "modelDisplay": {
    "stripPrefixes": ["us.", "eu.", "global.", "anthropic.", "xai.", "moonshotai."],
    "providerAliases": { "bedrock-runtime": "bedrock", "bedrock-priority": "bedrock" },
    "providerSuffix": true
  }
}
```

- `stripPrefixes`: literal prefixes removed from displayed model ids, applied repeatedly. `us.moonshotai.kimi-k3` becomes `kimi-k3`.
- `providerAliases`: renames a provider for display. Aliased providers collapse to the same label.
- `providerSuffix`: renders `kimi-k3 (bedrock)` instead of `bedrock/kimi-k3` in both the header and the footer.

## Minimal By Design

Slate adds no new model-facing tools, prompts, or model calls. Highlighted `edit` and `write` results keep the native response text. It's entirely deterministic and made to be customizable and improve your Pi experience while your Pi remains yours.

## Requirements

- Pi Coding Agent and a modern terminal that can render Kitty or iTerm2 image protocol, such as Ghostty or Warp.
- Disable other UI extensions or ask your agent to merge them. Slate replaces Pi's header, footer, and editor. Extensions that replace the same surfaces may conflict.
- Copy a bug report with `/slate bug`.

## License

[MIT](LICENSE) © [Gagan Devagiri](https://github.com/GaganSD)
