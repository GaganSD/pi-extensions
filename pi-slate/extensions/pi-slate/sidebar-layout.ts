export type SidebarSlots = { header: number; middle: number; tasks: number; image: number; footer: number };

/** Allocate once for both painting and hit testing. Never depend on composer height. */
export function sessionSidebarSlots(height: number, taskCount: number, hasImage: boolean): SidebarSlots {
  const rows = Math.max(0, Math.floor(height));
  const footer = rows >= 12 ? 1 : 0;
  const header = Math.min(6, rows - footer);
  let remaining = rows - header - footer;
  const middleMin = Math.min(6, remaining);
  const taskWant = taskCount ? 1 + Math.min(rows < 30 ? 2 : 3, taskCount) : 1;
  const tasks = Math.min(taskWant, Math.max(0, remaining - middleMin));
  remaining -= tasks;
  const imageWant = hasImage ? rows < 20 ? 2 : Math.min(10, Math.max(4, Math.floor(rows / 5))) : 1;
  const image = Math.min(imageWant, Math.max(0, remaining - middleMin));
  return { header, middle: remaining - image, tasks, image, footer };
}

export function sidebarListOffset(offset: number, count: number, visible: number): number {
  return Math.max(0, Math.min(Math.floor(offset), Math.max(0, count - Math.max(1, visible))));
}

export function sidebarDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}
