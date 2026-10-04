import path from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { git } from "./workspace.ts";

const MAX_CHARS = 24000;
const Params = Type.Object({
  path: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
  stat: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

export function diffPath(value?: string): string[] {
  if (value === undefined) return [];
  if (!value.trim() || value.includes("\0") || value.startsWith("-") || value.startsWith(":") || path.isAbsolute(value)
    || /^[A-Za-z]:/.test(value) || /[*?[\]]/.test(value) || value.split(/[\\/]/).includes("..")) {
    throw new Error("diff path must be a relative path inside the repository");
  }
  return [value];
}
export async function captureHead(root: string, signal?: AbortSignal): Promise<string | undefined> {
  try { return (await git(root, ["rev-parse", "--verify", "HEAD"], signal)).trim(); }
  catch (error) {
    if (signal?.aborted) throw error;
    if (/not a git repository|Needed a single revision|unknown revision|bad revision/.test(String(error))) return undefined;
    throw error;
  }
}
/** Working-tree diff only. No general Git command access. */
export function diffTool(root: string, head?: string): ToolDefinition<typeof Params> {
  return {
    name: "diff", label: "Working-tree diff",
    description: "Read a bounded staged/unstaged diff against launch HEAD and untracked paths. No committed-range review. Use read for untracked contents.",
    parameters: Params,
    annotations: { readOnlyHint: true, openWorldHint: false },
    async execute(_id, args, signal) {
      const filter = diffPath(args.path);
      if (!head) throw new Error("No Git HEAD at launch. Supply a diff artifact or inspect files; do not claim this diff was reviewed.");
      // head sits in option position; only a full object id captured at launch is accepted.
      if (!/^[0-9a-f]{40,64}$/i.test(head)) throw new Error("diff baseline must be a Git object id captured at launch");
      // --no-textconv/--no-ext-diff do not disable Git clean/process filters. Enumerate
      // names only (never values) and suppress their executable hooks on every invocation.
      // (diff.<driver>.command cannot be blanked safely via -c; --no-ext-diff/--no-textconv
      // and --literal-pathspecs remain the driver/pager boundary.)
      const configKeys = (await git(root, ["config", "--list", "--name-only", "-z"], signal)).split("\0");
      const filters = new Set(configKeys.filter(key => /^filter\..+\.(clean|smudge|process|required)$/.test(key))
        .map(key => key.slice(0, key.lastIndexOf("."))));
      const overrides = [...filters].flatMap(name => ["-c", `${name}.clean=`, "-c", `${name}.smudge=`, "-c", `${name}.process=`, "-c", `${name}.required=false`]);
      const assertHead = async () => {
        if (await captureHead(root, signal) !== head) throw new Error("HEAD changed since launch; supply a diff artifact or relaunch the reviewer.");
      };
      await assertHead();
      const output = await git(root, [...overrides, "diff", "--no-color", "--no-ext-diff", "--no-textconv",
        ...(args.stat ? ["--stat"] : []), head, "--", ...filter], signal);
      const untracked = (await git(root, [...overrides, "ls-files", "--others", "--exclude-standard", "-z", "--", ...filter], signal))
        .split("\0").filter(Boolean);
      await assertHead();
      const paths = untracked.slice(0, 50).map(file => JSON.stringify(file));
      const omitted = untracked.length - paths.length;
      const combined = [
        output.trimEnd(),
        ...(untracked.length ? [`Untracked files (contents not reviewed):\n${paths.join("\n")}${omitted ? `\n${omitted} additional paths omitted.` : ""}`] : []),
      ].filter(Boolean).join("\n\n") || "No working-tree changes. Committed ranges are not included.";
      const text = combined.length > MAX_CHARS
        ? combined.slice(0, MAX_CHARS) + "\n[Truncated; narrow path. This is not the full diff.]"
        : combined;
      return { content: [{ type: "text", text }], details: { truncated: combined.length > MAX_CHARS, head } };
    },
  };
}
