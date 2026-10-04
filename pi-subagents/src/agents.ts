import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { Profile } from "./types.ts";
import { keys, modelName, object, text, thinkingLevel } from "./validation.ts";

const BUNDLED = fileURLToPath(new URL("../agents/", import.meta.url));
export function parseProfile(contents: string, source: string): Profile {
  if (Buffer.byteLength(contents) > 32768) throw new Error(`Agent profile too large: ${source}`);
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(contents);
  if (!match) throw new Error(`Missing YAML frontmatter: ${source}`);
  let raw: unknown;
  try {
    raw = parse(match[1]!, { uniqueKeys: true, maxAliasCount: 0 });
  } catch (error) {
    throw new Error(`Invalid YAML frontmatter: ${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const data = object(raw, source);
  keys(data, ["name", "description", "mode", "model", "thinking"], source);
  const name = text(data.name, "agent name", 64);
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`Invalid agent name: ${name}`);
  if (path.basename(source, ".md") !== name) throw new Error(`Agent name must match filename: ${source}`);
  if (data.mode !== "inspect" && data.mode !== "edit") throw new Error(`Agent '${name}' needs mode: inspect or edit`);
  return {
    name, description: text(data.description, "description", 512), mode: data.mode,
    model: data.model === undefined ? undefined : modelName(data.model),
    thinking: data.thinking === undefined ? undefined : thinkingLevel(data.thinking),
    prompt: text(match[2], "role prompt", 30000).trim(), source,
  };
}

/** Only flat, regular Markdown files. Project trust is resolved by the caller. */
export async function loadProfiles(agentDir: string, cwd: string, trusted: boolean, bundled = BUNDLED): Promise<Map<string, Profile>> {
  const profiles = new Map<string, Profile>();
  for (const root of [bundled, path.join(agentDir, "agents"), ...(trusted ? [path.join(cwd, ".pi", "agents")] : [])]) {
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && root !== bundled) continue; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const source = path.join(root, entry.name);
      try {
        if ((await stat(source)).size > 32768) throw new Error(`Agent profile too large: ${source}`);
        const profile = parseProfile(await readFile(source, "utf8"), source);
        profiles.set(profile.name, profile);
      } catch (error) {
        // Bundled profiles are package integrity and stay fail-fast. One broken
        // user/project file must not disable every other role; list shows what loaded.
        if (root === bundled) throw error;
      }
    }
  }
  return profiles;
}
