import { constants } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { createTwoFilesPatch } from "diff";
import {
  createEditToolDefinition, createWriteToolDefinition,
  type ExtensionAPI, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { DIFF_MAX_BYTES, diffText, readDiffConfig, type DiffConfig } from "./pi-diff-config.ts";
import { DiffHighlighter } from "./pi-diff-highlight.ts";
import { PiDiffView } from "./pi-diff-renderer.ts";

export type WriteDiffDetails = { slateDiff: { patch?: string; note?: string } };

/** Read only a bounded regular-file snapshot. Preview failure must never prevent a write. */
async function beforeWrite(path: string): Promise<string | undefined> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > DIFF_MAX_BYTES) return undefined;
      const buffer = Buffer.alloc(DIFF_MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > DIFF_MAX_BYTES) return undefined;
      const text = buffer.subarray(0, length).toString("utf8");
      return text.includes("\0") ? undefined : text;
    } finally {
      await file.close();
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "" : undefined;
  }
}

export function writeDiff(before: string | undefined, after: string): WriteDiffDetails {
  if (before === undefined) return { slateDiff: { note: "Diff preview unavailable: previous content was unreadable, binary, or larger than 256 KiB." } };
  if (Buffer.byteLength(after) > DIFF_MAX_BYTES || Buffer.byteLength(before) > DIFF_MAX_BYTES || after.includes("\0")) {
    return { slateDiff: { note: "Diff preview omitted: binary content or file exceeds 256 KiB." } };
  }
  try {
    // Fixed headers avoid interpreting unusual filenames as patch metadata.
    const patch = createTwoFilesPatch("before", "after", before, after, undefined, undefined, {
      context: 3, timeout: 50, maxEditLength: 4000,
    });
    if (patch !== undefined && Buffer.byteLength(patch) <= DIFF_MAX_BYTES) return { slateDiff: { patch } };
  } catch {
    // The mutation already succeeded; presentation is best effort.
  }
  return { slateDiff: { note: "Diff preview omitted: comparison exceeded its size or time limit." } };
}

export function createDiffTools(config: DiffConfig, highlighter: DiffHighlighter) {
  const originalEdit = createEditToolDefinition(process.cwd());
  const originalWrite = createWriteToolDefinition(process.cwd());
  const edit: typeof originalEdit = {
    ...originalEdit,
    renderShell: "default",
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("edit ")) + theme.fg("accent", diffText(args?.path ?? "")), 0, 0);
    },
    renderResult(result, options, theme, context) {
      if (options.isPartial) return new Text(theme.fg("muted", "Editing…"), 0, 0);
      const patch = result.details?.patch;
      if (!context.isError && typeof patch === "string") {
        const previous = context.lastComponent;
        if (previous instanceof PiDiffView && previous.patch === patch && previous.path === context.args?.path && previous.expanded === options.expanded) return previous;
        return new PiDiffView(patch, context.args?.path ?? "", "edit", options.expanded, config, highlighter, context.invalidate);
      }
      const text = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
      const fallback = !context.isError && result.details?.diff ? result.details.diff : text;
      return new Text(theme.fg(context.isError ? "error" : "toolOutput", fallback.split("\n").map(diffText).join("\n")), 0, 0);
    },
  };
  const write: ToolDefinition<typeof originalWrite.parameters, WriteDiffDetails | undefined> = {
    ...originalWrite,
    renderShell: "default",
    async execute(id, args, signal, onUpdate, ctx) {
      if (ctx.mode !== "tui") return originalWrite.execute(id, args, signal, onUpdate, ctx);
      let before: string | undefined;
      // This callback runs inside Pi's own file-mutation queue. Do not acquire a second lock.
      const tool = createWriteToolDefinition(ctx.cwd, { operations: {
        mkdir: async (dir) => { await mkdir(dir, { recursive: true }); },
        writeFile: async (path, content) => {
          before = await beforeWrite(path);
          if (signal?.aborted) throw new Error("Operation aborted");
          await writeFile(path, content, "utf8");
        },
      } });
      const result = await tool.execute(id, args, signal, onUpdate, ctx);
      return { ...result, details: writeDiff(before, args.content) };
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("write ")) + theme.fg("accent", diffText(args?.path ?? "")), 0, 0);
    },
    renderResult(result, options, theme, context) {
      if (options.isPartial) return new Text(theme.fg("muted", "Writing…"), 0, 0);
      const preview = result.details?.slateDiff;
      if (!context.isError && typeof preview?.patch === "string") {
        const previous = context.lastComponent;
        if (previous instanceof PiDiffView && previous.patch === preview.patch && previous.path === context.args?.path && previous.expanded === options.expanded) return previous;
        return new PiDiffView(preview.patch, context.args?.path ?? "", "write", options.expanded, config, highlighter, context.invalidate);
      }
      let text = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
      if (!context.isError && preview?.note) text += `\n${preview.note}`;
      return new Text(theme.fg(context.isError ? "error" : "toolOutput", text.split("\n").map(diffText).join("\n")), 0, 0);
    },
  };
  return { edit, write };
}

export function installPiDiff(pi: ExtensionAPI): void {
  const config = readDiffConfig();
  if (!config.enabled) return;
  const highlighter = new DiffHighlighter(config);
  const tools = createDiffTools(config, highlighter);
  pi.registerTool(tools.edit);
  pi.registerTool(tools.write);
  pi.on("session_shutdown", () => highlighter.dispose());
}
