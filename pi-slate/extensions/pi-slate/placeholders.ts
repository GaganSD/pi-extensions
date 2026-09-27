import { accessSync, constants, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compactPath } from "./layout.ts";

const IMAGE_EXT_RE = /\.(?:png|jpe?g|webp|gif)$/i;
// Match whole path tokens, not suffixes of URLs or prefixes of longer filenames.
const EMBEDDED_IMAGE_PATH_RE =
  /(?<![^\s([{"'`])(?:"((?:file:\/\/|\/|[A-Za-z]:\\)[^"]+\.(?:png|jpe?g|webp|gif))"|'((?:file:\/\/|\/|[A-Za-z]:\\)[^']+\.(?:png|jpe?g|webp|gif))'|`((?:file:\/\/|\/|[A-Za-z]:\\)[^`]+\.(?:png|jpe?g|webp|gif))`|((?:file:\/\/)?(?:\/|[A-Za-z]:\\)(?:\\ |[^\s"'`])+\.(?:png|jpe?g|webp|gif))(?=$|[\s"'`)\]},;]|\.(?=\s|$)))/gi;

export type ImageAttachment = {
  type: "image";
  data: string;
  mimeType: string;
};

export type ImagePathStore = Map<string, string>;

function imageToken(number: number | string): string {
  return `[image-${number}]`;
}

export function nextImageNumber(text: string): number {
  let max = 0;
  for (const match of text.matchAll(/\[image[ -](\d+)\]/g)) {
    max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

export function imageTokenAtCursor(
  text: string,
  cursor: { line: number; col: number },
): string | undefined {
  const line = text.split("\n")[cursor.line];
  if (line === undefined) return undefined;
  for (const match of line.matchAll(/\[image[ -](\d+)\]/g)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (cursor.col >= start && cursor.col <= end) return match[1];
  }
  return undefined;
}

function storedNumberForPath(store: ImagePathStore, filePath: string): string | undefined {
  for (const [number, storedPath] of store) {
    if (storedPath === filePath) return number;
  }
  return undefined;
}

export function formatImageLocation(
  filePath: string,
  home?: string,
  number?: string,
): { name: string; directory: string; kind: string; source: string } {
  const rawName = filePath.replace(/^.*[/\\]/, "");
  const directory = filePath.slice(0, Math.max(0, filePath.length - rawName.length - 1));
  const kind = mimeTypeForImagePath(filePath).replace("image/", "").toUpperCase();
  const clipboard = rawName.startsWith("pi-clipboard-");
  const ext = rawName.includes(".") ? rawName.slice(rawName.lastIndexOf(".")) : "";
  return {
    name: clipboard ? `image-${number ?? "1"}${ext}` : rawName,
    directory: compactPath(directory, home),
    kind,
    source: clipboard ? "Clipboard" : "File",
  };
}

export function mimeTypeForImagePath(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

function isImagePath(value: string): boolean {
  return IMAGE_EXT_RE.test(value) && (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value));
}

function imagePathCandidates(raw: string): string[] | undefined {
  let value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2) ||
    (value.startsWith("`") && value.endsWith("`") && value.length >= 2)
  ) {
    value = value.slice(1, -1);
  }
  if (/^file:\/\//i.test(value)) {
    try {
      const filePath = fileURLToPath(value);
      return isImagePath(filePath) ? [filePath] : undefined;
    } catch {
      return undefined;
    }
  }

  // A literal filename wins even if it cannot be read. Never substitute a
  // different image merely because the intended file is inaccessible.
  if (isImagePath(value) && existsSync(value)) return [value];
  value = value.replace(/\\ /g, " ");
  const candidates = [value];
  if (/%[0-9A-Fa-f]{2}/.test(value) && !existsSync(value)) {
    try {
      const decoded = decodeURIComponent(value);
      if (decoded !== value) candidates.push(decoded);
    } catch {
      // Keep the literal path when its percent encoding is malformed.
    }
  }
  const imagePaths = candidates.filter(isImagePath);
  return imagePaths.length > 0 ? imagePaths : undefined;
}

function isReadableImageFile(filePath: string): boolean {
  try {
    if (!statSync(filePath).isFile()) return false;
    accessSync(filePath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveImagePath(
  raw: string,
  isUsable: (filePath: string) => boolean,
): string | undefined {
  return imagePathCandidates(raw)?.find(isUsable);
}

function assignImageToken(store: ImagePathStore, filePath: string, number: { value: number }): string {
  const label = imageToken(number.value);
  store.set(String(number.value), filePath);
  number.value += 1;
  return label;
}

function replaceEmbeddedImagePaths(
  text: string,
  replace: (full: string, rawPath: string) => string,
): string {
  EMBEDDED_IMAGE_PATH_RE.lastIndex = 0;
  return text.replace(EMBEDDED_IMAGE_PATH_RE, (full, doubleQuoted?: string, singleQuoted?: string, backtickQuoted?: string, bare?: string) => {
    const rawPath = doubleQuoted ?? singleQuoted ?? backtickQuoted ?? bare ?? full;
    return replace(full, rawPath);
  });
}

export function rewriteClipboardPaths(
  text: string,
  startAt: number,
  store: ImagePathStore,
): string {
  const number = { value: startAt };
  const dropped = resolveImagePath(text, isReadableImageFile);
  if (dropped) return assignImageToken(store, dropped, number);
  return replaceEmbeddedImagePaths(text, (full, rawPath) => {
    const filePath = resolveImagePath(rawPath, isReadableImageFile);
    return filePath ? assignImageToken(store, filePath, number) : full;
  });
}

export function transformSubmittedText(
  text: string,
  store: ImagePathStore,
  load: (filePath: string) => ImageAttachment | undefined,
  existingImages: ImageAttachment[] = [],
): { text: string; images: ImageAttachment[] } {
  const images = [...existingImages];
  const seen = new Set<string>();

  for (const match of text.matchAll(/\[image[ -](\d+)\]/g)) {
    const filePath = store.get(match[1]);
    if (!filePath || seen.has(filePath)) continue;
    const image = load(filePath);
    if (!image) continue;
    images.push(image);
    seen.add(filePath);
  }

  const number = { value: nextImageNumber(text) };
  const attach = (full: string, rawPath: string): string => {
    let image: ImageAttachment | undefined;
    const filePath = resolveImagePath(rawPath, (candidate) => {
      image = load(candidate);
      return image !== undefined;
    });
    if (!filePath || !image) return full;
    const existing = storedNumberForPath(store, filePath);
    if (existing && seen.has(filePath)) return imageToken(existing);
    const label = assignImageToken(store, filePath, number);
    images.push(image);
    seen.add(filePath);
    return label;
  };

  const dropped = attach(text, text);
  const nextText = dropped !== text ? dropped : replaceEmbeddedImagePaths(text, attach);
  return { text: nextText, images };
}
