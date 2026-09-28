# pi-clarify configuration

Config path:

```text
~/.pi/agent/extensions/pi-clarify.json
```

This package does not read or rewrite `eko24ive-pi-ask.json` or `~/.pi/agent/settings.json`. Invalid files load defaults for the session and are left unchanged.

## Defaults

```json
{
  "schemaVersion": 1,
  "answer": {
    "extractionModels": [
      { "provider": "openai", "id": "gpt-5.6-luna" },
      { "provider": "openai", "id": "gpt-5.6-sol" },
      { "provider": "bedrock", "id": "xai.grok-4.6" }
    ],
    "extractionTimeoutMs": 30000,
    "extractionRetries": 1
  },
  "behaviour": {
    "autoSubmitWhenAnsweredWithoutNotes": false,
    "confirmDismissWhenDirty": true,
    "doublePressReviewShortcuts": true,
    "showFooterHints": true
  },
  "keymaps": {
    "main": {
      "changeQuestionType": ["t"]
    }
  },
  "notifications": {
    "enabled": true,
    "channels": ["bell"]
  }
}
```

## Behaviour

| Key | Default | Meaning |
| --- | --- | --- |
| `autoSubmitWhenAnsweredWithoutNotes` | `false` | Never auto-submit unless you turn this on |
| `confirmDismissWhenDirty` | `true` | Second cancel/dismiss required when the form has work |
| `doublePressReviewShortcuts` | `true` | 1/2/3 on review need a second press |
| `showFooterHints` | `true` | Footer keymap hints |

There is no global present-single-as-multi setting. Use `t` on the current question.

## Extraction

`/answer` uses `answer.extractionModels` in order, then the current chat model. Normal `clarify` calls do not call an extraction model.

Failed or truncated extraction is shown as an error. Offered choices are not silently dropped.

## Commands

Open `/clarify-settings` or press `?` in a form. Resetting defaults requires a guarded double press.
