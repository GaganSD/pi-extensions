# CEO review: `pi-clarify`

**User problem:** Own the clarification experience you rely on inside Pi TUI, without losing the speed, control, and recovery paths that make `pi-ask` useful when the agent asks an imperfect question.

“Clone `pi-ask` minus dependencies” is an incomplete framing. Ownership is a legitimate goal; fewer features are not automatically progress. A smaller replacement that repeatedly sends you back to `pi-ask` has failed.

## Inherited decisions

- `pi-clarify` will be a first-party package in your extensions monorepo; its directory currently contains only `.gitkeep`.
- You already use the incumbent daily. This is a replacement decision, not discovery of an entirely new product.
- TUI is the known daily surface. RPC usage is unverified.
- Preserve structured clarification and the policy of asking only for material gaps or requested interviews.
- The proposed cut-list is a hypothesis, not an approved scope.
- This review defines the product bet—not its architecture, implementation plan, or PRD.

## Diagnosis: the valuable product includes repair

The incumbent serves two related jobs:

1. **Answer a well-formed question efficiently.**
2. **Recover when the agent fails to ask a well-formed question.**

The proposed simplification protects the first and disproportionately removes the second:

| Agent failure | Existing escape hatch |
|---|---|
| Asks questions in prose instead of using the tool | `/answer` |
| Offers choices the user cannot evaluate yet | Notes and Elaborate |
| Asks for one choice when several are valid | Live question-type change |
| Offers an incomplete menu | Custom text |
| A form is interrupted or needs reopening | Recovery and replay |

These are not all ornamental features. They compensate for an unreliable question author.

### Evidence that changes the cut-list

Your live configuration explicitly names three extraction models. It also retains notes, live type changing, dirty-dismiss protection, review shortcut confirmation, and manual submission.

**This establishes configuration investment, not usage frequency.** Most of those interaction settings match upstream defaults; their presence alone does not prove you use them. The customized extraction preferences are a stronger signal against casually deleting `/answer`. No session traces were supplied to establish actual frequency.

The sharper product promise is:

> **Answer, correct, or question the agent’s question—without abandoning the interaction or repeating settled decisions.**

The ten-star experience is not a bigger form builder. It is an interaction that asks only when necessary, accepts answers outside its assumptions, explains confusing choices, and resumes useful work without making you manage its state.

## Assumptions

| Assumption | Evidence / status |
|---|---|
| Ownership matters independently of feature expansion | **Established by user intent.** |
| TUI should determine v1 priorities | **Supported by supervisor context.** RPC demand remains untested. |
| `/answer` matters to the replacement | **Supported by customized extraction configuration; frequency untested.** |
| Elaborate and type-changing are valuable repair paths | **Supported by existing behavior; personal usage frequency untested.** Keep until a replacement trial supplies contrary evidence. |
| Better skill instructions can eliminate repair features | **Untested and unsafe as a scope premise.** Upstream explicitly describes its policy as advisory. |
| Smaller result payloads improve reliability | **Plausible, untested.** Removing distinctions could instead make answers more ambiguous. |
| Preview panes, automatic recovery, or external integrations are unnecessary | **Untested.** They are candidates for deferral, not proven dead weight. |
| First-party ownership requires a clean-room rewrite | **Not established.** An attributed derivative can remove dependence on the upstream package. |
| The new package must preserve every upstream contract | **Not established.** Replacement fidelity and drop-in API compatibility are different commitments. |

## Drift / contradiction check

### 1. Cutting all repair paths assumes away the agent’s failure modes

Retain `/answer`, Elaborate, and live single/multi correction in the initial replacement scope. Simplify their supporting machinery where possible, but do not delete their user outcomes merely because their code is substantial.

A short daily-use replacement trial can later justify removal. Configuration inspection cannot.

### 2. “One reducer and two renderers” is not a product requirement

The upstream already separates state transitions from rendering and shares answer helpers and result serialization. Its RPC controller intentionally behaves differently: sequential dialogs, scalar selection or typed input, no notes or final review.

RPC is therefore not merely a second rendering of the same interaction. Building around two surfaces before confirming demand buys another behavior matrix to maintain.

