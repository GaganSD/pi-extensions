import { Type } from "typebox";
import { THINKING_LEVELS, type RunRecord, type Task } from "./types.ts";
import { keys, modelName, object, text, thinkingLevel } from "./validation.ts";

const ThinkingSchema = Type.String({ enum: [...THINKING_LEVELS] });
const TaskSchema = Type.Object({
  agent: Type.String({ minLength: 1, maxLength: 64 }),
  task: Type.String({ minLength: 1, maxLength: 32768 }),
  cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  model: Type.Optional(Type.String({ minLength: 3, maxLength: 512 })),
  thinking: Type.Optional(ThinkingSchema),
}, { additionalProperties: false });
/** Object-root tool input with a closed per-action union; no cross-action field mixes. */
export const Parameters = Type.Union([
  Type.Object({ action: Type.Literal("run"), tasks: Type.Array(TaskSchema, { minItems: 1, maxItems: 4 }) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("list"), cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: "Profile discovery directory for list" })) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("status"), id: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("stop"), id: Type.String({ minLength: 1, maxLength: 64 }) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("steer"), id: Type.String({ minLength: 1, maxLength: 64 }), message: Type.String({ minLength: 1, maxLength: 8192 }) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("reply"), id: Type.String({ minLength: 1, maxLength: 64 }), requestId: Type.String({ minLength: 1, maxLength: 64 }), message: Type.String({ minLength: 1, maxLength: 8192 }) }, { additionalProperties: false }),
], { type: "object" });

export type Request =
  | { action: "run"; tasks: Task[] }
  | { action: "list"; cwd?: string }
  | { action: "status"; id?: string }
  | { action: "stop"; id: string }
  | { action: "steer"; id: string; message: string }
  | { action: "reply"; id: string; requestId: string; message: string };

/** Validate discriminated field combinations even if the caller bypassed the JSON schema. */
export function parseRequest(input: unknown): Request {
  const value = object(input, "subagent");
  switch (value.action) {
    case "run": {
      keys(value, ["action", "tasks"], "run");
      if (!Array.isArray(value.tasks) || value.tasks.length < 1 || value.tasks.length > 4) throw new Error("run requires 1–4 tasks");
      const tasks = value.tasks.map((input): Task => {
        const task = object(input, "task");
        keys(task, ["agent", "task", "cwd", "model", "thinking"], "task");
        return {
          agent: text(task.agent, "agent", 64), task: text(task.task, "task"),
          ...(task.cwd === undefined ? {} : { cwd: text(task.cwd, "cwd", 4096) }),
          ...(task.model === undefined ? {} : { model: modelName(task.model) }),
          ...(task.thinking === undefined ? {} : { thinking: thinkingLevel(task.thinking) }),
        };
      });
      return { action: "run", tasks };
    }
    case "list":
      keys(value, ["action", "cwd"], "list");
      return { action: "list", ...(value.cwd === undefined ? {} : { cwd: text(value.cwd, "cwd", 4096) }) };
    case "status":
      keys(value, ["action", "id"], "status");
      return { action: "status", ...(value.id === undefined ? {} : { id: text(value.id, "id", 64) }) };
    case "stop":
      keys(value, ["action", "id"], "stop");
      return { action: "stop", id: text(value.id, "id", 64) };
    case "steer":
      keys(value, ["action", "id", "message"], "steer");
      return { action: "steer", id: text(value.id, "id", 64), message: text(value.message, "message", 8192) };
    case "reply":
      keys(value, ["action", "id", "requestId", "message"], "reply");
      return { action: "reply", id: text(value.id, "id", 64), requestId: text(value.requestId, "requestId", 64), message: text(value.message, "message", 8192) };
    default: throw new Error("Unsupported action. Use run/list/status/steer/stop/reply.");
  }
}

const clip = (value: string, max: number) => value.length > max ? value.slice(0, max) + "…" : value;

