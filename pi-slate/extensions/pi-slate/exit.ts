import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function installExitCommand(pi: ExtensionAPI): void {
  pi.registerCommand("exit", {
    description: "Quit Pi",
    handler: async (_args, ctx) => {
      ctx.shutdown();
    },
  });
}