**Correction:** choose TUI-first scope. Leave architecture to engineering review.

### 3. “Honor `required`” could introduce a new usability problem

Upstream explicitly makes `required` advisory. Enforcing it would let an agent-generated form trap the user until they supply an answer—even when the question is mistaken.

**Recommendation:** remove `required` from the new native contract rather than converting it into mandatory completion. Make unanswered questions explicit. Cancellation, omission, and uncertainty must never become implied approval.

### 4. Simpler results should mean less duplication, not less truth

Today, `cancelled: true` covers user cancellation, unavailable UI, and invalid input. Custom text is also copied into the same `values` array used for option values.

Those are better simplification targets than eliminating clarification requests:

- Distinguish user cancellation from inability to collect input and invalid questions.
- Keep typed text distinguishable from canonical choices.
- Separate committed answers from requests for explanation.
- Preserve which decisions remain unresolved.

A compact contract that loses these distinctions is not a clearer contract.

### 5. Rebranding does not permit erasing attribution

Remove upstream names from the new package’s operational identity. Do not erase required copyright and license notices if reusing substantial source: the MIT license names both upstream authors.

Likewise, owning the extension does not mean eliminating Pi’s host libraries or ordinary supporting dependencies. The relevant dependency to remove is reliance on the third-party extension’s releases and product decisions.

## Sharper product: cut, double down, add

### Cut or defer

| Scope choice | Why | Cost / consequence |
|---|---|---|
| **Defer interactive RPC support** | No demonstrated daily demand | Non-TUI callers receive an honest needs-input outcome, not a form. |
| **Cut the remote event bridge from v1** | No identified consumer | Trusted integrations would need a later, deliberate contract. It is a local event bus, not an existing network service. |
| **Defer the dedicated preview question type** | Descriptions can support ordinary choices | Rich comparisons are less convenient; retain enough explanation for informed answers. |
| **Cut global single-as-multi presentation** | It obscures the question’s original semantics | Keep explicit per-question correction instead. |
| **Cut the broad settings/migration framework** | First-party ownership need not inherit every historical configuration path | Preserve relevant personal preferences deliberately; do not silently rewrite old configuration. |
| **Simplify continuation metadata** | The current result repeats substantial context | Preserve the behavioral promise: answer the explanation request, retain settled answers, revisit only blockers. |

Do **not** interpret “cut dirty-dismiss knobs” as “remove protection against losing work.” Keep protection as a sensible default. The same distinction applies to explicit review versus a large menu of review settings.

### Double down

- **Repair without restarting:** `/answer`, question/option notes, Elaborate, custom text, and explicit single/multi correction.
- **Familiar TUI behavior:** keyboard-first navigation, native editing and `@` references, review before submission, protection against accidental discard.
- **Decision continuity:** carry settled answers forward instead of turning every clarification into another interview.
- **Question discipline:** inspect available context first; ask only for material gaps. Keep essential guidance available even when the skill is not loaded.
- **Attention management:** retain a modest waiting notification rather than rebuilding a notification integration platform.

Keeping the repair paths has a real price. `/answer` retains model selection, authentication, latency, and extraction failure handling. Elaborate retains context-carrying and follow-up semantics. Type correction retains destructive-change handling. That is justified complexity if this is to replace the tool you actually use.

### Add selectively

**1. A genuine text-only question.**  
The public upstream tool requires options; its extraction path has a special internal free-form representation. “Which directory?” should not require a fabricated choice before the user can type.

*Cost:* one additional first-class interaction case—not a general form system.

**2. A fidelity standard for `/answer`.**  
A repair command should not silently change the question. Upstream’s extraction logic imposes a four-option limit and can truncate options during repair (`src/answer-extraction.ts:197, 307–325`).

Preserve the choices actually offered, or expose the extraction limitation. Do not make lossy extraction look authoritative.

*Cost:* more attention to extraction failures and potentially longer forms.

**3. Explicit incomplete outcomes.**  
The product should communicate “unanswered,” “needs explanation,” and “could not ask” honestly instead of flattening them into apparent completion.

*Cost:* modest contract complexity in exchange for less ambiguity.

## Risks and evidence limits

