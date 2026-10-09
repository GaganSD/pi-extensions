import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { installExitCommand } from "../extensions/pi-slate/exit.ts";

test("/exit registers a quit alias that shuts down", async () => {
  const commands = new Map<string, { description: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
  installExitCommand({
    registerCommand(name: string, command: { description: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI);

  const command = commands.get("exit");
  assert.ok(command);
  assert.equal(command.description, "Quit Pi");

  let shutdowns = 0;
  await command.handler("", { shutdown() { shutdowns += 1; } } as ExtensionCommandContext);
  assert.equal(shutdowns, 1);
});
