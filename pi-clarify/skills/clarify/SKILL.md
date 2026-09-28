---
name: clarify
description: "Clarify material requirement, preference, or authorization gaps left after context review, or conduct explicitly requested interviews. Not for comparisons or routine choices alone."
metadata:
  short-description: Clarify material gaps after reading context
---

# Clarify material gaps

Use `clarify` to resolve a gap that changes what should be done, not to transfer routine decisions back to the user. Read only the references needed for the current interaction.

## Decision boundary

- Check relevant context and existing authorization. Ask only for an unresolved critical requirement, outcome-changing preference, or missing authorization for a consequential/hard-to-reverse action. Resolve factual uncertainty through evidence, not by asking the user to repeat available facts.
- Explicitly requested interviews, requirements gathering, and interactive questions use the tool. A requested written questionnaire or checklist is a prose artifact.
- Complete clear comparisons/research directly. Alternatives alone are not a reason to ask. Proceed with authorized routine work and delegated choices; do not reconfirm settled decisions unless materially new information changes them.
- Ask one decision per question, limited to current blockers or the requested interview topic. Preserve prior answers and answer elaborations before asking any remaining blockers.
- Cancellation, missing answers, or ambiguous responses are not approval for high-risk actions. Keep that action blocked and continue independent authorized work. Neither `status: "submitted"` nor a missing `unanswered` entry establishes approval.

## Read as needed

| Need | Reference |
| --- | --- |
| Payload, notes, or a resumed interaction | [Interaction guide](references/interaction.md) |
| Borderline decisions or model behavior evaluation | [Decision cases](references/decision-cases.md) |
| Runtime behavior and result contract | [Contract](../../docs/contract.md) |
| Settings or keymaps | [Configuration](../../docs/configuration.md) |

The registered tool guidance works without this skill. This guidance is advisory, not a runtime authorization mechanism; the contract and package tests govern tool behavior.
