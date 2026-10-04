import type { Config } from "./types.ts";
import { keys, object } from "./validation.ts";

export const DEFAULT_CONFIG: Readonly<Config> = Object.freeze({
  maxConcurrent: 4, maxRuns: 32, timeoutMs: 1800000,
});
export function parseConfig(value: unknown): Config {
  if (value === undefined) return { ...DEFAULT_CONFIG };
  const source = object(value, "minimalSubagents");
  const result = { ...DEFAULT_CONFIG };
  // Accept the retired history limit without rewriting anyone's settings.
  const bounds = { maxConcurrent: [1, 4], maxRuns: [1, 256], timeoutMs: [1000, 7200000], historyLimit: [1, 200] } as const;
  keys(source, Object.keys(bounds), "minimalSubagents");
  for (const key of Object.keys(bounds) as (keyof typeof bounds)[]) {
    const value = source[key];
    if (value === undefined) continue;
    const [min, max] = bounds[key];
    if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
      throw new Error(`minimalSubagents.${key} must be an integer between ${min} and ${max}`);
    }
    if (key !== "historyLimit") result[key] = value as number;
  }
  return result;
}
