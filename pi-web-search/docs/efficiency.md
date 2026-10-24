# Retrieval efficiency and context budgets

## URL-only retrieval

`web_search({ urls: ["https://example.com/docs"] })` performs extraction without a search request. Omit `query` rather than passing an empty string. URL-only calls use keyless Jina Reader first; retryable failures use the existing web extraction chain, excluding Brave (which also delegates extraction to Jina). With both query and URLs, Exa and Parallel start their search and extraction concurrently; Brave pairs REST search with Jina extraction. Both paths share the operation deadline and caller cancellation. A URL-only provider failure can trigger the normal retryable fallback chain; in a combined call, extraction failure becomes a warning alongside successful search evidence.

Ordinary search defaults remain anonymous Exa MCP with anonymous Parallel MCP fallback. Brave is optional and key-required; Jina URL-only extraction is keyless. Neither adds a model-facing tool, argument, or instruction. Jina is extraction-only and never joins search/research fan-out.

## Progressive evidence

The tool returns a compact preview and, when available, `resultId`, `storedCount`, and `storedClipped`. `search_read` is a stable codemode-exposed tool, not another default direct declaration. Find it with `searchTools` or call `tools.search_read` from codemode.

- Omit `index` to list stored result URLs and titles. A long list is explicitly truncated.
- Select a zero-based `index` to read its provider-returned text.
- `offset` is a JavaScript character offset. `limit` defaults to 2,000 characters, accepts 2–4,000, and keeps surrogate pairs intact. `passage.nextOffset` indicates further stored text.
- `find` locates the first case-insensitive literal match with nearby context and reports the total match count. It cannot combine with `offset`. No fuzzy matching, embeddings, or model call is involved.
- Missing/expired handles and invalid indexes return structured errors. Reading never refetches silently.

Only post-judgment, admitted evidence enters the store. Suppressed passages cannot be recovered by continuation. Every continuation still passes through Pi's normal tool pipeline. Ordinary searches do not classify evidence; optional classification remains a heuristic, not a security boundary.

Storage is memory-only and session-scoped: no document files or session JSONL copies. The store has a 10-minute lifetime, 32-entry and 8 MiB aggregate limits, at most 256 results per entry, 64,000 characters per passage and 256,000 passage characters per entry. Non-URL metadata is capped at 1,000 characters per field. Oldest entries are evicted first. `storedClipped` reports local clipping; entries too large to fit are not stored. Shutdown clears that session's entries. Reload, restart and fork do not restore handles. Existing branches within a session share its handle namespace.

**Provider-returned evidence is not necessarily a full page.** For example, Exa URL extraction currently requests at most 3,000 characters per URL. Jina retains at most 64,000 characters per document, fetches at most three documents concurrently, and caps each JSON response at 1 MiB. It requests Markdown without images or link destinations and verifies returned page identity. Individual Jina page failures are reported without discarding successful siblings. Continuation recovers text beyond the preview, not text that the upstream provider never returned.

## One global preview budget

After optional judgment, exact URL + passage + result-type duplicates are combined with contributing source names. Distinct passages, query strings, fragments/code anchors, and search-versus-extraction evidence are preserved. This is deterministic, not semantic similarity ranking.

`maxResults` limits the returned preview count across all contributing providers and URL extracts. Requested-page extracts are ordered first, then remaining ranked/provider-ordered results. This order is also used by stored indexes. Overflow remains in the bounded store when a handle is available; otherwise the omission warning recommends another retrieval.

Model-facing excerpts are capped at 400 characters each. Structured excerpts share a 12,000-character total budget and a 4,000-character per-hit maximum, allocated across results so early long documents cannot starve every later preview. Separate limits bound provider prose, metadata and warnings. Citation URLs are not shortened; these are evidence-text budgets, not a strict total byte/token cap for arbitrary URLs. Provider prose is removed only when exact equality proves it duplicates rendered results.

## Quota-aware reuse

Direct HTTP providers use a bounded, session-local cache:

- 30-second lifetime, 64 entries, 2 MiB aggregate; no disk writes.
- Identity includes query, URLs, operation, resolved settings, provider and credential fingerprint. Raw credentials are not stored in keys. Rotation or settings changes invalidate reuse.
- Successful results with evidence and no provider warnings can be reused. Errors and partial extraction failures are not cached as successful evidence.
- Identical concurrent requests share work. Each caller can cancel independently; the last departing caller aborts shared work. Shared transport work still has its own bounded deadline.
- HTTP `Retry-After` on 429 is parsed as seconds or an HTTP date, capped at 60 seconds. Without one, a rate-limit error yields a 30-second cooldown. Other failures do not become cooldowns. The fallback chain skips cooling-down providers through a retryable error rather than sleeping or aggressively retrying.
- A cache hit carries a freshness notice. Reuse and cooldowns are cleared at session shutdown; stale entries are pruned on later activity.

Parallel is deliberately excluded from cache/coalescing/cooldowns at this layer: every nested MCP call must run Pi's permission and result hooks. We never replay an old permission decision or replace a denied native call with a private transport. Outer web/code tool hooks also run on every cache hit.

## Parallel MCP decision

Parallel documents anonymous access at `https://search.parallel.ai/mcp`; the REST Search API requires an API key. We retain the native MCP adapter for keyless operation, host-managed connections and nested permission checks. It does not make a nested LLM call or add nested calls to model history. Its tools are not declared directly to the model. Outer web/research tools declare the Parallel namespace with `reachesTools`, so Pi waits for cold-start MCP tool registration before execution rather than racing it. Connection startup, server summaries and codemode discovery still have overhead; this is not a claim that MCP is free.

Removing Pi's registration and using a private MCP client would hide service discovery but would still speak MCP and lose the existing nested permission hook boundary. Switching to REST would remove that protocol only for authenticated users. Neither tradeoff is made silently.

References: [Parallel programmatic use](https://docs.parallel.ai/integrations/mcp/programmatic-use), [Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp), [REST Search](https://docs.parallel.ai/api-reference/search/search).

## Reproducible footprint checks

Run `npm run bench:context`. It creates isolated, offline Pi SDK sessions and measures host-built tool declarations and system-prompt deltas, plus direct-text and programmatic result fixtures. The continuation schema size is reported separately because it is not a default direct declaration. The benchmark does not start the remote MCP connection or include codemode's discovery/loadout overhead. It uses `ceil(characters / 4)`, **not provider tokenizer billing**.

At implementation time (Pi 1.3.0), the direct declaration/prompt estimate fell from **443 to 410** for default tools and **648 to 615** with research enabled. The codemode-only continuation parameter schema is 500 characters. This is not an end-to-end latency or search-quality benchmark. The 24-document fixture returns eight previews, about 3.8k direct-text characters and 16.8k structured characters.

`tests/footprint.test.ts` enforces regression ceilings for default/research declarations, continuation schema, preview count, and direct/structured result size. Live provider reliability and quality require separate, opt-in measurements.
