import {
  estimateTokens,
  sessionEntryToContextMessages,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";

export function estimateContextTokensFromEntries(entries: readonly SessionEntry[]): number {
  let tokens = 0;
  for (const entry of entries) {
    for (const message of sessionEntryToContextMessages(entry)) {
      tokens += estimateTokens(message);
    }
  }
  return tokens;
}

export function sessionSpend(entries: readonly SessionEntry[]): number {
  let cost = 0;
  for (const entry of entries) {
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      cost += usageCost(entry.usage);
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "assistant" || message.role === "toolResult") {
      cost += usageCost("usage" in message ? message.usage : undefined);
    }
  }
  return cost;
}

export function resolveContextTokens(
  usage: { tokens: number | null; percent: number | null; contextWindow: number } | undefined,
  contextEntries: readonly SessionEntry[],
  modelWindow?: number,
): { tokens: number | null; percent: number | null } {
  if (usage?.tokens != null && Number.isFinite(usage.tokens)) {
    return { tokens: usage.tokens, percent: usage.percent };
  }
  const tokens = estimateContextTokensFromEntries(contextEntries);
  const window = usage?.contextWindow || modelWindow;
  if (!window || window <= 0) return { tokens, percent: null };
  return { tokens, percent: (tokens / window) * 100 };
}

function usageCost(usage: { cost?: { total?: number } } | undefined): number {
  const total = usage?.cost?.total;
  return typeof total === "number" && Number.isFinite(total) ? total : 0;
}
