# Delegation benchmark

## Run it

The local artifacts and model-folder defaults are prepared. Open **one** terminal
at a time so the two remaining models do not compete with dropped OpenAI/Bedrock
routes:

```sh
cd benchmarks/luna && pi   # needs OpenAI credits; billing errors are not retried
```

When Luna finishes, then:

```sh
cd benchmarks/kimi && pi
```

In **each** Pi session, say:

```text
execute prompt.txt
```

Each operator runs 30 episodes: **2 packages × 5 patterns × 3 seeded trials**.
Two operators collect **60 fresh parent episodes**, 30 per package. Run them
**sequentially**. The runner waits 15 seconds between episodes and lets Pi retry
transient 429/overload errors with backoff. Billing/auth failures still abort.
Do not compare wall-clock speed.

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
    runtime-location.json       # Original private root → retained runtime/ alias
    runtime/
      events.jsonl              # Parent request/tool/lifecycle capture
      terminal.log              # Raw TUI output for diagnosing failures
      baseline-events.jsonl     # Same-cwd, no-package, zero-call baseline
      agent/                    # Physical parent/child sessions and package artifacts
      upstream-temp/            # Upstream lifecycle, terminal, supervisor, workflow evidence
      native-status.json        # Upstream full fleet snapshot before normal exit
      workspace/
        .git/                   # Independent seeded repository
        *.txt                   # Actual task inputs/outputs
        answer.json
        result.json             # Parent's claims and evidence pointers
