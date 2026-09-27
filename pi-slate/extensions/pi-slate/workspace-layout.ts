export const SIDEBAR_DOCK_LINES = 4;
export const FILES_WIDGET_MAX_LINES = 5;

export function sidebarRowSlots(
  height: number,
  dockLines = SIDEBAR_DOCK_LINES,
): {
  contentHeight: number;
  dockHeight: number;
} {
  const paneHeight = Math.max(0, Math.floor(height));
  const dockHeight = Math.min(Math.max(0, dockLines), paneHeight);
  return {
    contentHeight: paneHeight - dockHeight,
    dockHeight,
  };
}

export function filesWidgetDesiredHeight(fileCount: number): number {
  if (fileCount <= 0) return 2;
  return Math.min(FILES_WIDGET_MAX_LINES, 1 + fileCount);
}

export function splitSidebarContent(
  height: number,
  filesDesired: number,
): {
  summaryHeight: number;
  filesHeight: number;
  dividerHeight: number;
  peekHeight: number;
} {
  const slotHeight = Math.max(0, Math.floor(height));
  const filesWant = Math.max(0, Math.min(FILES_WIDGET_MAX_LINES, Math.floor(filesDesired)));
  // Keep Preview usable first; Summary expands only into the space it needs.
  if (slotHeight <= 2) return { summaryHeight: 0, filesHeight: 0, dividerHeight: 0, peekHeight: slotHeight };
  const summaryWant = Math.min(12, 2 + filesWant + 2 + 2); // headings, files, two facts, two section gaps.
  const summaryHeight = Math.min(summaryWant, slotHeight - 2);
  const dividerHeight = summaryHeight > 0 ? 1 : 0;
  const peekHeight = slotHeight - summaryHeight - dividerHeight;
  const filesHeight = Math.min(filesWant, Math.max(0, summaryHeight - 3));
  return { summaryHeight, filesHeight, dividerHeight, peekHeight };
}

export function workspacePaneSlots(height: number): number {
  const paneHeight = Math.max(0, Math.floor(height));
  return paneHeight <= 1 ? paneHeight : paneHeight - 1;
}

export function fitImageCells(
  imageWidthPx: number,
  imageHeightPx: number,
  maxCols: number,
  maxRows: number,
  cellWidthPx = 9,
  cellHeightPx = 18,
): { columns: number; rows: number } {
  const maxWidth = Math.max(0, Math.floor(maxCols));
  const maxHeight = Math.max(0, Math.floor(maxRows));
  if (maxWidth < 1 || maxHeight < 1) return { columns: 0, rows: 0 };
  const widthPx = Math.max(1, imageWidthPx);
  const heightPx = Math.max(1, imageHeightPx);
  const cellW = Math.max(1, cellWidthPx);
  const cellH = Math.max(1, cellHeightPx);
  const scale = Math.min(1, (maxWidth * cellW) / widthPx, (maxHeight * cellH) / heightPx);
  return {
    columns: Math.max(1, Math.min(maxWidth, Math.ceil((widthPx * scale) / cellW))),
    rows: Math.max(1, Math.min(maxHeight, Math.ceil((heightPx * scale) / cellH))),
  };
}

export function placeWorkspaceImage(
  paneHeight: number,
  imageRows: number,
  captionLines: string[],
): { lines: string[]; imageStart: number; imageRows: number; captionStart: number } {
  const pane = Math.max(0, Math.floor(paneHeight));
  const captions = captionLines.slice(0, pane);
  const topPad = pane > 1 ? 1 : 0;
  const usedImageRows = Math.min(Math.max(0, imageRows), Math.max(0, pane - topPad - captions.length));
  const imageStart = topPad;
  const captionStart = imageStart + usedImageRows;
  const lines = Array.from({ length: pane }, () => "");
  for (let i = 0; i < captions.length; i++) {
    lines[captionStart + i] = captions[i] ?? "";
  }
  return { lines, imageStart, imageRows: usedImageRows, captionStart };
}
