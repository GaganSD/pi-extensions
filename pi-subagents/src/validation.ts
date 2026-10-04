import { THINKING_LEVELS, type Thinking } from "./types.ts";

export function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || value === Object.prototype || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}
export function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${label}: unsupported field '${key}'`);
  }
}
export function text(value: unknown, label: string, max = 32768): string {
  // Cheap length/NUL bounds run before trim() copies or scans an oversized payload.
  if (typeof value !== "string" || value.length > max || value.includes("\0")) {
    throw new Error(`${label} must be nonempty text of at most ${max} characters without NUL`);
  }
  const result = value.trim();
  if (!result) throw new Error(`${label} must be nonempty text of at most ${max} characters without NUL`);
  return result;
}
export function modelName(value: unknown): string {
  const result = text(value, "model", 512);
  if (!/^[^/\s:]+\/[^\s:]+$/.test(result)) throw new Error("model must be an exact provider/id, not an alias or thinking suffix");
  return result;
}
export function thinkingLevel(value: unknown): Thinking {
  const result = text(value, "thinking", 16);
  if (!THINKING_LEVELS.includes(result as Thinking)) throw new Error("thinking must be off, minimal, low, medium, high, xhigh, or max");
  return result as Thinking;
}
