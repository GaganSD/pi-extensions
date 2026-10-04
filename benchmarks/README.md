# Delegation benchmark

## Run it

The local artifacts and model-folder defaults have already been prepared. Open four terminals:

```sh
cd benchmarks/luna  && pi
cd benchmarks/kimi  && pi
cd benchmarks/grok  && pi
cd benchmarks/astra && pi
```

In **each** Pi session, say:

```text
execute prompt.txt
```

Each operator runs 30 episodes: **2 packages × 5 patterns × 3 seeded trials**.
Four operators collect **120 fresh parent episodes**, 60 per package. Operators
may run concurrently; each one's paired episodes run sequentially. Provider rate
limits can still affect results. Do not compare wall-clock speed across concurrent
operators.

To split a model's work, use `execute prompt-trial-1.txt`, then `prompt-trial-2.txt`,
then `prompt-trial-3.txt`. These use the same episodes as `prompt.txt`, not extra
trials. Never launch two operators in the same model folder simultaneously.

The outer operator is not scored. The runner explicitly selects the scored model
and creates a real terminal-backed interactive Pi process for **each episode**.
This is necessary because the smaller package supports interactive npm Pi, not
print/RPC/standalone mode. The terminal runner does not compose the scenario's
workflow: the model and the package under test do that.

| Folder | Exact scored model | Thinking |
| --- | --- | --- |
| `luna` | `openai/gpt-6-luna` | medium |
| `kimi` | `bedrock-runtime/us.moonshotai.kimi-k3` | medium |
| `grok` | `bedrock/xai.grok-4.6` | medium |
| `astra` | `openai/gpt-6-astra` | high |

Routes are pinned in `config.json`; the Kimi route supports medium thinking,
unlike some alternative Kimi routes. No automatic model/provider fallback.

## Evidence

Each folder gets a `results/` directory:

```text
results/
  summary.json
  episodes/<model>-t<trial>-<pattern>-<variant>/
    prompt.txt                 # Exact prompt given to the scored parent
    collection.json             # Host-collected facts; NOT a pass/fail verdict
    events.jsonl                # Passive parent request/tool/lifecycle capture
    terminal.log                # Raw TUI output for diagnosing failures
    baseline-events.jsonl       # Same-cwd, no-package, zero-call baseline
    agent/                      # Physical parent/child transcripts and package artifacts
    workspace/
      .git/                     # Independent seeded repository
      *.txt                     # Actual task inputs/outputs
      answer.json
      result.json               # Parent's claims and evidence pointers
```

The collector removes its private copies of `auth.json`, `models.json`, and
`models-store.json` after each episode. Runtime credential directories are private.
All raw results and caches are git-ignored. Do not upload them without reviewing
for secrets and private model/provider metadata. No automatic publishing.

When the operators finish, return to the original agent. We will independently
reconcile every child, check artifacts and ordering, calculate comparable token
figures, then replace the README placeholders and render the image.

## Scope and scoring policy

Same scenario text, models, thinking, fresh child context, and seeded inputs for
both packages. Package APIs and shipped role prompts remain different by design.
Upstream may use its native generated workflow scripts; no prewritten workflow
solution is supplied to either package. No skill/tool description stripping to
manufacture a smaller upstream baseline. Bundled skills and prompts remain
available; unrelated extensions/MCP/global instructions are excluded.

| Pattern | Independent acceptance checks |
| --- | --- |
| Parallel → join | Three correct child-derived values, correct ordered join and sum, three distinct children, actual overlapping child execution—not just a batch receipt. |
| Discover → conditional fanout | Routing child settles before branch launch; route selects only the correct child/children; both branch children overlap on the `both` seed; correct total. |
| Review → repair → repeat | Reviewer-driven first-error repairs; exact final file; 2/0/1 repairs for trial 1/2/3; fresh reviews after writers settle; no parent substitution. |
| Question → reply → continue | Real native question, exact correlated reply, no premature write, correct token; child does not inherit parent decision. |
| Cancel → replace | Actual pending question, no answer to obsolete child, confirmed cancellation before workspace reuse, new child identity, correct replacement and no obsolete artifact. |

Also verify every child's actual selected model/thinking and fresh-session
boundary. The parent cannot assign its own score. Missing evidence is unverified,
not a pass. Infrastructure/model failures stay visible. Unexpected extra logical
children and protocol violations must be reported; do not select only good runs.
A pattern is marked fully verified only if **all 12 episodes** pass (4 models ×
3 seeds). Report total successes **out of 60 per package** alongside the pattern
count; this small sample is not a population reliability estimate.

