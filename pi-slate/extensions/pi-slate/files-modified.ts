export type FileChange = {
  index: string;
  worktree: string;
  path: string;
  origPath?: string;
};

export type FilesPanelLine =
  | { type: "heading"; count: number }
  | { type: "empty" }
  | { type: "file"; item: FileChange };

export function parsePorcelain(output: string): FileChange[] {
  if (!output) return [];
  const parts = output.split("\0");
  const files: FileChange[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part || part.length < 3) continue;
    const index = part[0] ?? "";
    const worktree = part[1] ?? "";
    if (!index || !worktree) continue;
    const path = part.slice(3);
    if (!path) continue;
    if (isRenameOrCopy(index, worktree)) {
      const original = parts[i + 1];
      if (original) {
        files.push({ index, worktree, path, origPath: original });
        i += 1;
        continue;
      }
    }
    files.push({ index, worktree, path });
  }
  return files;
}

export type FileTone = "success" | "warning" | "error" | "accent" | "muted";

export type FileMark = {
  mark: string;
  tone: FileTone;
};

export function fileMark(change: FileChange): FileMark {
  const index = change.index;
  const worktree = change.worktree;
  if (index === "?" || worktree === "?") return { mark: "N", tone: "success" };
  if (index === "U" || worktree === "U" || index === "A" && worktree === "A") {
    return { mark: "U", tone: "error" };
  }
  if (index === "R" || worktree === "R") return { mark: "R", tone: "accent" };
  if (index === "C" || worktree === "C") return { mark: "C", tone: "accent" };
  if (index === "D" || worktree === "D") return { mark: "D", tone: "error" };
  if (index === "A" || worktree === "A") return { mark: "N", tone: "success" };
  return { mark: "M", tone: "warning" };
}

export function formatFileLabel(change: FileChange): string {
  return change.origPath ? `${change.origPath} \u2192 ${change.path}` : change.path;
}

export function fileKey(change: FileChange): string {
  return `${change.index}${change.worktree}:${change.path}:${change.origPath ?? ""}`;
}

export function clampFilesOffset(offset: number, fileCount: number, bodyHeight: number): number {
  const maxOffset = Math.max(0, fileCount - Math.max(0, bodyHeight));
  if (!Number.isFinite(offset)) return 0;
  return Math.max(0, Math.min(maxOffset, Math.floor(offset)));
}

export function filesPanel(
  files: FileChange[],
  height: number,
  offset = 0,
): { lines: FilesPanelLine[]; offset: number } {
  const maxHeight = Math.max(0, Math.floor(height));
  if (maxHeight < 1) return { lines: [], offset: 0 };
  if (files.length === 0) {
    if (maxHeight === 1) return { lines: [{ type: "empty" }], offset: 0 };
    return { lines: [{ type: "heading", count: 0 }, { type: "empty" }], offset: 0 };
  }

  const showHeading = maxHeight > 1;
  const lines: FilesPanelLine[] = [];
  if (showHeading) lines.push({ type: "heading", count: files.length });
  const bodyHeight = maxHeight - lines.length;
  const nextOffset = clampFilesOffset(offset, files.length, bodyHeight);
  for (const item of files.slice(nextOffset, nextOffset + bodyHeight)) {
    lines.push({ type: "file", item });
  }
  return { lines, offset: nextOffset };
}

export function fileAtPanelRow(
  files: FileChange[],
  height: number,
  offset: number,
  row: number,
): FileChange | undefined {
  const line = filesPanel(files, height, offset).lines[row];
  return line?.type === "file" ? line.item : undefined;
}

export function sameFiles(left: FileChange[], right: FileChange[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((file, index) => {
    const other = right[index];
    return other !== undefined
      && file.index === other.index
      && file.worktree === other.worktree
      && file.path === other.path
      && file.origPath === other.origPath;
  });
}

function isRenameOrCopy(index: string, worktree: string): boolean {
  return index === "R" || index === "C" || worktree === "R" || worktree === "C";
}
