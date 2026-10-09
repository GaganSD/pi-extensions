import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { sidebarText } from "./sidebar-data.ts";

export const SIDEBAR_DIALOG_OPTIONS = { overlay: true, overlayOptions: {
  width: "80%", minWidth: 28, maxHeight: "85%", anchor: "center",
} } as const;

/** Use precisely the compositor's floor(85%) budget, including all chrome. */
export function sidebarDialogBudget(rows: number) {
  const total = Math.max(1, Math.min(27, Math.floor(rows * .85)));
  const heading = total >= 2, footer = total >= 3, rule = total >= 4;
  return { heading, footer, rule, body: total - Number(heading) - Number(footer) - Number(rule) };
}

export function sidebarDialogRows(title: string, body: string[], hint: string, width: number, theme: Theme, budget: ReturnType<typeof sidebarDialogBudget>): string[] {
  return [
    ...(budget.heading ? [theme.fg("mdHeading", truncateToWidth(` ${sidebarText(title)}`, width))] : []),
    ...(budget.rule ? [theme.fg("dim", "─".repeat(Math.max(0, width)))] : []),
    ...body.map(line => truncateToWidth(line, width)),
    ...(budget.footer ? [theme.fg("dim", truncateToWidth(` ${hint}`, width))] : []),
  ];
}
