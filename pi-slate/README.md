<h1 align="center">Slate 🌱</h1>

<p align="center">
  A minimal terminal UI/UX for Pi Coding Agent with a customizable sidebar that keeps your work in view
  <div style="height: 20px;"></div>
  <img src="https://cdn.jsdelivr.net/npm/pi-slate@0.1.4/assets/slate-overview.png" alt="Slate session with sidebar preview" />
</p>

## Setup

**Option 1: Pi-agent Prompt**

```
- Save my pi-agent's tui and themes and safely disable them for now.
- Install pi-slate using: `pi install npm:pi-slate` and enable fullscreen mode.
- pi-slate replaces Pi's existing TUI; resolve any conflicts. Ask me to /reload session once complete.
```

**Option 2: Bash**

```bash
pi install npm:pi-slate
pi --tui-mode fullscreen
```

Explore extension settings using `/slate` command after installation.

## Features

Slate cleanly renders into your terminal and is easily customizable in your Pi. It adds no additional context bloat to your model.

### Rich Media Rendering

Slate uses Kitty Graphics Protocol to display rich media inside your terminal.

> Usage: Caret-Peek over text to display. Click Preview to copy-path. Double-click to open/edit. Also supports Pi-generated clipboard image paths into `[image-N]` tokens.

<p align="center">
  <img src="https://cdn.jsdelivr.net/npm/pi-slate@0.1.4/assets/slate-media.png" alt="Chat with [image-N] tokens and the sidebar image preview" />
</p>

### Interactive Observability

Inspect work-tree files and recent request activity directly from the terminal.

> Usage: Single-click to preview files or drill into activity categories, double-click to open files in your editor, and expand activity entries to inspect detailed tool executions.

<p align="center">
  <img src="https://cdn.jsdelivr.net/npm/pi-slate@0.1.4/assets/slate-observability.png" alt="Sidebar files and last-turn activity" />
</p>

### Session Context Overview

Slate keeps usage and spend visible at the bottom. Context usage may be estimated when provider usage is unavailable. (Slate doesn't use your LLM to estimate this)

<p align="center">
  <img src="https://cdn.jsdelivr.net/npm/pi-slate@0.1.4/assets/slate-context.png" alt="Context usage, spend, skills, and MCP count" width="567" />
</p>

### Catppuccin Themes

The prompt, Summary, and Context share one frame. The Pi logo stays white in every theme. Colors are official [Catppuccin Mocha](https://catppuccin.com/palette/) tokens only.

Six styles: Canonical, Quiet, Mauve, Sapphire, Peach, Teal.

`/slate` → Theme picks a style. Or set it directly:

```text
/slate theme mauve
/slate style quiet
```

Selection is saved and also appears in `/settings` as `catppuccin-mocha-<style>`.

## Composer Keys

Slate owns the prompt, not the whole terminal.

| Action | Keys |
| --- | --- |
| Select all prompt text | `Cmd+A` / `Ctrl+Shift+A` |
| Copy selected prompt | `Cmd+C` / selected `Ctrl+C` / `Ctrl+Shift+C` |
| Cut selected prompt | `Cmd+X` / `Ctrl+Shift+X` |
| Replace selection | Type, Backspace, or paste |
| Submit selected prompt | `Enter` (does not erase it first) |
| Clear the prompt | `Esc` `Esc` |
| Expand a collapsed paste or `[image-N]` | `F4`, or paste matching content while the cursor is on the token |

Large pastes stay collapsed as `[paste #1 +18 lines]`. Image paths stay as `[image-1]`. `F4` expands the token in place. Repeating a paste expands it only when the delivered clipboard payload matches the token; other clipboard content is inserted normally. `Cmd+V` can expand only when the terminal delivers the paste key or payload to Pi.

Terminal and OS shortcuts vary: a terminal may consume `Cmd` keys before Pi sees them, and Kitty keyboard support cannot recover keys that were not forwarded. Use `Ctrl+Shift+A`, `Ctrl+Shift+C`, and `Ctrl+Shift+X` where your terminal distinguishes them. No terminal configuration is required or guaranteed to work everywhere. `Ctrl+C` copies only while the prompt is selected; otherwise Pi keeps its normal behavior.

## Commands

`/slate` with no args opens the same settings picker.

| Setting | Commands | Effect |
| --- | --- | --- |
| Sidebar width | `/slate width [default\|narrow\|medium\|wide\|<percent>]` | How wide the sidebar is. `default` is 20%. |
| Message length | `/slate message-length [default\|all\|<count>]` | How many chat messages stay on screen. `default` is 100. |
| Density | `/slate density [comfortable\|compact]` | Comfortable shows a › prompt in the composer; compact is tighter. |
| Footer | `/slate footer [standard\|minimal]` | Standard shows model and thinking on the composer; minimal hides them. |
| Theme | `/slate theme [canonical\|quiet\|mauve\|sapphire\|peach\|teal]` | Mocha style. `/slate style` is the same switch. |
| Bugs | `/slate bug [file\|open]` | Copy a bug report, or open the npm package page. |

## Minimal By Design

Slate adds no context bloat; no tools, prompts, or model calls. It's entirely deterministic and made to be customizable and improve your Pi experience while your Pi remains yours.

## Requirements
- Pi Coding Agent and a Modern Terminal that can render Kitty or iTerm2 image-protocol. (Ghostty, Warp, etc.)
- Disable other UI extensions or ask your agent to merge them. Slate replaces Pi's header, footer, and editor. Extensions that replace the same surfaces may conflict.
- Copy a bug report with `/slate bug`

## License

[MIT](LICENSE)
