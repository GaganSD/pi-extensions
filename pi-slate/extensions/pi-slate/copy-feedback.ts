import { copyToClipboard } from "@earendil-works/pi-coding-agent";

export type CopyNotify = (message: string, kind: "info" | "error") => void;

function flashOf(host: object | undefined): ((message: string, durationMs?: number) => void) | undefined {
  if (!host || !("flash" in host)) return undefined;
  const flash = (host as { flash?: unknown }).flash;
  return typeof flash === "function" ? flash.bind(host) as (message: string, durationMs?: number) => void : undefined;
}

/** Same confirmation Pi uses for drag-select. Prefer the flash; notify only when it is missing. */
export function confirmCopy(host: object | undefined, notify: CopyNotify): void {
  const flash = flashOf(host);
  if (flash) {
    flash("Copied!");
    return;
  }
  notify("Copied", "info");
}

export async function copyWithFeedback(
  host: object | undefined,
  notify: CopyNotify,
  text: string,
): Promise<void> {
  try {
    await copyToClipboard(text);
    confirmCopy(host, notify);
  } catch {
    notify("Could not copy", "error");
  }
}
