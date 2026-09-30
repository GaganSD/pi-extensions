import { stripVTControlCharacters } from "node:util";
import type { Component } from "@earendil-works/pi-tui";

const SAMPLE_WIDTH = 80;

export type NoticeContainer = {
  children: Component[];
  removeChild(component: Component): void;
};

export function renderedPlain(component: Component, width = SAMPLE_WIDTH): string {
  try {
    return component.render(width).map((line) => stripVTControlCharacters(line)).join("\n");
  } catch {
    return "";
  }
}

export function isStockUpdateNotice(component: Component): boolean {
  const text = renderedPlain(component);
  if (text.includes("Package Updates Available")) return true;
  return text.includes("Update Available") && /New version |Changelog:|\bpi update\b/.test(text);
}

export function isHairlineBorder(component: Component): boolean {
  const lines = renderedPlain(component, 40).split("\n");
  if (lines.length !== 1) return false;
  const plain = lines[0]?.trim() ?? "";
  return plain.length > 0 && /^─+$/.test(plain);
}

export function isBlankSpacer(component: Component): boolean {
  const plain = renderedPlain(component, 10);
  return plain.trim() === "";
}

function removeOneStockNotice(container: NoticeContainer): boolean {
  const { children } = container;
  for (let i = 0; i < children.length; i++) {
    const title = children[i];
    if (!title || !isStockUpdateNotice(title)) continue;
    let close = -1;
    for (let j = i + 1; j < children.length; j++) {
      const next = children[j];
      if (next && isHairlineBorder(next)) {
        close = j;
        break;
      }
    }
    if (close < 0) return false;
    let start = i;
    while (start > 0) {
      const prev = children[start - 1];
      if (!prev || !(isHairlineBorder(prev) || isBlankSpacer(prev))) break;
      start -= 1;
    }
    for (const node of children.slice(start, close + 1)) {
      container.removeChild(node);
    }
    return true;
  }
  return false;
}

export function sweepStockUpdateNotices(container: NoticeContainer): boolean {
  let removed = false;
  while (removeOneStockNotice(container)) removed = true;
  return removed;
}
