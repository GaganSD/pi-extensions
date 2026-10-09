import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { SessionEntry, SlashCommandInfo, Skill } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import type { SidebarMcpHost } from "./sidebar-mcp.ts";

export type SidebarUsage = {
  input: number | null; output: number | null; cacheRead: number | null;
  cacheWrite: number | null; total: number | null; cost: number | null;
};
export type SidebarSkill = { name: string; path: string; source: string; loaded: boolean };
export type SidebarCommand = { name: string; source: string; description?: string };
export type SidebarMcp = { name: string; enabled: boolean | null; source: string };
export type SidebarResources = { skills: SidebarSkill[]; commands: SidebarCommand[]; mcp: SidebarMcp[]; mcpError?: string };
export type SidebarSession = {
  id: string; name: string; pid: number; cwd: string; model: string; thinking: string;
  tokens: number | null; percent: number | null; contextWindow: number | null;
  estimated: boolean; rate: number | null; startedAt: number; lastTurnMs: number | null;
  working: boolean; turns: number; messages: number; usage: SidebarUsage;
};
export type SidebarFolds = { mcp: boolean; skills: boolean };
export const DEFAULT_SIDEBAR_FOLDS: SidebarFolds = { mcp: false, skills: false };

/** Display-only strings must never inject terminal commands or extra rows. */
export function sidebarText(value: unknown, max = 512): string {
  if (typeof value !== "string") return "";
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
export function parseSidebarFolds(value: unknown): SidebarFolds {
  const raw = record(value);
  return { mcp: raw?.mcp === true, skills: raw?.skills === true };
}
export function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function nonnegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Active-branch usage, including nested tools and summaries, once per owning entry. */
export function sidebarUsage(entries: readonly SessionEntry[]): SidebarUsage {
  const sums = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  const missing = new Set<keyof typeof sums>();
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    let usage: unknown;
    let expected: boolean;
    if (entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")) {
      usage = "usage" in entry.message ? entry.message.usage : undefined;
      expected = entry.message.role === "assistant";
    } else if (entry.type === "compaction" || entry.type === "branch_summary" || entry.type === "usage") {
      usage = entry.usage;
      expected = true;
    } else continue;
    const raw = record(usage);
    if (!raw) {
      if (expected) for (const key of Object.keys(sums) as Array<keyof typeof sums>) missing.add(key);
      continue;
    }
    for (const key of Object.keys(sums) as Array<keyof typeof sums>) {
      const value = nonnegative(key === "cost" ? record(raw.cost)?.total : raw[key]);
      if (value === null) missing.add(key);
      else { sums[key] += value; if (!Number.isFinite(sums[key])) missing.add(key); }
    }
  }
  // Pi's input is uncached input; cacheRead/cacheWrite are separate categories.
  const inbound = missing.has("input") || missing.has("cacheRead") || missing.has("cacheWrite")
    ? null : nonnegative(sums.input + sums.cacheRead + sums.cacheWrite);
  const output = missing.has("output") ? null : sums.output;
  return {
    input: inbound, output,
    cacheRead: missing.has("cacheRead") ? null : sums.cacheRead,
    cacheWrite: missing.has("cacheWrite") ? null : sums.cacheWrite,
    total: inbound === null || output === null ? null : nonnegative(inbound + output),
    cost: missing.has("cost") ? null : sums.cost,
  };
}

export function sidebarMessageCounts(entries: readonly SessionEntry[]): { turns: number; messages: number } {
  let turns = 0; let messages = 0;
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    if (entry.message.role === "user") turns += 1;
    if (entry.message.role === "user" || entry.message.role === "assistant") messages += 1;
  }
  return { turns, messages };
}

export function commandResources(commands: readonly SlashCommandInfo[]): { skills: SidebarSkill[]; commands: SidebarCommand[] } {
  const skills = new Map<string, SidebarSkill>();
  const result = new Map<string, SidebarCommand>();
  for (const command of commands) {
    if (command.source === "skill") {
      const path = command.sourceInfo?.path;
      if (path) skills.set(resolve(path), { name: sidebarText(command.name.replace(/^skill:/, "")), path: resolve(path), source: sidebarText(command.sourceInfo.scope), loaded: false });
    } else {
      const name = sidebarText(command.name);
      if (name) result.set(name, { name, source: command.source, description: sidebarText(command.description) });
    }
  }
  return { skills: [...skills.values()], commands: [...result.values()] };
}