- **Ownership transfers maintenance to you.** Rewriting mature keyboard, editor, and lifecycle behavior can cost more than maintaining a carefully reduced derivative.
- **Repair usage remains unmeasured.** Customized configuration is not a substitute for observing real sessions.
- **Prompt policy is not enforcement.** Better instructions cannot guarantee fewer unnecessary questions or prevent an agent from misinterpreting a response.
- **Extraction remains fallible.** `/answer` introduces an additional model request and its associated latency and disclosure of conversation excerpts.
- **“Recovery” needs precise language.** Upstream reopening reconstructs a form from its payload; it is not evidence of durable recovery of unsent editor drafts.
- **Compatibility is unresolved.** Keeping the name `ask_user` does not make a changed schema drop-in compatible, and both packages should not compete to register the same tool.

This is source and configuration review, not runtime validation. All requested source files were read; no interactive sessions or tests were run.

**Executor handoff:** none warranted. The next artifact is the PRD after resolving the product decisions below, not an implementation prompt.

---

## Recommended mode: **Selective expansion**

Hold the ownership-and-daily-use core. Remove unproven platforms and historical machinery; selectively strengthen question repair, free-text input, and answer fidelity.

This is not scope expansion for its own sake. It deliberately spends complexity on the known TUI interaction while declining a multi-surface clarification platform.

## One-page revised scope

### Product

**`pi-clarify` is the first-party TUI clarification tool that lets you answer, correct, or request explanation without losing the thread.**

### Primary user and surface

Initially, you: an existing daily Pi TUI user moving away from `@geoqiao/pi-ask`. Build for that replacement before optimizing for hypothetical RPC clients or public integration consumers.

### Core experience

The agent asks only when available context leaves a material decision unresolved, or when you request an interview. You can select one or several choices, give an unconstrained text answer, add context, or ask for explanation before deciding.

You can repair the agent’s presentation: convert prose questions through `/answer`, correct single/multi selection, and reopen a prior form on the current branch. Settled answers remain context for subsequent clarification.

Keep familiar editing, file references, deliberate submission, accidental-discard protection, and a basic waiting notification. Recommendations inform; they are not preselected answers.

### Contract promises

- Stable question and option identities.
- No fabricated choices merely to accommodate open-ended questions.
- Canonical selections remain distinguishable from typed text.
- Missing answers and requests for explanation remain visible.
- Cancel, invalid input, and unavailable UI are not interchangeable.
- Neither submission nor non-cancellation is blanket authorization.
- Normal `ask_user` calls require no extraction-model request.
- `/answer` is explicit and on-demand, with bounded failure handling and no silent option loss.

### Boundaries

No v1 remote event integration, interactive RPC, dedicated preview pane, global single-as-multi policy, or general configuration platform. Prefer a small set of deliberate preferences over inheriting every upstream knob.

Recommend branch-aware manual replay as the recovery baseline; automatic startup/resume/fork reopening remains a specific scope decision, not an implied promise of draft persistence.

Use first-party runtime naming and configuration. Leave existing user-owned configuration untouched unless migration is explicitly approved. Preserve required attribution when reusing source.

### Definition of a successful replacement

During a short daily-use trial, you can disable the incumbent without repeatedly returning to it for question repair, explanation, or reopening. The new tool does not introduce accidental submissions, lost in-form work, unnecessary questioning, or forgotten decisions.

Judge fewer interruptions and less re-entry—not feature count or lines of code. No telemetry platform is needed to make that judgment.

## Open decisions — need from the main agent before the PRD

1. **Compatibility target:** personal workflow replacement with a documented contract change, or drop-in compatibility for existing callers? Recommend the former unless actual consumers establish the latter.
2. **Repair retention:** adopt `/answer`, Elaborate, and live type correction as initial scope; establish their frequency during the trial rather than assuming they are unused.
3. **Recovery depth:** is branch-aware manual reopening sufficient initially, or is automatic recovery already important enough to be a launch requirement?
4. **Code ownership strategy:** adapt selected upstream code with attribution, or fund a rewrite? Do not equate ownership with rewriting.
5. **Preference transfer:** which existing settings and extraction choices must carry over? Recommend explicit, limited transfer rather than a permanent legacy compatibility framework.