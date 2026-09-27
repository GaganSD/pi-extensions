import { SLATE_ISSUES_URL } from "./layout.ts";

export { SLATE_ISSUES_URL };

export function formatBugReport(title: string, body: string): string {
  return title ? `# ${title}\n\n${body}` : body;
}

export function issueTemplate(env: { slateVersion: string; piVersion: string; platform: string }): string {
  return [
    "## What happened",
    "",
    "",
    "## Expected",
    "",
    "",
    "## Environment",
    "",
    `- pi-slate: ${env.slateVersion}`,
    `- pi: ${env.piVersion}`,
    `- platform: ${env.platform}`,
    "",
  ].join("\n");
}

export function openExternalArgs(target: string, platform = process.platform): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [target] };
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", `"${target}"`] };
  return { command: "xdg-open", args: [target] };
}
