import test from "node:test";
import assert from "node:assert/strict";
import {
  PI_LOGO,
  PI_LOGO_ASCII,
  paintLogo,
  centerOffset,
  compactDisplayText,
  compactPath,
  footerVisibility,
  countSkillCommands,
  formatContextResources,
  formatContextTokens,
  formatInteger,
  formatMcpEnabled,
  formatPercent,
  formatSkillsLoaded,
  formatSpend,
  formatTokenCount,
  formatTokenRate,
  parseMcpEnabledCount,
  mainColumnWidth,
  maxSidebarWidth,
  modelLabel,
  parseSidebarPercent,
  parseSidebarWidthArg,
  parseSlateArgs,
  parseMessageLength,
  parseMessageLengthArg,
  resolveMessageLength,
  messageLengthMessage,
  MESSAGE_LENGTH_DEFAULT,
  percentFromColumns,
  sidebarPercentFromColumns,
  slateArgumentCompletions,
  withCurrent,
  withoutCurrent,
  sidebarHandleColumn,
  sidebarWidthFromScreenX,
  SIDEBAR_PERCENT_MEDIUM,
  SIDEBAR_PERCENT_NARROW,
  SIDEBAR_PERCENT_WIDE,
  workspaceColumnWidth,
} from "../extensions/pi-slate/layout.ts";
import {
  FILES_WIDGET_MAX_LINES,
  filesWidgetDesiredHeight,
  fitImageCells,
  placeWorkspaceImage,
  SIDEBAR_DOCK_LINES,
  sidebarRowSlots,
  splitSidebarContent,
  workspacePaneSlots,
} from "../extensions/pi-slate/workspace-layout.ts";

