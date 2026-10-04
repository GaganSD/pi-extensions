# Delegation benchmark

Compares `@gagansd/pi-subagents` with [`nicobailon/pi-subagents`](https://github.com/nicobailon/pi-subagents)
on five parent-composed workflows: parallel join, conditional fanout, bounded
repair, supervisor reply, and cancel/replace.

Published package-size, declared-context, and token-proxy figures live in
[`pi-subagents/README.md`](../pi-subagents/README.md). Token cells are
`ceil(JS UTF-16 characters / 4)` on reconstructed requests, not provider billing.

## Run

Pin models in gitignored `config.local.json` (see `config.local.json.example`).
Do not commit provider routes or credentials.

```sh
node benchmarks/prepare.mjs
node benchmarks/prepare.mjs --seal
cd benchmarks/<model> && uv run --no-project ../run.py <model>
```

One operator per model folder. 30 episodes each: 2 packages × 5 patterns × 3 seeds.
The outer session is not scored. The runner launches a real interactive Pi TUI
per episode. Existing complete collections are skipped; incomplete evidence is
left in place.

```sh
uv run --no-project python -m unittest discover -s benchmarks -p 'test_*.py'
uv run --no-project benchmarks/preflight.py
```

Preflight uses loopback fixtures and makes no foundation-model calls.

## Scoring

Same scenario text, thinking level, fresh children, and seeded inputs for both
packages. APIs and shipped role prompts stay different. No workflow script is
supplied. A pattern is fully verified only if all six episodes pass
(2 models × 3 seeds). Report successes out of 30 per package. The parent claim
is not a score.

| Pattern | Passes when |
| --- | --- |
| Parallel join | Two correct child values, correct sum, two children, real overlap |
| Conditional fanout | Route settles first; only the right branches run; correct total |
| Bounded repair | Reviewer-driven fixes only; exact final files; 1/0/1 repairs |
| Supervisor reply | Native question, correlated reply, child does not inherit the answer |
| Cancel/replace | Pending question cancelled before reuse; new child; no obsolete artifact |

## Tokens

Suite total = five episodes in one trial. Published average is the **median of
three suite totals**. Failed or stalled episodes stay in the suite; they are not
dropped to manufacture a cheaper run.

## Evidence

Raw results stay in `results/` and `.cache/`, both gitignored. Do not publish
transcripts, terminals, or credential copies.
