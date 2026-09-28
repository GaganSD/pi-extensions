---
name: ask-user
description: Use to interview user to clarify gaps in context, requirements, get missing authorization, or brainstorming with the user.
---

# Ask user

Use `ask_user`. Check relevant context first; do not reconfirm settled decisions or ask just because alternatives exist. Continue authorized routine work.

Ask one decision per question. Cancellation or ambiguity is not approval; keep risky actions blocked.

`single` one choice, `multi` several, `text` free input. Unique `id`s. Recommended options get a `description`; never preselect. Typed text is not an option value.

Settings: `/ask-settings` or `?` in a form. Optional file: `~/.pi/agent/extensions/pi-ask.json`. `/answer` uses the current chat model unless `answer.extractionModels` is set.