test("logo preserves the official four-row geometry and terminal aspect ratio", () => {
  assert.deepEqual(PI_LOGO, ["██████  ", "██  ██  ", "████  ██", "██    ██"]);
  assert.deepEqual(PI_LOGO_ASCII, ["######  ", "##  ##  ", "####  ##", "##    ##"]);
  assert.ok(PI_LOGO.every((line) => line.length === 8));
  assert.ok(PI_LOGO_ASCII.every((line) => line.length === 8));
  assert.ok(PI_LOGO_ASCII.every((line) => /^[ #]+$/.test(line)));
  assert.equal(paintLogo("π"), "\x1b[38;2;255;255;255mπ\x1b[39m");
  assert.equal(paintLogo("π", false), "\x1b[97mπ\x1b[39m");
});

test("header content is centered without negative padding", () => {
  assert.equal(centerOffset(190, 78), 56);
  assert.equal(centerOffset(79, 78), 0);
  assert.equal(centerOffset(40, 78), 0);
});

test("footer progressively reveals optional metadata", () => {
  assert.deepEqual(footerVisibility(40), {
    showBranch: false,
    showModel: false,
    showThinking: false,
  });
  assert.deepEqual(footerVisibility(100), {
    showBranch: true,
    showModel: true,
    showThinking: true,
  });
});

test("sidebar context labels match the OpenCode-style facts", () => {
  assert.equal(formatInteger(18958), "18,958");
  assert.equal(formatTokenCount(18958), "18,958 tokens");
  assert.equal(formatTokenCount(null), "— tokens");
  assert.equal(formatTokenRate(42.4), "42 tokens/sec");
  assert.equal(formatTokenRate(null), "— tokens/sec");
  assert.equal(formatPercent(2.4), "2%");
  assert.equal(formatPercent(null), "—%");
  assert.equal(formatSpend(1.234), "$1.23");
  assert.equal(formatSpend(null), "$0.00");
  assert.equal(formatContextTokens(3485, 2.4, 42.4), "3,485 tokens · 2% used · 42 tokens/sec");
  assert.equal(formatContextTokens(null, null, null), "— tokens · —% used · — tokens/sec");
});

test("model label stays safe with missing data", () => {
  assert.equal(modelLabel(undefined), "no model");
});

test("workspace column is 20% once the terminal is wide enough", () => {
  assert.equal(workspaceColumnWidth(50), 0);
  assert.equal(workspaceColumnWidth(100), 28);
  assert.equal(workspaceColumnWidth(200), 40);
  assert.equal(workspaceColumnWidth(203), 40);
  assert.equal(mainColumnWidth(200), 160);
});

test("a preferred sidebar width is clamped and hidden on narrow terminals", () => {
  assert.equal(workspaceColumnWidth(59, 80), 0);
  assert.equal(workspaceColumnWidth(100, 10), 28);
  assert.equal(workspaceColumnWidth(100, 50), 50);
  assert.equal(workspaceColumnWidth(60, 80), 28);
  assert.equal(maxSidebarWidth(140), 108);
  assert.equal(workspaceColumnWidth(140, 200), 108);
  assert.equal(workspaceColumnWidth(200, SIDEBAR_PERCENT_NARROW), 28);
  assert.equal(workspaceColumnWidth(200, SIDEBAR_PERCENT_MEDIUM), 60);
  assert.equal(workspaceColumnWidth(200, SIDEBAR_PERCENT_WIDE), 80);
  assert.equal(mainColumnWidth(140, 40), 84);
  assert.equal(sidebarWidthFromScreenX(140, 100), 40);
  assert.equal(sidebarWidthFromScreenX(140, 0), 108);
  assert.equal(sidebarHandleColumn(140, 40), 100);
  assert.equal(percentFromColumns(140, 28), 20);
  assert.equal(sidebarPercentFromColumns(140, 28), undefined);
  assert.equal(sidebarPercentFromColumns(140, 42), 30);
  assert.equal(sidebarPercentFromColumns(200, 28), 0);
  assert.equal(sidebarPercentFromColumns(200, 60), 30);
  assert.equal(sidebarPercentFromColumns(200, 47), 24);
  assert.equal(parseSidebarPercent(36.4), 36);
  assert.equal(parseSidebarPercent(0), 0);
  assert.equal(parseSidebarPercent(81), undefined);
  assert.equal(parseSidebarPercent("40"), undefined);
  assert.deepEqual(parseSidebarWidthArg("default"), { ok: true });
  assert.deepEqual(parseSidebarWidthArg(" narrow "), { ok: true, percent: SIDEBAR_PERCENT_NARROW });
  assert.deepEqual(parseSidebarWidthArg("medium"), { ok: true, percent: SIDEBAR_PERCENT_MEDIUM });
  assert.deepEqual(parseSidebarWidthArg("wide"), { ok: true, percent: SIDEBAR_PERCENT_WIDE });
  assert.deepEqual(parseSidebarWidthArg("30%"), { ok: true, percent: 30 });
  assert.deepEqual(parseSidebarWidthArg("48"), { ok: true, percent: 48 });
  assert.deepEqual(parseSidebarWidthArg("81"), { ok: false });
  assert.deepEqual(parseSidebarWidthArg("1e3"), { ok: false });
  assert.deepEqual(parseSidebarWidthArg("0x20"), { ok: false });
  assert.deepEqual(parseSidebarWidthArg("nope"), { ok: false });
});

test("message-length parses counts and stays synced with the default", () => {
  assert.equal(MESSAGE_LENGTH_DEFAULT, 100);
  assert.equal(parseMessageLength(100), 100);
  assert.equal(parseMessageLength(50.4), 50);
  assert.equal(parseMessageLength(0), undefined);
  assert.equal(parseMessageLength(2001), undefined);
  assert.deepEqual(parseMessageLengthArg("default"), { ok: true });
  assert.deepEqual(parseMessageLengthArg("all"), { ok: true, value: "all" });
  assert.deepEqual(parseMessageLengthArg("unlimited"), { ok: true, value: "all" });
  assert.deepEqual(parseMessageLengthArg("50"), { ok: true, value: 50 });
  assert.deepEqual(parseMessageLengthArg("nope"), { ok: false });
  assert.equal(resolveMessageLength(undefined), MESSAGE_LENGTH_DEFAULT);
  assert.equal(resolveMessageLength("all"), Number.POSITIVE_INFINITY);
  assert.equal(messageLengthMessage(undefined), "Message length reset to default");
  assert.equal(messageLengthMessage("all"), "Message length set to all");
  assert.equal(messageLengthMessage(50), "Message length set to 50");
});

test("/slate args route density, footer, and width", () => {
  assert.deepEqual(parseSlateArgs(""), { ok: true, kind: "menu" });
  assert.deepEqual(parseSlateArgs("density"), { ok: true, kind: "density" });
  assert.deepEqual(parseSlateArgs("density compact"), { ok: true, kind: "density", value: "compact" });
  assert.deepEqual(parseSlateArgs("footer minimal"), { ok: true, kind: "footer", value: "minimal" });
  assert.deepEqual(parseSlateArgs("width"), { ok: true, kind: "width-menu" });
  assert.deepEqual(parseSlateArgs("width default"), { ok: true, kind: "width" });
  assert.deepEqual(parseSlateArgs("width 40"), { ok: true, kind: "width", width: 40 });
  assert.deepEqual(parseSlateArgs("width 30%"), { ok: true, kind: "width", width: 30 });
  assert.deepEqual(parseSlateArgs("width narrow"), { ok: true, kind: "width", width: 0 });
  assert.deepEqual(parseSlateArgs("message-length"), { ok: true, kind: "message-length-menu" });
  assert.deepEqual(parseSlateArgs("message-length default"), { ok: true, kind: "message-length" });
  assert.deepEqual(parseSlateArgs("message-length 50"), { ok: true, kind: "message-length", value: 50 });
  assert.deepEqual(parseSlateArgs("message-length all"), { ok: true, kind: "message-length", value: "all" });
  assert.deepEqual(parseSlateArgs("bug"), { ok: true, kind: "bug-menu" });
  assert.deepEqual(parseSlateArgs("bug file"), { ok: true, kind: "bug", action: "file" });
  assert.deepEqual(parseSlateArgs("bug open"), { ok: true, kind: "bug", action: "open" });
  assert.deepEqual(parseSlateArgs("theme"), { ok: true, kind: "theme-menu" });
  assert.deepEqual(parseSlateArgs("theme mocha"), { ok: true, kind: "theme", flavor: "mocha" });
  assert.deepEqual(parseSlateArgs("theme mauve"), { ok: true, kind: "theme", style: "mauve" });
  assert.deepEqual(parseSlateArgs("theme mocha mauve"), {
    ok: true,
    kind: "theme",
    flavor: "mocha",
    style: "mauve",
  });
  assert.deepEqual(parseSlateArgs("theme latte quiet"), { ok: false });
  assert.deepEqual(parseSlateArgs("flavor mocha"), { ok: false });
  assert.deepEqual(parseSlateArgs("style sapphire"), { ok: true, kind: "style", value: "sapphire" });
  assert.deepEqual(parseSlateArgs("theme nope"), { ok: false });
  assert.deepEqual(parseSlateArgs("theme mocha mauve extra"), { ok: false });
  assert.deepEqual(parseSlateArgs("bug nope"), { ok: false });
  assert.deepEqual(parseSlateArgs("width nope"), { ok: false });
  assert.deepEqual(parseSlateArgs("nope"), { ok: false });
  assert.deepEqual(parseSlateArgs("density compact extra"), { ok: false });
  assert.deepEqual(
    slateArgumentCompletions("den"),
    [{ value: "density", label: "density" }, { value: "density comfortable", label: "density comfortable" }, { value: "density compact", label: "density compact" }],
  );
  assert.equal(slateArgumentCompletions("nope"), null);
  assert.equal(withCurrent("Compact", true), "Compact (current)");
  assert.equal(withoutCurrent("Compact (current)"), "Compact");
  assert.equal(withoutCurrent("Sidebar width"), "Sidebar width");
});

test("sidebar rows pin the footer dock and give the rest to content", () => {
  assert.deepEqual(sidebarRowSlots(0), { contentHeight: 0, dockHeight: 0 });
  assert.deepEqual(sidebarRowSlots(4), { contentHeight: 0, dockHeight: 4 });
  assert.deepEqual(sidebarRowSlots(5), { contentHeight: 1, dockHeight: 4 });
  assert.deepEqual(sidebarRowSlots(20), { contentHeight: 16, dockHeight: 4 });
  assert.equal(SIDEBAR_DOCK_LINES, 4);
  assert.deepEqual(sidebarRowSlots(20, SIDEBAR_DOCK_LINES), { contentHeight: 16, dockHeight: 4 });
});

test("MCP and skill counts share the Context resource line", () => {
  assert.equal(formatMcpEnabled(0), "0 MCPs enabled");
  assert.equal(formatMcpEnabled(1), "1 MCPs enabled");
  assert.equal(formatMcpEnabled(2), "2 MCPs enabled");
  assert.equal(formatSkillsLoaded(0), "0 skills loaded");
  assert.equal(formatSkillsLoaded(3), "3 skills loaded");
  assert.equal(formatContextResources(1.234, 3, 2), "$1.23 · 3 skills loaded · 2 MCPs enabled");
  assert.equal(formatContextResources(null, 0, null), "$0.00 · 0 skills loaded · 0 MCPs enabled");
  assert.equal(countSkillCommands([
    { source: "skill", sourceInfo: { path: "/skills/a/SKILL.md" }, name: "a" },
    { source: "skill", sourceInfo: { path: "/skills/a/SKILL.md" }, name: "a:1" },
    { source: "extension", sourceInfo: { path: "/ext.ts" }, name: "slate" },
  ]), 1);
  assert.equal(parseMcpEnabledCount({
    connectedCount: 2,
    servers: [{ name: "a" }, { name: "b" }],
  }), 2);
  assert.equal(parseMcpEnabledCount({}), null);
  assert.equal(parseMcpEnabledCount(null), null);
});

test("MCP enabled count includes cached servers and ignores live connection count", () => {
  assert.equal(parseMcpEnabledCount({
    connectedCount: 0,
    disabledCount: 1,
    servers: [
      { name: "linear", status: "cached", disabled: false },
      { name: "github", status: "disabled", disabled: true },
    ],
  }), 1);
  assert.equal(parseMcpEnabledCount({
    connectedCount: 0,
    servers: [{ name: "linear", status: "cached" }],
  }), 1);
  assert.equal(parseMcpEnabledCount({ connectedCount: 2 }), null);
});

test("files widget stays compact and never exceeds five lines", () => {
  assert.equal(FILES_WIDGET_MAX_LINES, 5);
  assert.equal(filesWidgetDesiredHeight(0), 2);
  assert.equal(filesWidgetDesiredHeight(1), 2);
  assert.equal(filesWidgetDesiredHeight(4), 5);
  assert.equal(filesWidgetDesiredHeight(12), 5);
});

test("sidebar content uses a compact summary and retains Preview", () => {
  for (const height of [1, 2, 6, 20]) {
    const slots = splitSidebarContent(height, 5);
    assert.equal("reservedHeight" in slots, false);
    assert.ok(slots.filesHeight <= FILES_WIDGET_MAX_LINES);
    assert.ok(slots.summaryHeight >= 0 && slots.dividerHeight >= 0 && slots.peekHeight >= 0);
    assert.equal(slots.summaryHeight + slots.dividerHeight + slots.peekHeight, height);
    assert.ok(slots.peekHeight >= 1);
  }
  assert.deepEqual(splitSidebarContent(20, 5), {
    summaryHeight: 11, filesHeight: 5, dividerHeight: 1, peekHeight: 8,
  });
  assert.deepEqual(splitSidebarContent(6, 5), {
    summaryHeight: 4, filesHeight: 1, dividerHeight: 1, peekHeight: 1,
  });
  assert.deepEqual(splitSidebarContent(3, 5), {
    summaryHeight: 1, filesHeight: 0, dividerHeight: 1, peekHeight: 1,
  });
});

test("workspace pane leaves one row of padding above the image", () => {
  assert.equal(workspacePaneSlots(0), 0);
  assert.equal(workspacePaneSlots(1), 1);
  assert.equal(workspacePaneSlots(3), 2);
  assert.equal(workspacePaneSlots(20), 19);
});

test("images contain-fit and never upscale", () => {
  assert.deepEqual(fitImageCells(10, 10, 40, 20, 9, 18), { columns: 2, rows: 1 });
  assert.deepEqual(fitImageCells(4000, 3000, 36, 20, 9, 18), { columns: 36, rows: 14 });
  assert.deepEqual(fitImageCells(4000, 1000, 36, 20, 9, 18), { columns: 36, rows: 5 });
  assert.deepEqual(fitImageCells(800, 600, 0, 20), { columns: 0, rows: 0 });
});

test("images sit one row below the preview heading", () => {
  const placed = placeWorkspaceImage(8, 2, []);
  assert.equal(placed.lines.length, 8);
  assert.equal(placed.imageStart, 1);
  assert.equal(placed.imageRows, 2);
  assert.equal(placed.captionStart, 3);
  assert.equal(placed.lines[0], "");
});

test("home paths use a tilde without rewriting lookalikes", () => {
  assert.equal(compactPath("/Users/gagan/GitHub/pi", "/Users/gagan"), "~/GitHub/pi");
  assert.equal(compactPath("/Users/gagandev/pi", "/Users/gagan"), "/Users/gagandev/pi");
  assert.equal(
    compactDisplayText("read /Users/gagan/GitHub/pi/src/a.ts", "/Users/gagan/GitHub/pi", "/Users/gagan"),
    "read src/a.ts",
  );
  assert.equal(
    compactDisplayText("read /Users/gagan/.pi/agent/foo.ts", "/tmp/proj", "/Users/gagan"),
    "read ~/.pi/agent/foo.ts",
  );
});