The three seeded trials vary routing, loop length, and question token. They are
not three repetitions of an identical input. Every scenario is tiny so orchestration,
not coding difficulty, is what is being examined. This benchmark tests overlapping
supported workflows, **not feature parity**: detached durability, scheduling,
recursion, and mission management are out of scope.

## Metrics for the README and image

### Footprint

- **Unpacked package bytes:** actual frozen release-build tarball contents,
  excluding installed dependencies and shared Pi peers. The upstream compiled
  artifact includes its shipped maps, declarations, docs, and other resources;
  this is distribution size, not an apples-to-apples executable-code comparison.
  Both are local release builds, not a claim about currently published npm artifacts.
- **Startup context estimate:** rendered system prompt and declared tool schemas
  compared with a same-cwd baseline under the same Pi and model. The observer has
  no tools, descriptions, or injected instructions.
- **Delegation-active context estimate:** first real request where the full
  `subagent` schema is exposed, with the same baseline subtraction. This preserves
  upstream lazy loading instead of assuming its full schema is always loaded.
- Estimate rendered prompt as `ceil(JS UTF-16 characters / 4)` and each tool as
  `ceil((name + ': ' + description + '\n' + compact parameters JSON).length / 4)`.
  Sum components then subtract the baseline sum. Includes rendered snippets,
  guidelines, bundled skill discovery, and system instructions exactly once.
  Task messages and child-result wake-ups are not static footprint.
- Report per-model startup/active figures or their explicit range; do not hide
  model-dependent lazy activation in a single favorable number.

This follows the reference's **character proxy**, not provider tokenizer/billing
counts. Counting boundaries differ from its tools-only benchmark: ours includes
as-installed package resource context. The reference compares a different upstream
(`tintinweb/pi-subagents`), so its numbers are not reused.

### Model token usage

The lower table has two package columns plus change—not an ambiguous single
“tokens consumed” column. For each model, each seeded trial is one five-pattern
suite (five independent parent episodes per package). Report the **median of the
three suite totals**, and publish all per-episode figures alongside it.

Count reported `usage.totalTokens` from each physical parent and child assistant
message plus standalone usage/compaction entries. Deduplicate by session ID and
entry ID. Never add nested tool-result usage rollups on top of child transcripts;
never add reasoning tokens again when already included in output. Preserve input,
output, cache-read, and cache-write breakdowns. Reconcile cancelled/failed runs and
all launched children before treating totals as complete. Missing usage is not zero.

These are reported token volumes, not dollar costs or cache-adjusted savings.
Do not call a failed/partial cheaper run more efficient. Show success counts
alongside consumption, and withhold a savings claim when task completion or
usage coverage differs. Optional character-proxy episode totals require correct
request reconstruction including repeated context, not counting transcript bytes once.

## Preparation and safe maintenance

```sh
node benchmarks/prepare.mjs --check    # Pins, artifact hashes, models and supported thinking; no live calls
uv run --no-project benchmarks/run.py grok --dry-run
uv run --no-project benchmarks/run.py grok --smoke  # Startup-only real TUI checks; no model calls
uv run --no-project python -m unittest discover -s benchmarks -p 'test_*.py'
```

`prepare.mjs` initially clones the pinned upstream commit, runs its own release
build, packs both packages, and freezes `.cache/manifest.json`. It does not change
the user's installed packages or global settings. The snapshots are checked
before live execution; future source edits do not change an in-progress campaign.
Package archives, hashes, source commits, versions, and file lists are retained.

A repeated completed collection is skipped, not silently repeated. Partial evidence,
a stale/concurrent `.running` lock, an invalid model/thinking level, or a timeout
blocks continuation. The 10-minute episode deadline requests normal Pi shutdown;
external termination after the grace period is recorded as uncertain cleanup.
Inspect failures before authorizing any new campaign/retry. Some upstream background
work can outlive the parent by design; never assume an external kill cleaned it up.
Keep the frozen artifacts, scenario hashes, and raw evidence for final auditing.

References:
- <https://github.com/kunkun9527/my-lean-pi-setup>
- <https://github.com/nicobailon/pi-subagents/tree/8983754bb3ef6603cbbe46dcc2314ec8563ffc23>