```

Runtime roots and homes are private temporary directories, outside the repository's
instruction-file ancestry. Each child’s actual cwd, applicable ancestor inventory,
shipped role body/hash, selected model and thinking are recorded for reconciliation.
Changing `HOME` excludes user `~/.agents` overrides; source cloud credential-file
locations are preserved explicitly when required. The collector removes private
`auth.json`, `models.json`, and `models-store.json` copies on normal, setup-failure,
timeout and handled-interruption paths, and records cleanup results.

Evidence is copied and hash-inventoried only after bounded teardown. Absolute paths
in native records use the alias in `runtime-location.json` after the temporary root
is removed. Do not require the original temporary directory for reconciliation.
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
| Parallel → join | Two correct child-derived values, correct ordered join and sum, two distinct children, actual overlapping child execution—not just a batch receipt. |
| Discover → conditional fanout | Routing child settles before branch launch; route selects only the correct child/children; both branch children overlap on the `both` seed; correct total. |
| Review → repair → repeat | Reviewer-driven first-error repair; exact final file; 1/0/1 repairs for trial 1/2/3; fresh review after the writer settles; no parent substitution. |
| Question → reply → continue | Real native question, exact correlated reply, no premature write, correct token; child does not inherit parent decision. |
| Cancel → replace | Actual pending question, no answer to obsolete child, confirmed cancellation before workspace reuse, new child identity, correct replacement and no obsolete artifact. |

Also verify every child's actual selected model/thinking and fresh-session
boundary. The parent cannot assign its own score. Missing evidence is unverified,
not a pass. Infrastructure/model failures stay visible. Unexpected extra logical
children and protocol violations must be reported; do not select only good runs.
A pattern is marked fully verified only if **all 6 episodes** pass (2 models ×
3 seeds). Report total successes **out of 30 per package** alongside the pattern
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
- **Startup declared-context estimate:** rendered system prompt and declared tool schemas
  compared with a same-cwd baseline under the same Pi and model. The observer has
  no tools, descriptions, or injected instructions.
- **Delegation-active declared-context estimate:** first real request where the full
  `subagent` schema is exposed, with the same baseline subtraction. This preserves
  upstream lazy loading instead of assuming its full schema is always loaded.
- Estimate rendered prompt as `ceil(JS UTF-16 characters / 4)` and each tool as
  `ceil((name + ': ' + description + '\n' + compact parameters JSON).length / 4)`.
  Sum components then subtract the baseline sum. Includes rendered snippets,
  guidelines, bundled skill discovery, and system instructions exactly once.
  Task messages, child-result wake-ups, and on-demand guide/skill reads are excluded
  from this declared-context metric, but included in reported total usage.
- Report per-model startup/active figures or their explicit range; do not hide
  model-dependent lazy activation in a single favorable number.

This follows the reference's **character proxy**, not provider tokenizer/billing
counts. Counting boundaries differ from its tools-only benchmark: ours includes
declared package resource context, not every package-induced message. The reference compares a different upstream
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
all launched children before treating totals as complete. The inventory labels each
assistant entry's stop reason and coverage. Abort/error/zero usage is **unknown**,
not free; partial positive usage remains a lower bound. A paused-tool cancellation
can synthesize a zero-usage SDK error even without a provider request, as demonstrated
by the loopback probes. Do not infer that the corresponding real-provider record is
free without independent reconciliation. Unknown coverage can leave token cells
unreportable; no complete-consumption or savings claim is allowed in that case.

These are reported token volumes, not dollar costs or cache-adjusted savings.
Do not call a failed/partial cheaper run more efficient. Show success counts
alongside consumption, and withhold a savings claim when task completion or
usage coverage differs. Optional character-proxy episode totals require correct
request reconstruction including repeated context, not counting transcript bytes once.

## Preparation and safe maintenance

```sh
node benchmarks/prepare.mjs --check    # Sealed protocol, CLI/Node/SDK/dependencies/routes; no model calls
uv run --no-project benchmarks/run.py luna --dry-run
uv run --no-project benchmarks/run.py luna --smoke  # Startup-only real TUI checks; no model calls
uv run --no-project python -m unittest discover -s benchmarks -p 'test_*.py'
uv run --no-project benchmarks/preflight.py             # Both packages, all five native patterns
uv run --no-project benchmarks/preflight.py --variant upstream --scenario parallel_join --lazy
uv run --no-project benchmarks/preflight.py --failures   # Early/blocked claims, deadlines, SIGINT/SIGTERM
```

`prepare.mjs` initially clones the pinned upstream commit, runs its release build,
and packs both packages. A version-2 manifest seals the entire protocol (including
operators, scenarios, recorder, preparation, runner and tests), the exact Pi CLI,
Node executable, SDK and installed dependency inventories, and sanitized physical
model routes. Unexpected resources or changed files are rejected. Credential values
are never fingerprinted or published. The exact validated CLI is launched by
absolute path; actual startup Pi/Node/model/thinking/route identities are attested.

Frozen recorder/scenario copies are executed. The verified runner rejects protocol
changes before each new episode and before accepting resumed collections. It does
not change installed packages or global settings. Before the first scored episode
only, `prepare.mjs --seal` can establish a corrected protocol campaign while keeping
the original frozen distribution artifacts. It refuses after scored evidence exists.

`preflight.py` uses scripted loopback SSE responses, real native children and tools,
plus an inherited Node network guard that rejects non-loopback connections. It
uses no real credential environment and makes **zero foundation-model calls**.
These probes exercise infrastructure, not LLM success rates or performance. Their
ignored evidence is stored in `.cache/preflight/`, never the scored model folders.
`preflight.py --foreground` additionally checks upstream direct foreground
completion, question detachment into retained foreground state, correlated reply,
and five early-finish/timeout/interruption paths. It preserves the shipped writer
acceptance contract rather than disabling it.

A repeated completed collection is skipped only under the same sealed campaign and
protocol. Partial evidence, a stale/concurrent `.running` lock, attestation failure,
or an incomplete lifecycle blocks continuation; no silent retry or overwrite.
Required usage parsing and child attestation must succeed before the collector
assigns `collected`; resume rechecks those requirements, not just the saved label.
Under each model's admission lock, every prior trial's episode/startup evidence is
checked before admission or resume. Partial, invalid, foreign-campaign or
cleanup-unknown evidence blocks even a different `--trial`; releasing `.running`
does not waive that gate. Already-admitted independent model operators are not
retroactively terminated.
Expected UNKNOWN cancellation usage remains admissible evidence, never free usage.

`result.json` is a claim, **not a join**. Normal exit requires native terminal file
records, an upstream full fleet check (including retained foreground work), and
external owned-process quiescence. Cached upstream fleet/async projections can lag
completion; they are preserved but are not terminal authority. Early/blocked claims
with live children trigger teardown, not successful collection.

The 10-minute deadline aborts the parent stream and requests native cancellation.
The host tracks a random inherited ownership marker, descendants and precise PID
birth identities across reparenting. Discovery snapshots are only hints: marker
and ancestry checks use fresh per-PID inspections bracketed by generation queries,
with parent-incarnation checks for descendants and another check before signalling.
A 14-second absolute host teardown budget bounds escalation/reaping after abort;
unreaped children or failed inspection produce cleanup **unknown**, retain private
runtime/evidence, clean available credential files, and block continuation. The
known direct-child fallback and PTY closure do not depend on a working inspector.
Bounded SIGTERM/SIGKILL escalation is recorded, never treated as a normal successful
collection. No process-group-only cleanup.
The guardian has no model-facing tools/instructions and does not solve scenarios.

SIGINT/SIGTERM use the same bounded teardown and credential cleanup. **SIGKILL and
machine failure cannot run finalizers.** A retained `.running` lock, partial episode,
and `runtime-location.json` identify remnants; inspect owned processes and remove
private credential remnants manually before any approved restart. Never clear them
blindly. Containment supports Darwin/Linux and is not an OS sandbox or a remote
provider billing/cancellation guarantee. Keep all frozen artifacts and evidence.

References:
- <https://github.com/kunkun9527/my-lean-pi-setup>
- <https://github.com/nicobailon/pi-subagents/tree/8983754bb3ef6603cbbe46dcc2314ec8563ffc23>