function skillReadPath(tool: string, args: unknown, cwd: string): string | undefined {
  const path = record(args)?.path;
  if (tool !== "read" || typeof path !== "string") return undefined;
  // Match the builtin reader's @ prefix, Unicode spaces, file URLs and tilde.
  let normalized = path.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ").replace(/^@/, "");
  normalized = normalized.replace(/^~(?=\/|$)/, homedir());
  try { if (normalized.startsWith("file://")) normalized = fileURLToPath(normalized); } catch { return undefined; }
  return basename(normalized) === "SKILL.md" ? resolve(cwd, normalized) : undefined;
}

/** Catalog and observed reads are separate; discovery is never proof of loaded instructions. */
export class SidebarSkills {
  private catalog = new Map<string, SidebarSkill>();
  private reads = new Set<string>();
  private pending = new Map<string, string>();
  reset(commands: readonly SlashCommandInfo[]): void {
    this.catalog.clear(); this.reads.clear(); this.pending.clear();
    this.discoverCommands(commands);
  }
  discoverCommands(commands: readonly SlashCommandInfo[]): void {
    for (const skill of commandResources(commands).skills) this.catalog.set(skill.path, skill);
  }
  discover(skills: readonly Skill[]): void {
    // Structured prompt options include skills even when skill commands are disabled.
    this.catalog.clear();
    for (const skill of skills) this.catalog.set(resolve(skill.filePath), {
      name: sidebarText(skill.name), path: resolve(skill.filePath), source: sidebarText(skill.sourceInfo?.scope), loaded: false,
    });
  }
  readStart(id: string, tool: string, args: unknown, cwd: string): void {
    const path = skillReadPath(tool, args, cwd);
    if (path) this.pending.set(id, path);
  }
  readEnd(id: string, isError: boolean): void {
    const path = this.pending.get(id);
    this.pending.delete(id);
    if (path && !isError) this.reads.add(path);
  }
  observeNested(calls: readonly { name: string; arguments?: unknown; status: string }[], cwd: string): void {
    for (const call of calls) if (call.status === "ok") {
      const path = skillReadPath(call.name, call.arguments, cwd);
      if (path) this.reads.add(path);
    }
  }
  restore(entries: readonly SessionEntry[], cwd: string): void {
    this.reads.clear(); this.pending.clear();
    for (const entry of entries) {
      if (entry.type !== "message") continue;
      const message = entry.message;
      if (message.role === "assistant") {
        for (const block of message.content) {
          if (block.type === "toolCall") this.readStart(block.id, block.name, block.arguments, cwd);
        }
      } else if (message.role === "toolResult") {
        this.readEnd(message.toolCallId, message.isError);
        this.observeNested(message.nestedCalls?.calls ?? [], cwd);
      } else if (message.role === "user") {
        const text = typeof message.content === "string" ? message.content
          : message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
        this.observePrompt(text);
      }
    }
    this.pending.clear();
  }
  observePrompt(prompt: string): void {
    // Pi's explicit /skill invocation embeds its canonical path in the user message.
    const match = prompt.match(/^<skill\s+name="[^"]*"\s+(?:location|path)="([^"]+)"/);
    if (match) this.reads.add(resolve(match[1]!));
  }
  snapshot(): SidebarSkill[] {
    const skills = [...this.catalog.values()].map(skill => ({ ...skill, loaded: this.reads.has(skill.path) }));
    // Successfully observed instructions remain evidence even without a catalog
    // entry (disabled skill commands, removed resources, or explicit file loads).
    for (const path of this.reads) if (!this.catalog.has(path)) {
      skills.push({ name: sidebarText(basename(dirname(path))) || "SKILL.md", path, source: "observed", loaded: true });
    }
    return skills.sort((a, b) => Number(b.loaded) - Number(a.loaded) || a.name.localeCompare(b.name));
  }
}

type McpFile = { servers: Record<string, unknown>; error?: string };
export function parseMcpFile(text: string | undefined): McpFile {
  if (text === undefined) return { servers: {} };
  try {
    const raw = record(JSON.parse(text));
    const servers = record(raw?.mcpServers);
    if (!raw || (raw.mcpServers !== undefined && !servers)) return { servers: {}, error: "MCP config invalid" };
    return { servers: servers ?? {} };
  } catch { return { servers: {}, error: "MCP config unreadable" }; }
}

export function sidebarMcp(
  registered: readonly { name: string; config: unknown }[], global: McpFile, project?: McpFile, host?: SidebarMcpHost,
): SidebarMcp[] { return resolveMcp(registered, global, project, host).mcp; }

function resolveMcp(
  registered: readonly { name: string; config: unknown }[], global: McpFile, project: McpFile | undefined, host: SidebarMcpHost | undefined,
): { mcp: SidebarMcp[]; mcpError?: string } {
  const files = new Map<string, { config: Record<string, unknown>; source: string }>();
  const invalid = new Map<string, SidebarMcp>();
  let rejected = false;
  for (const [source, entries] of [["global", global.servers], ["project", project?.servers ?? {}]] as const) {
    for (const [name, raw] of Object.entries(entries)) {
      let value = raw;
      const entry = record(raw);
      let reject = false;
      if (host?.projectOverrides && source === "project" && entry
        && entry.command === undefined && entry.url === undefined && entry.type === undefined) {
        const base = files.get(name); // Only an exact-name global file entry, never a registration.
        reject = !base || Object.keys(entry).some(key => !["enabled", "exposure", "toolExposure"].includes(key));
        if (base) value = { ...base.config, ...entry };
      }
      const config = host && !reject ? record(host.validate(name, value)) : undefined;
      if (config && host) {
        reject = (host.projectOverrides && [...files.keys()].some(other => other !== name && host.namespace(other) === host.namespace(name)))
          || (host.projectOverrides && source === "project" && "url" in config && Boolean(config.auth));
      }
      if (!config || reject) {
        rejected ||= Boolean(host);
        invalid.set(name, { name: sidebarText(name), source, enabled: null });
      } else files.set(name, { config, source });
    }
  }
  const rows = new Map<string, SidebarMcp>();
  for (const server of registered) {
    if (host && [...files.keys()].some(name => host.namespace(name) === host.namespace(server.name))) continue;
    const config = host ? record(host.validate(server.name, server.config)) : undefined;
    rows.set(server.name, { name: sidebarText(server.name), source: "extension", enabled: config ? config.enabled !== false : null });
  }
  for (const [name, server] of files) rows.set(name, { name: sidebarText(name), source: server.source, enabled: server.config.enabled !== false });
  for (const [name, row] of invalid) if (!rows.has(name)) rows.set(name, row);
  return { mcp: [...rows.values()].sort((a, b) => a.name.localeCompare(b.name)),
    ...(!host ? { mcpError: "MCP configuration validation unavailable" } : rejected ? { mcpError: "MCP configuration has rejected entries" } : {}) };
}

/** File reads are bounded and cached outside render; never evaluate env or credential commands. */
export class SidebarMcpFiles {
  private cached = new Map<string, { key: string; value: McpFile }>();
  private host?: SidebarMcpHost;
  setHost(host: SidebarMcpHost | undefined): void { this.host = host; }
  read(path: string): McpFile {
    try {
      const stat = statSync(path);
      if (!stat.isFile() || stat.size > 1024 * 1024) return { servers: {}, error: "MCP config unreadable" };
      const key = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
      const old = this.cached.get(path);
      if (old?.key === key) return old.value;
      const value = parseMcpFile(readFileSync(path, "utf8"));
      this.cached.set(path, { key, value });
      return value;
    } catch (error) {
      this.cached.delete(path);
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? { servers: {} } : { servers: {}, error: "MCP config unreadable" };
    }
  }
  snapshot(agentDir: string, cwd: string, trusted: boolean, registered: readonly { name: string; config: unknown }[]): { mcp: SidebarMcp[]; mcpError?: string } {
    const global = this.read(join(agentDir, "mcp.json"));
    const project = trusted ? this.read(join(cwd, ".pi", "mcp.json")) : undefined;
    const result = resolveMcp(registered, global, project, this.host);
    const error = project?.error ?? global.error ?? result.mcpError;
    return { mcp: result.mcp, ...(error ? { mcpError: error } : {}) };
  }
  clear(): void { this.cached.clear(); }
}
