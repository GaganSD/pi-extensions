import { createHash } from "node:crypto";
import { braveApiKey, exaApiKey, githubToken } from "../env.ts";
import { awaitWithSignal, withTimeout } from "./http.ts";
import type { SearchRequest, SearchTransport } from "./index.ts";
import { isProviderError, providerError, type EvidenceProvider, type StreamResult } from "./types.ts";

const TTL_MS = 30_000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 64;
interface Cached { owner: string; value: StreamResult; expires: number; bytes: number }
interface Pending { owner: string; promise: Promise<StreamResult>; controller: AbortController; users: number }
const cache = new Map<string, Cached>();
const pending = new Map<string, Pending>();
const cooldowns = new Map<string, { owner: string; until: number }>();
let bytes = 0;

function remove(key: string): void { const item = cache.get(key); if (item) bytes -= item.bytes; cache.delete(key); }
export function clearRetrievalCache(owner?: string): void {
	for (const [key, item] of cache) if (!owner || item.owner === owner) remove(key);
	for (const [key, item] of pending) if (!owner || item.owner === owner) { item.controller.abort(providerError("aborted", "Session closed.")); pending.delete(key); }
	for (const [key, item] of cooldowns) if (!owner || item.owner === owner) cooldowns.delete(key);
}

/** Native nested calls must execute on every invocation: never cache permission decisions. */
export async function reuseTransport(kind: EvidenceProvider, req: SearchRequest, transport: SearchTransport): Promise<StreamResult> {
	const owner = req.reuseScope;
	if (!owner || kind === "parallel") return transport(req);
	if (req.signal?.aborted) throw req.signal.reason;
	const credential = kind === "exa" ? exaApiKey() : kind === "github" ? githubToken() : kind === "brave" ? braveApiKey() : undefined;
	const policy = createHash("sha256").update(JSON.stringify([owner, kind, req.settings, credential ?? "anonymous"])).digest("hex");
	const key = createHash("sha256").update(JSON.stringify([policy, req.query, req.urls, req.fetchOnly])).digest("hex");
	const now = Date.now();
	for (const [id, entry] of cache) if (entry.expires <= now) remove(id);
	for (const [id, entry] of cooldowns) if (entry.until <= now) cooldowns.delete(id);
	const hit = cache.get(key);
	if (hit) return { ...structuredClone(hit.value), warnings: [...(hit.value.warnings ?? []), "Reused session evidence (at most 30 seconds old)."] };
	const cooldown = cooldowns.get(policy);
	if (cooldown) throw providerError("rate_limited", `${kind} is cooling down for ${Math.ceil((cooldown.until - now) / 1000)}s after rate limiting.`);
	let job = pending.get(key);
	if (!job) {
		// Bounded in-flight bookkeeping; overflow remains a normal uncached call.
		if (pending.size >= 16) return transport(req);
		const controller = new AbortController();
		const composed = withTimeout(controller.signal, req.settings.timeoutMs);
		job = { owner, controller, users: 0, promise: Promise.resolve().then(async () => {
			try {
				const value = await awaitWithSignal(transport({ ...req, signal: composed.signal, onUpdate: undefined }), composed.signal);
				if (composed.signal.aborted) throw composed.signal.reason;
				const size = Buffer.byteLength(JSON.stringify(value));
				// Do not reuse partial failures or quota diagnostics from URL extraction.
				if (size <= MAX_BYTES && !value.warnings?.length && value.searchResults?.length) {
					while (cache.size >= MAX_ENTRIES || bytes + size > MAX_BYTES) remove(cache.keys().next().value!);
					cache.set(key, { owner, value: structuredClone(value), expires: Date.now() + TTL_MS, bytes: size }); bytes += size;
				}
				return value;
			} catch (error) {
				if (!composed.signal.aborted && isProviderError(error) && error.code === "rate_limited") {
					if (cooldowns.size >= MAX_ENTRIES) cooldowns.delete(cooldowns.keys().next().value!);
					cooldowns.set(policy, { owner, until: Date.now() + Math.min(60_000, error.retryAfterMs ?? 30_000) });
				}
				throw error;
			} finally { composed.dispose(); if (pending.get(key) === job) pending.delete(key); }
		}) };
		pending.set(key, job);
	}
	job.users++;
	try {
		const value = req.signal ? await awaitWithSignal(job.promise, req.signal) : await job.promise;
		return structuredClone(value);
	} finally {
		job.users--;
		if (job.users === 0 && pending.get(key) === job) {
			pending.delete(key);
			job.controller.abort(providerError("aborted", "All callers cancelled."));
		}
	}
}
