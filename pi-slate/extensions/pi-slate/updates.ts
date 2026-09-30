import { DefaultPackageManager, getAgentDir, SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";

export type PiUpdate = { current: string; next: string };

export type UpdateNotice = {
  pi?: PiUpdate;
  packages: string[];
};

const LATEST_VERSION_URL = "https://pi.dev/api/latest-version";

export function formatUpdateNotice(notice: UpdateNotice): string | undefined {
  const names: string[] = [];
  if (notice.pi) names.push(`pi ${notice.pi.current} → ${notice.pi.next}`);
  for (const pkg of notice.packages) names.push(pkg);
  if (names.length === 0) return undefined;
  const label = names.length === 1 ? "update available" : `${names.length} updates available`;
  const command = notice.pi ? "pi update" : "pi update --extensions";
  return `${label} · ${names.join(", ")} · ${command}`;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const left = parseVersion(candidate);
  const right = parseVersion(current);
  if (!left || !right) return candidate.trim() !== current.trim();
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const a = left[i] ?? 0;
    const b = right[i] ?? 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return false;
}

function parseVersion(value: string): number[] | undefined {
  const core = value.trim().split(/[-+]/)[0] ?? "";
  if (!/^\d+(\.\d+)*$/.test(core)) return undefined;
  return core.split(".").map(Number);
}

export async function checkPiUpdate(current = VERSION): Promise<PiUpdate | undefined> {
  if (process.env.PI_OFFLINE || process.env.PI_SKIP_VERSION_CHECK) return undefined;
  try {
    const response = await fetch(LATEST_VERSION_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return undefined;
    const data = (await response.json()) as { version?: unknown };
    if (typeof data.version !== "string" || !data.version.trim()) return undefined;
    const next = data.version.trim();
    if (!isNewerVersion(next, current)) return undefined;
    return { current, next };
  } catch {
    return undefined;
  }
}

export async function checkPackageUpdates(cwd: string): Promise<string[]> {
  if (process.env.PI_OFFLINE) return [];
  try {
    const agentDir = getAgentDir();
    const packageManager = new DefaultPackageManager({
      cwd,
      agentDir,
      settingsManager: SettingsManager.create(cwd, agentDir),
    });
    const updates = await packageManager.checkForAvailableUpdates();
    return updates.map((update) => update.displayName);
  } catch {
    return [];
  }
}

export class UpdateWatcher {
  notice: UpdateNotice = { packages: [] };
  private onChange: () => void = () => {};

  setOnChange(fn: () => void): void {
    this.onChange = fn;
  }

  start(cwd: string): void {
    void this.refresh(cwd);
  }

  async refresh(cwd: string): Promise<void> {
    const [pi, packages] = await Promise.all([checkPiUpdate(), checkPackageUpdates(cwd)]);
    this.notice = {
      ...(pi ? { pi } : {}),
      packages,
    };
    this.onChange();
  }
}