/** Allowlisted control view. Full briefs, configuration and usage stay in evidence. */
export function presentRun(record: RunRecord) {
  return {
    id: record.id, state: record.state, metadataPath: record.metadataPath,
    model: record.model, thinking: record.thinking,
    ...(record.question ? { question: { id: record.question.id, message: clip(record.question.message, 2048) } } : {}),
    ...(record.reportPath ? { reportPath: record.reportPath } : {}),
    ...(record.error ? { error: clip(record.error, 512) } : {}),
    ...(record.notificationError ? { notificationError: clip(record.notificationError, 512) } : {}),
    ...((record.question?.message.length ?? 0) > 2048 || (record.error?.length ?? 0) > 512 || (record.notificationError?.length ?? 0) > 512 ? { truncated: true as const } : {}),
  };
}
export function presentFinished(record: RunRecord) {
  return {
    id: record.id, state: record.state, agent: record.agent, taskPreview: clip(record.task, 80),
    ...(record.reportPath ? { reportPath: record.reportPath } : {}),
    ...(record.error ? { error: clip(record.error, 512) } : {}),
    ...(record.state !== "completed" ? { metadataPath: record.metadataPath } : {}),
    ...((record.error?.length ?? 0) > 512 ? { truncated: true as const } : {}),
  };
}
/** Turn-triggering wake-ups carry only agent-controlled fields; sub-agent free text stays behind status/metadata. */
export function presentNotice(record: RunRecord) {
  return {
    id: record.id, state: record.state, agent: record.agent, taskPreview: clip(record.task, 80),
    ...(record.reportPath ? { reportPath: record.reportPath } : {}),
    ...(record.state !== "completed" ? { metadataPath: record.metadataPath } : {}),
  };
}
export function presentLaunch(records: RunRecord[]) {
  return { runs: records.map(({ id, cwd, workspace, model, thinking }) => ({ id, cwd, workspace, model, thinking })) };
}
export function presentSummary(record: RunRecord) {
  return { id: record.id, agent: record.agent, state: record.state, taskPreview: clip(record.task, 80) };
}
// Escape display controls without changing the machine-readable string values.
const serialize = (value: unknown) => JSON.stringify(value).replace(/[\u007f-\u009f\u061c\u200e-\u200f\u202a-\u202e\u2066-\u2069]/g,
  char => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"));
export function resultPreview(result: unknown): string {
  const serialized = serialize(result);
  if (serialized.length <= 24000) return serialized;
  // Never cut JSON or paths in half. Keep every run identity and disclose omitted fields.
  // The result is unknown at this boundary; narrow defensively instead of throwing here.
  const asRecord = (input: unknown): Record<string, unknown> | undefined =>
    input !== null && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined;
  const field = (input: unknown): string | undefined => typeof input === "string" ? input : undefined;
  let summary: Record<string, unknown>;
  if (Array.isArray(result)) {
    const profiles = result.slice(0, 100).flatMap(item => {
      const row = asRecord(item);
      return row ? [{ name: field(row.name), mode: field(row.mode) }] : [];
    });
    summary = { profiles, omitted: Math.max(0, result.length - 100) };
  } else {
    const value = asRecord(result) ?? {};
    if (Array.isArray(value.runs)) {
      const runs = value.runs.slice(0, 32).flatMap(item => {
        const row = asRecord(item);
        const id = row && field(row.id);
        if (!id) return [];
        const state = field(row.state);
        return [{ id, ...(state ? { state } : {}) }];
      });
      summary = { runs, omitted: Math.max(0, value.runs.length - 32) };
    } else {
      const id = field(value.id);
      summary = id ? { id, state: field(value.state), metadataPath: field(value.metadataPath) } : {};
    }
  }
  return serialize({ ...summary, truncated: true, message: "Fields omitted. Full result is in details/structuredContent; for runs, use status by exact ID and read metadata before acting." });
}

const closed = { additionalProperties: false };
const ModeSchema = Type.String({ enum: ["inspect", "edit"] });
const StateSchema = Type.String({ enum: ["starting", "running", "waiting_for_agent", "cancelling", "completed", "failed", "cancelled", "cleanup_unknown"] });
const RunSchema = Type.Object({
  id: Type.String(), state: StateSchema,
  agent: Type.Optional(Type.String()), taskPreview: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()), thinking: Type.Optional(ThinkingSchema),
  question: Type.Optional(Type.Object({ id: Type.String(), message: Type.String() }, closed)),
  reportPath: Type.Optional(Type.String()), metadataPath: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()), notificationError: Type.Optional(Type.String()),
  truncated: Type.Optional(Type.Literal(true)),
}, closed);
/** The same compact contract reaches the model and native/codemode callers. */
export const OutputSchema = Type.Union([
  Type.Object({
    runs: Type.Array(Type.Union([
      Type.Object({ id: Type.String(), cwd: Type.String(), workspace: Type.String(), model: Type.String(), thinking: ThinkingSchema }, closed),
      Type.Object({ id: Type.String(), agent: Type.String(), state: StateSchema, taskPreview: Type.String() }, closed),
    ])),
    blocked: Type.Optional(Type.Union([Type.Literal(true), Type.Object({ id: Type.String(), metadataPath: Type.String() }, closed)])),
  }, closed),
  Type.Array(Type.Object({
    name: Type.String(), description: Type.String(), mode: ModeSchema,
    model: Type.Optional(Type.String()), thinking: Type.Optional(Type.String()),
  }, closed)),
  RunSchema,
  Type.Object({ ok: Type.Literal(true) }, closed),
]);

export const DESCRIPTION = `Delegate only when requested by the operator or applicable instructions.
run launches 1–4 fresh, session-bound native Pi sub-agents; ordered receipts are NOT results or a join.
Sub-agents have fixed tools and applicable instruction files, but no agent history, extensions, hooks, MCP or skills.
Do not launch tasks needing unavailable capabilities or policies. Modes are inspect (read-only) and edit (shell/write), not OS sandboxes.
Use list with the target cwd to inspect profiles. Reserve returned workspaces until settled; parallel writers need separate existing worktrees.
Questions/results wake this agent: yield, do not poll. Use exact run IDs; reply also needs the current question ID.
status lists live/recent runs; status(id) gives control state, resolved model/thinking, and evidence paths. /subagents provides human control.
Control receipts mean accepted, not compliance. Completed means settled and saved, not verified; read the report and validate.
Committed-range review needs a supplied diff. No resume, model fallback, recursive delegation or workflow runner.`;
