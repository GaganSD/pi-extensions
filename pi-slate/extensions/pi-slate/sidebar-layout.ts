export type SidebarSlots = { header: number; middle: number; tasks: number; image: number; footer: number };

/** Allocate once for both painting and hit testing. Never depend on composer height. */
export function sessionSidebarSlots(height: number, taskCount: number, hasImage: boolean): SidebarSlots {
  const rows = Math.max(0, Math.floor(height));
  const footer = rows >= 12 ? 1 : 0;
  const header = Math.min(rows >= 30 ? 15 : 6, rows - footer);
  let remaining = rows - header - footer;
  const middleMin = Math.min(6, remaining);
  const taskWant = taskCount ? (rows < 30 ? 1 : 2) + Math.min(rows < 30 ? 2 : 3, taskCount) * 2 : 0;
  const tasks = Math.min(taskWant, Math.max(0, remaining - middleMin));
  remaining -= tasks;
  const imageWant = hasImage ? rows < 20 ? 2 : Math.min(10, Math.max(4, Math.floor(rows / 5))) : 0;
  const image = Math.min(imageWant, Math.max(0, remaining - middleMin));
  return { header, middle: remaining - image, tasks, image, footer };
}

export function sidebarListOffset(offset: number, count: number, visible: number): number {
  return Math.max(0, Math.min(Math.floor(offset), Math.max(0, count - Math.max(1, visible))));
}

/** Bound money labels so growing totals cannot steal the label lane. */
export function sidebarCost(cost: number | null): string {
  if (cost === null || !Number.isFinite(cost) || cost < 0) return "—";
  if (cost < 1_000_000) return `$${cost.toFixed(2)}`;
  if (cost >= 1e15) return `$${cost.toExponential(1)}`;
  const unit = cost >= 1e12 ? 1e12 : cost >= 1e9 ? 1e9 : 1e6;
  const suffix = unit === 1e12 ? "T" : unit === 1e9 ? "B" : "M";
  return `$${(cost / unit).toFixed(1)}${suffix}`;
}

export function sidebarDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}
