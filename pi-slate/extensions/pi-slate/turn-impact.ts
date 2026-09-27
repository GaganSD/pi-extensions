import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export type TurnEvent = {
  id: string;
  toolName: string;
  title: string;
  detail: string;
  isError: boolean;
  pending: boolean;
};

export type TurnImpactSnapshot = {
  revision: number;
  toolsCalled: number;
  events: TurnEvent[];
};

type PendingCall = {
  event: TurnEvent;
  input?: Record<string, unknown>;
};

/** Transient, UI-local facts observed during the current user prompt. */
export class TurnImpactTracker {
  private events: TurnEvent[] = [];
  private pending = new Map<string, PendingCall>();
  private toolsCalled = 0;
  private revision = 0;

  reset(): TurnImpactSnapshot {
    this.events = [];
    this.pending.clear();
    this.toolsCalled = 0;
    this.revision += 1;
    return this.snapshot();
  }

  restore(entries: readonly SessionEntry[]): TurnImpactSnapshot {
    this.reset();
    for (const entry of entries) {
      if (entry.type !== "message") continue;
      const message = entry.message;
      if (message.role === "user") {
        this.reset();
      } else if (message.role === "assistant") {
        for (const part of message.content) {
          if (part.type !== "toolCall") continue;
          this.toolCall({ toolCallId: part.id, toolName: part.name, input: part.arguments });
        }
      } else if (message.role === "toolResult") {
        this.toolEnd({
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          result: message.content,
          isError: message.isError,
        });
      }
    }
    return this.snapshot();
  }

  toolCall(call: { toolCallId: string; toolName: string; input?: Record<string, unknown> }): TurnImpactSnapshot {
    const input = call.input && typeof call.input === "object" ? call.input : undefined;
    this.toolsCalled += 1;
    const event: TurnEvent = {
      id: call.toolCallId,
      toolName: call.toolName,
      title: eventTitle(call.toolName, input),
      detail: formatDetail(call.toolName, input, undefined, false, true),
      isError: false,
      pending: true,
    };
    this.events.push(event);
    this.pending.set(call.toolCallId, { event, input });
    this.revision += 1;
    return this.snapshot();
  }

  toolEnd(end: { toolCallId: string; isError: boolean; result?: unknown; toolName?: string }): TurnImpactSnapshot {
    let pending = this.pending.get(end.toolCallId);
    if (!pending) {
      const toolName = end.toolName || "tool";
      this.toolsCalled += 1;
      const event: TurnEvent = {
        id: end.toolCallId,
        toolName,
        title: eventTitle(toolName, undefined),
        detail: "",
        isError: end.isError,
        pending: false,
      };
      this.events.push(event);
      pending = { event };
    }
    this.pending.delete(end.toolCallId);
    pending.event.pending = false;
    pending.event.isError = end.isError;
    pending.event.detail = formatDetail(pending.event.toolName, pending.input, end.result, end.isError, false);
    this.revision += 1;
    return this.snapshot();
  }

  snapshot(): TurnImpactSnapshot {
    return {
      revision: this.revision,
      toolsCalled: this.toolsCalled,
      events: this.events,
    };
  }
}

export function isShellTool(toolName: string): boolean {
  return toolName === "bash" || toolName === "powershell";
}

export function eventTitle(toolName: string, input: Record<string, unknown> | undefined): string {
  const path = typeof input?.path === "string" ? input.path : undefined;
  const command = typeof input?.command === "string" ? input.command : undefined;
  const pattern = typeof input?.pattern === "string" ? input.pattern : undefined;
  const agent = typeof input?.agent === "string" ? input.agent : undefined;
  const task = typeof input?.task === "string" ? input.task : undefined;
  if (toolName === "read" || toolName === "edit" || toolName === "write") {
    return path ? `${toolName} ${path}` : toolName;
  }
  if (isShellTool(toolName)) return command ? `${toolName} ${command}` : toolName;
  if (toolName === "subagent") {
    return [agent, task].filter(Boolean).join(" · ") || "subagent";
  }
  if (path) return `${toolName} ${path}`;
  if (pattern) return `${toolName} ${pattern}`;
  return toolName;
}

export function formatResult(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result)) {
    return result.map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) return String((part as { text: unknown }).text);
      try {
        return JSON.stringify(part);
      } catch {
        return String(part);
      }
    }).join("");
  }
  if (typeof result === "object" && result && "content" in result) {
    return formatResult((result as { content: unknown }).content);
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

export function formatDetail(
  toolName: string,
  input: Record<string, unknown> | undefined,
  result: unknown,
  isError: boolean,
  pending: boolean,
): string {
  const state = pending ? "pending" : isError ? "error" : "ok";
  const body = formatResult(result);
  return [state, ...prettyInput(input), body].filter((part) => part.length > 0).join("\n");
}

function prettyInput(input: Record<string, unknown> | undefined): string[] {
  if (!input) return [];
  const path = typeof input.path === "string" ? input.path : undefined;
  const command = typeof input.command === "string" ? input.command : undefined;
  const pattern = typeof input.pattern === "string" ? input.pattern : undefined;
  const agent = typeof input.agent === "string" ? input.agent : undefined;
  const task = typeof input.task === "string" ? input.task : undefined;
  const lines = [
    path,
    command,
    pattern,
    [agent, task].filter(Boolean).join(" · ") || undefined,
  ].filter((line): line is string => Boolean(line));
  if (lines.length > 0) return lines;
  const json = JSON.stringify(input, null, 2);
  return json === "{}" ? [] : [json];
}

type ActivityCategory = "inspected" | "edited" | "ran" | "delegated";

const INSPECTION_TOOLS = new Set(["read", "grep", "find", "ls"]);
const ACTIVITY_CATEGORIES: ActivityCategory[] = ["inspected", "edited", "ran", "delegated"];

function plural(count: number, singular: string, many = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : many}`;
}

function activityCategory(toolName: string): ActivityCategory | undefined {
  if (INSPECTION_TOOLS.has(toolName)) return "inspected";
  if (toolName === "edit" || toolName === "write") return "edited";
  if (isShellTool(toolName)) return "ran";
  if (toolName === "subagent") return "delegated";
  return undefined;
}

/** Compact, disjoint activity facts for the latest user prompt. */
export function formatTurnImpact(snapshot: TurnImpactSnapshot): string[] {
  if (snapshot.toolsCalled === 0) return ["No tool activity"];
  const counts = new Map<ActivityCategory, number>();
  for (const event of snapshot.events) {
    const category = activityCategory(event.toolName);
    if (category) counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  const breakdown = ACTIVITY_CATEGORIES.flatMap((category) => {
    const count = counts.get(category) ?? 0;
    return count > 0 ? [`${count} ${category}`] : [];
  });
  return [plural(snapshot.toolsCalled, "action"), ...(breakdown.length > 0 ? [breakdown.join(" · ")] : [])];
}
