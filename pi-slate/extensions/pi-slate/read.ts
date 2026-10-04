import {
  createReadToolDefinition,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import {
  isHiddenRead,
  readCallText,
  readItemFromArgs,
  ReadGrouper,
  readResultLines,
  replaySessionReads,
} from "./read-group.ts";

const hidden: Component = { render: () => [], invalidate() {} };

function assistantId(message: { timestamp?: number }): string {
  return String(message.timestamp ?? "");
}

function messageHasText(message: { role?: string; content?: unknown }): boolean {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return false;
  for (const part of message.content) {
    if (
      part && typeof part === "object" && "type" in part && part.type === "text"
      && "text" in part && typeof part.text === "string" && part.text.length > 0
    ) return true;
  }
  return false;
}

export function createReadTool(grouper: ReadGrouper, cwd = process.cwd()) {
  const original = createReadToolDefinition(cwd);
  const read: typeof original = {
    ...original,
    renderShell: "self",
    renderCall(args, theme, context) {
      grouper.bind(context.toolCallId, context.invalidate);
      const group = grouper.groupFor(context.toolCallId);
      if (isHiddenRead(group, context.toolCallId)) return hidden;
      const fallback = readItemFromArgs(context.toolCallId, args);
      const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      const label = readCallText(group, fallback);
      text.setText(theme.fg("toolTitle", theme.bold("read")) + theme.fg("accent", label.slice(4)));
      return text;
    },
    renderResult(_result, options, theme, context) {
      const group = grouper.groupFor(context.toolCallId);
      if (isHiddenRead(group, context.toolCallId)) return hidden;
      const lines = readResultLines(group, options.expanded);
      if (lines.length === 0) return hidden;
      const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      text.setText(lines.map((line) => theme.fg("muted", line)).join("\n"));
      return text;
    },
  };
  return read;
}

export function installRead(pi: ExtensionAPI): void {
  const grouper = new ReadGrouper();
  let currentAssistantId: string | undefined;
  pi.registerTool(createReadTool(grouper));

  const hydrate = (ctx: ExtensionContext): void => {
    currentAssistantId = undefined;
    replaySessionReads(grouper, ctx.sessionManager.getBranch());
  };

  pi.on("session_start", (_event, ctx) => hydrate(ctx));
  pi.on("session_tree", (_event, ctx) => hydrate(ctx));
  pi.on("session_shutdown", () => {
    grouper.reset();
    currentAssistantId = undefined;
  });
  pi.on("message_start", (event) => {
    if (event.message.role === "user") grouper.seeOther();
    if (event.message.role === "assistant") currentAssistantId = assistantId(event.message);
  });
  pi.on("message_update", (event) => {
    if (event.message.role !== "assistant") return;
    currentAssistantId = assistantId(event.message);
    if (messageHasText(event.message)) grouper.seeText(currentAssistantId);
  });
  pi.on("message_end", (event) => {
    if (event.message.role === "user") grouper.seeOther();
    if (event.message.role === "assistant" && messageHasText(event.message)) {
      grouper.seeText(assistantId(event.message));
    }
  });
  pi.on("tool_call", (event) => {
    if (event.parentToolCallId) return;
    if (event.toolName === "read") {
      grouper.seeRead(readItemFromArgs(event.toolCallId, event.input), currentAssistantId);
      return;
    }
    grouper.seeOther();
  });
}
