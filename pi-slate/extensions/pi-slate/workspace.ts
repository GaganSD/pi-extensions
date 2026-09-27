import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  allocateImageId,
  getCapabilities,
  getCellDimensions,
  getImageDimensions,
  imageFallback,
  renderImage,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { classifyDiffLine } from "./git-diff.ts";
import { formatImageLocation, type ImageAttachment } from "./placeholders.ts";
import { fitImageCells, placeWorkspaceImage, workspacePaneSlots } from "./workspace-layout.ts";

export type WorkspaceView = {
  id: string;
  title?: string;
  filePath?: string;
  render(width: number, height: number): string[];
  invalidate(): void;
  handleClick?(x: number, y: number): boolean;
  copyTextAt?(x: number, y: number): string | undefined;
  handleWheel?(delta: number): boolean;
};

export class DiffWorkspaceView implements WorkspaceView {
  readonly id: string;
  readonly title: string;
  readonly filePath?: string;
  private readonly state: "loading" | "diff" | "empty" | "error";
  private readonly text: string;
  private readonly theme: Theme;
  private offset = 0;
  private lastHeight = 1;
  private cached?: { key: string; lines: string[] };

  constructor(
    id: string,
    state: "loading" | "diff" | "empty" | "error",
    text: string,
    theme: Theme,
    title = id,
    filePath?: string,
  ) {
    this.id = `diff:${id}:${state}`;
    this.title = title;
    this.filePath = filePath;
    this.state = state;
    this.text = text;
    this.theme = theme;
  }

  invalidate(): void { this.cached = undefined; }

  handleWheel(delta: number): boolean {
    if (delta === 0) return false;
    const maxOffset = Math.max(0, this.sourceLines().length - Math.max(1, this.lastHeight));
    const next = Math.max(0, Math.min(maxOffset, this.offset + delta));
    if (next === this.offset) return false;
    this.offset = next;
    this.cached = undefined;
    return true;
  }

  render(width: number, height: number): string[] {
    this.lastHeight = Math.max(0, height);
    const source = this.sourceLines();
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, source.length - Math.max(1, this.lastHeight))));
    const key = `${width}x${height}:${this.offset}`;
    if (this.cached?.key === key) return this.cached.lines;
    const lines = source.slice(this.offset, this.offset + this.lastHeight).map((line) => {
      const kind = classifyDiffLine(line);
      const tone = kind === "added" ? "toolDiffAdded"
        : kind === "removed" ? "toolDiffRemoved"
        : kind === "hunk" ? "accent"
        : kind === "header" ? "dim"
        : "toolDiffContext";
      return truncateToWidth(this.theme.fg(tone, line), width, "…");
    });
    while (lines.length < this.lastHeight) lines.push("");
    this.cached = { key, lines };
    return lines;
  }

  private sourceLines(): string[] {
    if (this.state === "loading") return ["Loading change…"];
    if (this.state === "diff") return this.text.split(/\r?\n/);
    return [this.text || (this.state === "empty" ? "No text diff is available." : "Preview unavailable.")];
  }
}

export class ImageWorkspaceView implements WorkspaceView {
  readonly id: string;
  readonly title: string;
  readonly filePath: string;
  private readonly attachment: ImageAttachment;
  private readonly theme: Theme;
  private imageId?: number;
  private cached?: { key: string; lines: string[] };
  private readonly location: ReturnType<typeof formatImageLocation>;

  constructor(
    number: string,
    filePath: string,
    attachment: ImageAttachment,
    theme: Theme,
    home?: string,
  ) {
    this.id = `image:${number}:${filePath}`;
    this.filePath = filePath;
    this.attachment = attachment;
    this.theme = theme;
    this.location = formatImageLocation(filePath, home, number);
    this.title = this.location.name;
  }

  invalidate(): void {
    this.cached = undefined;
  }

  render(width: number, height: number): string[] {
    const key = `${width}x${height}`;
    if (this.cached?.key === key) return this.cached.lines;
    const imageHeight = workspacePaneSlots(height);
    if (imageHeight < 1) {
      const placed = placeWorkspaceImage(height, 0, []);
      this.cached = { key, lines: placed.lines };
      return placed.lines;
    }

    const imageLines = this.renderImageLines(width, imageHeight);
    const placed = placeWorkspaceImage(height, imageLines.length, []);
    for (let i = 0; i < placed.imageRows; i++) {
      placed.lines[placed.imageStart + i] = imageLines[i] ?? "";
    }
    this.cached = { key, lines: placed.lines };
    return placed.lines;
  }

  private fallbackLines(
    width: number,
    dimensions: { widthPx: number; heightPx: number },
    pad = 0,
  ): string[] {
    const text = imageFallback(this.attachment.mimeType, dimensions, this.location.name);
    return [
      truncateToWidth(`${" ".repeat(Math.max(0, pad))}${this.theme.fg("muted", text)}`, width),
    ];
  }

  private renderImageLines(width: number, imageHeight: number): string[] {
    const dimensions = getImageDimensions(this.attachment.data, this.attachment.mimeType) ?? {
      widthPx: 800,
      heightPx: 600,
    };
    const cell = getCellDimensions();
    const fit = fitImageCells(
      dimensions.widthPx,
      dimensions.heightPx,
      width,
      imageHeight,
      cell.widthPx,
      cell.heightPx,
    );
    if (fit.columns < 1 || fit.rows < 1) return [];
    const pad = Math.max(0, Math.floor((width - fit.columns) / 2));
    const prefix = " ".repeat(pad);

    const caps = getCapabilities();
    if (!caps.images) {
      return this.fallbackLines(width, dimensions, pad);
    }

    this.imageId ??= allocateImageId();
    const result = renderImage(this.attachment.data, dimensions, {
      maxWidthCells: fit.columns,
      maxHeightCells: fit.rows,
      imageId: this.imageId,
      moveCursor: false,
    });
    if (!result) {
      return this.fallbackLines(width, dimensions, pad);
    }

    if (caps.images === "kitty") {
      const lines = [prefix + result.sequence];
      for (let i = 1; i < result.rows; i++) lines.push("");
      return lines;
    }

    const lines: string[] = [];
    for (let i = 0; i < result.rows - 1; i++) lines.push("");
    const moveUp = result.rows > 1 ? `\x1b[${result.rows - 1}A` : "";
    lines.push(prefix + moveUp + result.sequence);
    return lines;
  }
}
