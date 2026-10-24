import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  copyToClipboard,
  getAgentDir,
  getPackageDir,
  VERSION,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import { chromePaint, ComposerEditor, composerPaddingX } from "./composer.ts";
import { copyWithFeedback } from "./copy-feedback.ts";
import { ComposerSelectionController } from "./composer-selection.ts";
import { installConversationBridge } from "./conversation-bridge.ts";
import { installImagePlaceholders } from "./image-placeholders.ts";
import { installExitCommand } from "./exit.ts";
import { installPromptPicker } from "./prompts.ts";
import { installDiff } from "./diff.ts";
import { installRead } from "./read.ts";
import { installToolStyle } from "./tool-style.ts";
import { ToolGroups } from "./tool-groups.ts";
import { GitBranchPoller } from "./git-branch.ts";
import { formatSurfaces, has, parseSurfaceConfig, type SurfaceConfig } from "./surfaces.ts";
import { Sidebar } from "./sidebar.ts";
import { BackgroundTasks, BACKGROUND_TASKS_EVENT, BACKGROUND_TASKS_REQUEST } from "./background-tasks.ts";
import { commandResources, parseSidebarFolds, sidebarMessageCounts, sidebarText, sidebarUsage, SidebarMcpFiles, SidebarSkills, type SidebarFolds, type SidebarResources } from "./sidebar-data.ts";
import { inspectSidebarText } from "./sidebar-inspector.ts";
import { pickSidebarItem } from "./sidebar-picker.ts";
import { loadSidebarMcpHost } from "./sidebar-mcp.ts";
import { TurnCompletion } from "./turn-completion.ts";
import { resolveContextTokens } from "./context-usage.ts";
import { estimateAssistantTokens, TokenRateTracker } from "./token-rate.ts";
import { createWordPicker } from "./working-words.ts";
import { advanceWave, isProgressStyle, isWaveActive, PROGRESS_STYLES, setProgressStyle, setWaveActive, type ProgressStyle } from "./working-wave.ts";
import { formatLiveThinking, ThinkingFoldTracker } from "./thinking-fold.ts";
import {
  countSkillCommands,
  LOGO_STYLES,
  type LogoStyle,
  formatFocusedContextResources,
  formatFocusedContextTokens,
  formatPercent,
  modelStatusLabel,
  parseMessageLength,
  parseMessageLengthArg,
  parseSidebarPercent,
  parseSidebarWidthArg,
  parseSlateArgs,
  resolveMessageLength,
  messageLengthMessage,
  slateArgumentCompletions,
  SLATE_USAGE,
  SLATE_VERSION,
  SIDEBAR_PERCENT_DEFAULT,
  SIDEBAR_PERCENT_MEDIUM,
  SIDEBAR_PERCENT_NARROW,
  SIDEBAR_PERCENT_WIDE,
  MESSAGE_LENGTH_DEFAULT,
  MESSAGE_LENGTH_LONG,
  MESSAGE_LENGTH_SHORT,
  withCurrent,
  withoutCurrent,
  type ModelDisplay,
} from "./layout.ts";
import { SlateHeader } from "./header.ts";
import { UpdateWatcher } from "./updates.ts";
import {
  formatBugReport,
  issueTemplate,
  openExternalArgs,
  SLATE_ISSUES_URL,
} from "./bug.ts";
import { findChatContainer, layoutRootOf, syncMessageWindow, type MessageWindow } from "./message-window.ts";
import { installNewSessionNoticeFilter } from "./stock-notices.ts";
import {
  STYLE_LABELS,
  STYLES,
  resolveCatppuccinTheme,
  themeMessage,
  type Flavor,
  type Style,
} from "./catppuccin.ts";
import { persistTheme, SLATE_NATIVE_THEME, SLATE_THEME } from "./install-defaults.ts";

const PROGRESS_LABELS: Record<ProgressStyle, string> = {
  waves: "Waves",
  "dna-helix": "DNA helix",
  snake: "Snake",
  "cylon-scanner": "Cylon scanner",
};

type SlateConfig = SurfaceConfig & {
  density: "comfortable" | "compact";
  sidebarPercent?: number;
  focused?: boolean;
  messageLength?: number | "all";
  modelDisplay?: ModelDisplay;
  showPid?: boolean;
  logo?: LogoStyle;
  progress?: ProgressStyle;
  toolStyle?: "default" | "claudecode";
  sidebarSections: SidebarFolds;
};

function loadMessageLength(value: unknown): number | "all" | undefined {
  if (value === "all") return "all";
  return parseMessageLength(value);
}

function loadModelDisplay(value: unknown): ModelDisplay | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Partial<ModelDisplay>;
  const display: ModelDisplay = {};
  if (Array.isArray(raw.stripPrefixes)) {
    const prefixes = raw.stripPrefixes.filter((p): p is string => typeof p === "string" && p.length > 0);
    if (prefixes.length > 0) display.stripPrefixes = prefixes;
  }
  if (typeof raw.providerAliases === "object" && raw.providerAliases !== null) {
    const aliases: Record<string, string> = {};
    for (const [key, alias] of Object.entries(raw.providerAliases)) {
      if (typeof alias === "string" && alias.length > 0) aliases[key] = alias;
    }
    if (Object.keys(aliases).length > 0) display.providerAliases = aliases;
  }
  if (raw.providerSuffix === true) display.providerSuffix = true;
  return Object.keys(display).length > 0 ? display : undefined;
}

function loadConfig(configPath: string): { config: SlateConfig; raw: Record<string, unknown>; error?: string } {
  let text: string | undefined;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") text = "";
  }
  const parsed = parseSurfaceConfig(text);
  const value = parsed.value as Record<string, unknown> & SurfaceConfig;
  const sidebarPercent = parseSidebarPercent(value.sidebarPercent);
  const messageLength = loadMessageLength(value.messageLength);
  const modelDisplay = loadModelDisplay(value.modelDisplay);
  return {
    raw: parsed.ok && text !== undefined ? JSON.parse(text) as Record<string, unknown> : value,
    config: {
      version: value.version,
      surfaces: value.surfaces,
      composerMetadata: value.composerMetadata,
      density: value.density === "compact" ? "compact" : "comfortable",
      ...(sidebarPercent === undefined ? {} : { sidebarPercent }),
      focused: value.focused !== false,
      ...(messageLength === undefined ? {} : { messageLength }),
      ...(modelDisplay === undefined ? {} : { modelDisplay }),
      showPid: value.showPid === true,
      ...(value.logo === "minimal" || value.logo === "original" ? { logo: value.logo } : {}),
      ...(value.toolStyle === "default" ? { toolStyle: "default" as const } : {}),
      ...(isProgressStyle(value.progress) ? { progress: value.progress } : {}),
      sidebarSections: parseSidebarFolds(value.sidebarSections),
    },
    ...(!parsed.ok ? { error: parsed.error } : {}),
  };
}

function withMessageLength(current: SlateConfig, messageLength: number | "all" | undefined): SlateConfig {
  const next = { ...current };
  if (messageLength === undefined) delete next.messageLength;
  else next.messageLength = messageLength;
  return next;
}


function writeConfig(configPath: string, config: Record<string, unknown>): void {
  const temporaryPath = `${configPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, configPath);
}

function withSidebarPercent(current: SlateConfig, percent: number | undefined): SlateConfig {
  const next = { ...current };
  if (percent === undefined) delete next.sidebarPercent;
  else next.sidebarPercent = percent;
  return next;
}

function widthMessage(percent: number | undefined): string {
  if (percent === undefined) return "Sidebar width reset to default";
  if (percent === SIDEBAR_PERCENT_NARROW) return "Sidebar width set to minimum";
  return `Sidebar width set to ${percent}%`;
}

class SlateFooter implements Component {
  invalidate(): void {}
  render(): string[] { return []; }
}

export default function piSlate(pi: ExtensionAPI): void {
  const configPath = join(getAgentDir(), "pi-slate.json");
  const loaded = loadConfig(configPath);
  const saveConfig = (next: SlateConfig): void => writeConfig(configPath, { ...next, footer: next.composerMetadata });
  let config = loaded.config;
  setProgressStyle(config.progress ?? "waves");
  // Runtime ownership is fixed until /reload, even when a command saves a new set.
  const selected = [...config.surfaces];
  const owns = (surface: typeof selected[number]): boolean => has(selected, surface);
  const requestedClaudeTools = owns("tool-cards") && config.toolStyle !== "default";
  const claudeTools = requestedClaudeTools && typeof pi.registerToolRenderer === "function";
  if (owns("tool-cards")) {
    installDiff(pi);
    if (claudeTools) installToolStyle(pi);
    else installRead(pi);
  }
  if (owns("editor")) installPromptPicker(pi);
  installExitCommand(pi);
  const sidebar = new Sidebar();
  const images = owns("editor") ? installImagePlaceholders(pi, owns("sidebar") ? sidebar : undefined, () => editorActive()) : undefined;
  const selection = new ComposerSelectionController();
  const skills = new SidebarSkills();
  const mcpFiles = new SidebarMcpFiles();
  const mcpHost = loadSidebarMcpHost(getPackageDir(), VERSION);
  const background = new BackgroundTasks();
  let resources: SidebarResources = { skills: [], commands: [], prompts: [], mcp: [] };
  let sessionStartedAt = 0;
  let turnStartedAt: number | undefined;
  let lastTurnMs: number | null = null;
  let dashboardClock: ReturnType<typeof setInterval> | undefined;
  const dashboardSubscriptions: Array<() => void> = [];
  let branchFacts: { leaf?: string | null; counts: ReturnType<typeof sidebarMessageCounts>; usage: ReturnType<typeof sidebarUsage> } | undefined;
  let noticeFilterDispose: (() => void) | undefined;
  let noticeFilterActive = false;
  let inspectingSidebar = false;
  let sidebarYielded = false;
  let sessionEpoch = 0;
  let currentContext: ExtensionContext | undefined;
  let cachedTheme: Theme | undefined;
  // Every ctx accessor throws once the host replaces or reloads the session. Render
  // loops, timers, and microtasks outlive that handoff, so probe before use and treat
  // a stale ctx as absent rather than crashing the host on a captured reference.
  const liveContext = (): ExtensionContext | undefined => {
    const ctx = currentContext;
    if (!ctx) return undefined;
    try { void ctx.mode; } catch {
      currentContext = undefined;
      return undefined;
    }
    return ctx;
  };
  const liveTheme = (): Theme | undefined => {
    const ctx = liveContext();
    if (ctx) cachedTheme = ctx.ui.theme;
    return cachedTheme;
  };
  let activeEditor: ComposerEditor | undefined;
  let gitBranch: string | null = null;
  let activeTui: TUI | undefined;
  let editorFactory: Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0];
  const editorActive = (): boolean => {
    const ctx = liveContext();
    return owns("editor") && ctx !== undefined && ctx.mode === "tui"
      && (typeof ctx.ui.getEditorComponent !== "function" || ctx.ui.getEditorComponent() === editorFactory);
  };
  let conversations: ReturnType<typeof installConversationBridge> | undefined;
  let messageWindow: MessageWindow | undefined;
  let toolGroups: ToolGroups | undefined;
  const syncToolGroups = (): void => {
    if (!claudeTools || liveContext()?.mode !== "tui") return;
    const chat = findChatContainer(layoutRootOf(activeTui));
    if (!chat || toolGroups?.container === chat) return;
    toolGroups?.dispose();
    toolGroups = new ToolGroups(chat, liveTheme);
  };
  const tokenRate = new TokenRateTracker();
  const thinkingFold = new ThinkingFoldTracker({ onChange: () => syncThinkingStatus() });
  const updates = new UpdateWatcher();
  const branch = new GitBranchPoller(pi, (next) => { gitBranch = next; requestRender(); });
  let contextEdge = {
    tokens: formatFocusedContextTokens(null, null, null),
    resources: formatFocusedContextResources(null, 0, 0),
    summary: "ctx —",
  };
  let requestRender = (_force = false) => {};

  const syncVisibleMessages = (): void => {
    syncToolGroups();
    if (!owns("transcript") || liveContext()?.mode !== "tui") return;
    messageWindow = syncMessageWindow(messageWindow, activeTui, resolveMessageLength(config.messageLength));
  };

  // A selected split allocates header width; unavailable sidebar hosts stay full-width.
  const columnWidth = (width: number): number => width;

  const syncSidebar = (ctx: ExtensionContext): void => {
    if (ctx.mode !== "tui" || !ctx.sessionManager || (!owns("sidebar") && !owns("editor")) || (sidebarYielded && !editorActive())) return;
    let tokens: number | null = null;
    let percent: number | null = null;
    let contextWindow: number | null = ctx.model?.contextWindow ?? null;
    let estimated = true;
    try {
      const usage = ctx.getContextUsage();
      estimated = usage?.tokens == null || !Number.isFinite(usage.tokens);
      const resolved = resolveContextTokens(
        usage,
        estimated ? ctx.sessionManager.buildContextEntries() : [],
        ctx.model?.contextWindow,
      );
      tokens = resolved.tokens;
      percent = resolved.percent;
      contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? null;
    } catch { /* Context can be temporarily unavailable; keep identity and other facts fresh. */ }
    const leaf = ctx.sessionManager.getLeafId?.();
    if (!branchFacts || leaf === undefined || leaf !== branchFacts.leaf) {
      const entries = ctx.sessionManager.getBranch();
      branchFacts = { leaf, counts: sidebarMessageCounts(entries), usage: sidebarUsage(entries) };
    }
    const spend = branchFacts.usage.cost;
    const skillCount = owns("sidebar") ? resources.skills.filter(skill => skill.loaded).length : countSkillCommands(pi.getCommands());
    const mcpCount = resources.mcp.filter(server => server.enabled === true).length;
    if (owns("sidebar") && !sidebarYielded) {
      sidebar.setSession({
        id: ctx.sessionManager.getSessionId?.() ?? "",
        name: ctx.sessionManager.getSessionName?.(),
        pid: process.pid, cwd: ctx.cwd, model: modelStatusLabel(ctx.model, config.modelDisplay), thinking: ctx.thinkingLevel ?? "—",
        tokens, percent, contextWindow, estimated,
        rate: tokenRate.rate() > 0 ? tokenRate.rate() : null, startedAt: sessionStartedAt, lastTurnMs,
        working: typeof ctx.isIdle === "function" && !ctx.isIdle(), ...branchFacts.counts, usage: branchFacts.usage,
      });
    }
    contextEdge = {
      tokens: formatFocusedContextTokens(percent, tokenRate.rate(), contextWindow),
      resources: formatFocusedContextResources(spend, skillCount, mcpCount),
      summary: `ctx ${estimated && percent !== null ? "~" : ""}${formatPercent(percent)}`,
    };
  };
  const refreshResources = (ctx: ExtensionContext): void => {
    if (ctx.mode !== "tui" || !ctx.sessionManager || (!owns("sidebar") && !owns("editor")) || (sidebarYielded && !editorActive())) return;
    const commands = pi.getCommands();
    skills.discoverCommands(commands);
    const registered = typeof pi.getMcpServers === "function" ? pi.getMcpServers() : [];
    const catalog = commandResources(commands);
    resources = { commands: catalog.commands, prompts: catalog.prompts, skills: skills.snapshot(),
      ...mcpFiles.snapshot(getAgentDir(), ctx.cwd, typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted(), registered) };
    if (owns("sidebar") && !sidebarYielded) sidebar.setResources(resources);
  };
  const stopDashboard = (): void => {
    clearInterval(dashboardClock); dashboardClock = undefined;
    for (const dispose of dashboardSubscriptions.splice(0)) dispose();
  };
  const inspect = (ctx: ExtensionContext, title: string, text: string): void => {
    if (inspectingSidebar || ctx.mode !== "tui") return;
    inspectingSidebar = true;
    void inspectSidebarText(ctx, sidebarText(title), text).catch(() => { try { ctx.ui.notify("Sidebar details unavailable", "warning"); } catch { /* Session UI may be gone. */ } })
      .finally(() => { inspectingSidebar = false; });
  };
  if (owns("sidebar")) {
    pi.on("resources_discover", () => {
      if (liveContext()?.mode === "tui") queueMicrotask(() => { const ctx = liveContext(); if (ctx && ctx.mode === "tui") refreshResources(ctx); });
    });
  }

  const install = (ctx: ExtensionContext): void => {
    if (ctx.mode === "tui" && requestedClaudeTools && !claudeTools) {
      ctx.ui.notify("Slate Claude Code tool style requires a host with registerToolRenderer; keeping default cards", "warning");
    }
    sessionEpoch += 1; sidebarYielded = false;
    if (!owns("header")) {
      noticeFilterDispose?.(); noticeFilterDispose = undefined; noticeFilterActive = false;
    }
    const mountedEpoch = sessionEpoch;
    currentContext = ctx;
    if (ctx.mode === "tui") cachedTheme = ctx.ui.theme;
    const mountedContext = (): ExtensionContext | undefined =>
      mountedEpoch === sessionEpoch ? liveContext() : undefined;
    const notify = (message: string, type: "info" | "warning" | "error"): void => {
      mountedContext()?.ui.notify(message, type);
    };
    conversations?.dispose();
    conversations = ctx.mode === "tui" && owns("editor") ? installConversationBridge(pi, {
      context: liveContext,
      editor: () => editorActive() ? activeEditor : undefined,
      tui: () => activeTui,
      canMount: () => owns("sidebar") && sidebar.splitActive && typeof (activeTui as TUI & { getFocusedComponent?: unknown })?.getFocusedComponent === "function",
      workspaceFocus: component => sidebar.ownsFocus(component),
      replaceChat: view => sidebar.replaceChat(view),
    }) : undefined;
    thinkingFold.stop();
    tokenRate.dispose();
    workingWord = undefined;
    stopWave();
    if (loaded.error) ctx.ui.notify(loaded.error, "warning");
    if (ctx.mode !== "tui") return;
    if (owns("tool-cards")) {
      // Only check tools Slate registers. Claude mode styles the native read
      // renderer without owning its registration, so native read is not a loss.
      try {
        const registeredCards = claudeTools ? ["edit", "write"] : ["edit", "write", "read"];
        const lost = pi.getAllTools().filter((tool) => registeredCards.includes(tool.name)
          && resolve(tool.sourceInfo.path) !== fileURLToPath(import.meta.url));
        if (lost.length) ctx.ui.notify(`Slate tool-cards unavailable for: ${lost.map((tool) => tool.name).join(", ")} (first registration wins)`, "warning");
      } catch { /* Older hosts cannot expose tool ownership. */ }
    }
    if (owns("editor")) branch.start(ctx.cwd);
    sessionStartedAt = Date.now(); turnStartedAt = undefined; lastTurnMs = null; branchFacts = undefined;
    if (owns("editor") || owns("sidebar")) {
      skills.reset(pi.getCommands());
      skills.restore(ctx.sessionManager.getBranch(), ctx.cwd);
      refreshResources(ctx);
      tokenRate.setOnChange(() => {
        const ctx = liveContext();
        if (ctx) syncSidebar(ctx);
        if (thinkingFold.elapsedMs() !== null) syncThinkingStatus();
      });
      syncSidebar(ctx);
    }

    if (owns("sidebar")) {
      stopDashboard();
      background.reset(ctx.sessionManager.getSessionId?.() ?? "");
      sidebar.reset();
      sidebar.setThemeProvider(liveTheme);
      sidebar.setFolds(config.sidebarSections);
      sidebar.setResources(resources);
      sidebar.setPreferredWidth(config.sidebarPercent);
      sidebar.setHidden(config.focused === true);
      dashboardSubscriptions.push(pi.events.on(BACKGROUND_TASKS_EVENT, (value) => {
        if (background.accept(value)) sidebar.setTasks(background.snapshot());
      }));
      pi.events.emit?.(BACKGROUND_TASKS_REQUEST, { version: 1, sessionId: ctx.sessionManager.getSessionId?.() ?? "" });
      sidebar.setActions({
        persistFold: (section, expanded) => {
          if (!mountedContext()) return undefined;
          if (loaded.error) { notify(loaded.error, "warning"); return undefined; }
          try {
            const latest = loadConfig(configPath);
            if (latest.error) { notify(latest.error, "warning"); return undefined; }
            const previous = latest.raw.sidebarSections;
            const sections = previous && typeof previous === "object" && !Array.isArray(previous) ? previous : {};
            const raw = { ...latest.raw, sidebarSections: { ...sections, [section]: expanded } };
            writeConfig(configPath, raw);
            const folds = parseSidebarFolds(raw.sidebarSections);
            config = { ...config, sidebarSections: folds }; return folds;
          }
          catch { notify("Could not save sidebar sections", "error"); return undefined; }
        },
        inspect: (title, text) => {
          const target = mountedContext();
          if (target) inspect(target, title, text);
        },
        commands: () => {
          const target = mountedContext();
          if (!target) return;
          void sessionMenu(target, "commands").catch(() => notify("Command catalog unavailable", "warning"));
        },
        persistWidth: (percent) => {
          if (!mountedContext()) return;
          try {
            const next = withSidebarPercent(config, percent);
            saveConfig(next);
            config = next;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            notify(`Could not save sidebar width: ${message}`, "error");
          }
        },
        copy: (text) => {
          const target = mountedContext();
          if (target) void copyWithFeedback(activeTui, notify, text);
        },
        openFile: (filePath) => {
          const context = mountedContext();
          if (!context) return;
          const target = resolve(context.cwd, filePath);
          const { command, args } = openExternalArgs(target);
          void Promise.resolve(pi.exec(command, args, { timeout: 5000 })).then(
            (result) => {
              if (result.code !== 0) notify("Could not open file", "error");
            },
            () => notify("Could not open file", "error"),
          );
        },
      });
      syncSidebar(ctx);
    }
    // belowEditor has no host leading spacer. This factory renders exactly zero rows.
    // It is a TUI handle, not a chrome owner or application bootstrap header.
    if (owns("sidebar") || owns("transcript") || claudeTools) {
      ctx.ui.setWidget("pi-slate:surface-host", (tui, theme) => {
        activeTui = tui;
        requestRender = (force = false) => tui.requestRender(force);
        queueMicrotask(syncToolGroups);
        if (owns("sidebar")) {
          sidebar.attach(tui, theme, () => { sidebarYielded = true; stopDashboard(); });
          if (sidebar.splitActive && !dashboardClock) {
            let ticks = 0;
            dashboardClock = setInterval(() => {
              const ctx = liveContext();
              if (!ctx || ctx.mode !== "tui" || !sidebar.splitActive) return;
              sidebar.tick();
              if (++ticks % 5 === 0) { refreshResources(ctx); syncSidebar(ctx); }
            }, 1000);
            dashboardClock.unref?.();
          }
          if (!sidebar.splitActive && config.focused !== true) {
            ctx.ui.notify("Slate sidebar unavailable: a compatible fullscreen host is required", "warning");
          }
        }
        if (owns("transcript")) queueMicrotask(() => {
          if (!mountedContext()) return;
          syncVisibleMessages();
          if (!messageWindow) notify("Slate transcript unavailable: a compatible message-window host is required", "warning");
        });
        return { render: () => [], invalidate() {} };
      }, { placement: "belowEditor" });
    }
    if (owns("header")) {
      updates.setOnChange(() => requestRender());
      updates.start(ctx.cwd);
      ctx.ui.setHeader((tui, theme) => {
        requestRender = (force = false) => tui.requestRender(force);
        // Header factory runs inside setHeader, before /new appends the stock chat copy.
        const attachFilter = (chat: ReturnType<typeof findChatContainer>): void => {
          if (!chat) return;
          noticeFilterDispose?.();
          noticeFilterDispose = installNewSessionNoticeFilter(chat);
          noticeFilterActive = true;
        };
        attachFilter(findChatContainer(layoutRootOf(tui)));
        if (!noticeFilterActive) queueMicrotask(() => {
          if (mountedContext()) attachFilter(findChatContainer(layoutRootOf(tui)));
        });
        return new SlateHeader(theme, liveContext, columnWidth, () => updates.notice, () => {
          const ctx = liveContext();
          return {
            version: VERSION,
            model: ctx ? modelStatusLabel(ctx.model, config.modelDisplay) : "",
            thinking: ctx?.thinkingLevel ?? "",
          };
        }, () => config.logo ?? "minimal");
      });
    }
    if (owns("footer")) ctx.ui.setFooter(() => new SlateFooter());
    if (owns("editor")) {
      editorFactory = (tui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager) => {
        const tuiChanged = Boolean(activeTui && activeTui !== tui);
        if (tuiChanged) conversations?.close();
        const previousDown = tuiChanged ? undefined : activeEditor?.onDownBoundary;
        activeTui = tui;
        images?.detachEditor();
        selection.dispose();
        const minimalEditorTheme: EditorTheme = {
          ...editorTheme,
          borderColor: chromePaint(ctx.ui.theme),
        };
        const metadata = (current: ExtensionContext) => ({
          project: basename(current.cwd) || current.cwd, branch: gitBranch,
          model: current.model, modelDisplay: config.modelDisplay, thinking: current.thinkingLevel,
          footer: config.composerMetadata, showPid: config.showPid === true, theme: current.ui.theme,
          paddingX: composerPaddingX(config.density),
          working: typeof current.isIdle === "function" && !current.isIdle(),
          workspaceHeader: owns("header"),
          dashboardVisible: sidebar.isVisible(tui.terminal.columns, tui.terminal.rows),
          ...(!sidebar.isVisible(tui.terminal.columns, tui.terminal.rows) ? { context: contextEdge } : {}),
        });
        let cachedMetadata = metadata(ctx);
        activeEditor = new ComposerEditor(
          tui,
          minimalEditorTheme,
          keybindings,
          () => {
            const ctx = liveContext();
            if (ctx) cachedMetadata = metadata(ctx);
            return cachedMetadata;
          },
          {
            paddingX: composerPaddingX(config.density),
            autocompleteMaxVisible: 8,
            embedWorkingStatus: true,
          },
        );
        if (previousDown) activeEditor.onDownBoundary = previousDown;
        // Images wrap first so composer-selection stays outermost: select-all
        // followed by backspace must clear the whole prompt before the atomic
        // image-token delete sees the keypress.
        images?.attachEditor(activeEditor);
        selection.attach(activeEditor, {
          copy: (text) => mountedContext() ? copyWithFeedback(tui, notify, text) : Promise.resolve(),
          requestRender: () => tui.requestRender(),
        });
        activeTui = tui;
        requestRender = (force = false) => tui.requestRender(force);
        return activeEditor;
      };
      ctx.ui.setEditorComponent(editorFactory);
    }
    requestRender(true);
  };

  const workingWords = createWordPicker();
  let workingWord: string | undefined;
  let waveTimer: ReturnType<typeof setInterval> | undefined;
  // The wave rolls in the Slate composer border; without a live custom editor
  // the working status falls back to the classic word.
  const waveHost = (ctx: ExtensionContext | undefined): ctx is ExtensionContext =>
    Boolean(ctx && ctx.mode === "tui" && editorActive() && activeEditor);
  const stopWave = (): void => {
    if (waveTimer !== undefined) { clearInterval(waveTimer); waveTimer = undefined; }
    if (!isWaveActive()) return;
    setWaveActive(false);
    // Restore the host default so a blanked message never sticks if the
    // Slate composer goes away mid-session.
    try { currentContext?.ui.setWorkingMessage?.(undefined); } catch { /* stale ctx */ }
    requestRender();
  };
  const startWave = (ctx: ExtensionContext): void => {
    if (waveTimer !== undefined) { clearInterval(waveTimer); waveTimer = undefined; }
    setWaveActive(true);
    try {
      // Blank the indicator text; the composer border renders the wave instead.
      ctx.ui.setWorkingMessage("");
      requestRender();
    } catch { setWaveActive(false); return; }
    const timer = setInterval(() => {
      const current = liveContext();
      if (!waveHost(current)) { stopWave(); return; }
      try { advanceWave(); requestRender(); } catch { stopWave(); }
    }, 120);
    timer.unref();
    waveTimer = timer;
  };
  const syncThinkingStatus = (): void => {
    const ctx = liveContext();
    if (!editorActive() || !ctx || !workingWord || typeof ctx.ui.setWorkingMessage !== "function") return;
    const elapsed = thinkingFold.elapsedMs();
    const rate = tokenRate.rate();
    const label = elapsed === null ? workingWord : formatLiveThinking(workingWord, elapsed, rate > 0 ? rate : null);
    try {
      ctx.ui.setWorkingMessage(ctx.ui.theme.italic(label));
      requestRender();
    } catch {
      // A stale UI context must not turn the interval callback into an uncaught error.
      thinkingFold.stop();
    }
  };

  pi.on("session_start", async (_event, ctx) => { mcpFiles.setHost(await mcpHost); install(ctx); });
  pi.on("agent_start", (_event, ctx) => {
    currentContext = ctx;
    if (ctx.mode === "tui" && (owns("sidebar") || editorActive() || owns("transcript"))) {
      turnStartedAt = Date.now(); syncSidebar(ctx);
    }
    if (!editorActive()) return;
    thinkingFold.stop();
    if (waveHost(ctx)) {
      workingWord = undefined;
      startWave(ctx);
      return;
    }
    workingWord = workingWords.next();
    syncThinkingStatus();
  });
  pi.on("agent_end", (_event, ctx) => {
    currentContext = ctx;
    thinkingFold.stop();
    stopWave();
    if (turnStartedAt !== undefined) {
      const finishedAt = Date.now();
      lastTurnMs = Math.max(0, finishedAt - turnStartedAt);
      turnStartedAt = undefined;
      if (ctx.mode === "tui") {
        const chat = findChatContainer(layoutRootOf(activeTui));
        chat?.addChild(new TurnCompletion(lastTurnMs, finishedAt, liveTheme));
        syncVisibleMessages();
        requestRender();
      }
    }
    if (owns("sidebar")) { background.clearShells(); sidebar.setTasks(background.snapshot()); }
    syncSidebar(ctx);
  });
  pi.on("model_select", (_event, ctx) => {
    currentContext = ctx;
    syncSidebar(ctx);
  });
  pi.on("thinking_level_select", (_event, ctx) => {
    currentContext = ctx;
    syncSidebar(ctx);
    requestRender();
  });
  pi.on("message_start", (event, ctx) => {
    currentContext = ctx;
    if (event.message.role === "assistant") {
      thinkingFold.stop();
      if (ctx.mode === "tui" && (owns("editor") || owns("sidebar"))) tokenRate.startMessage();
    }
  });
  pi.on("message_update", (event, ctx) => {
    currentContext = ctx;
    if (event.message.role !== "assistant") return;
    if (ctx.mode === "tui" && (owns("editor") || owns("sidebar"))) tokenRate.observePartial(estimateAssistantTokens(event.message));
    if (editorActive() && typeof ctx.ui.setWorkingMessage === "function") {
      thinkingFold.observe(event.assistantMessageEvent, event.message);
    } else {
      thinkingFold.stop();
    }
  });
  pi.on("message_end", (event, ctx) => {
    currentContext = ctx;
    if (event.message.role === "assistant") {
      thinkingFold.stop();
      if (ctx.mode === "tui" && (owns("editor") || owns("sidebar"))) tokenRate.endMessage();
    } else if (owns("sidebar") && ctx.mode === "tui" && event.message.role === "toolResult") {
      skills.observeNested(event.message.nestedCalls?.calls ?? [], ctx.cwd);
    }
    refreshResources(ctx);
    syncSidebar(ctx);
    syncVisibleMessages();
  });
  pi.on("session_info_changed", (_event, ctx) => { currentContext = ctx; syncSidebar(ctx); });
  if (owns("sidebar")) {
    pi.on("before_agent_start", (event, ctx) => {
      if (ctx.mode !== "tui") return;
      if (event.systemPromptOptions?.skills) skills.discover(event.systemPromptOptions.skills);
      if (event.messageType === "user") skills.observePrompt(event.prompt);
      refreshResources(ctx); syncSidebar(ctx);
    });
    pi.on("tool_execution_start", (event, ctx) => {
      if (ctx.mode !== "tui") return;
      skills.readStart(event.toolCallId, event.toolName, event.args, ctx.cwd);
      background.shellStart(event.toolCallId, event.toolName, event.args, Date.now());
      sidebar.setTasks(background.snapshot());
    });
    pi.on("tool_execution_end", (event, ctx) => {
      if (ctx.mode !== "tui") return;
      skills.readEnd(event.toolCallId, event.isError);
      background.shellEnd(event.toolCallId); sidebar.setTasks(background.snapshot());
      refreshResources(ctx);
    });
  }
  pi.on("turn_end", (_event, ctx) => {
    currentContext = ctx;
    syncSidebar(ctx);
  });
  pi.on("agent_settled", (_event, ctx) => {
    currentContext = ctx;
    refreshResources(ctx);
    syncSidebar(ctx);
  });
  pi.on("session_compact", (_event, ctx) => {
    currentContext = ctx;
    syncSidebar(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    currentContext = ctx;
    thinkingFold.stop();
    if (owns("sidebar") && ctx.mode === "tui") {
      branchFacts = undefined; skills.restore(ctx.sessionManager.getBranch(), ctx.cwd);
      background.reset(ctx.sessionManager.getSessionId?.() ?? ""); sidebar.setTasks([]);
      pi.events.emit?.(BACKGROUND_TASKS_REQUEST, { version: 1, sessionId: ctx.sessionManager.getSessionId?.() ?? "" });
      refreshResources(ctx); syncSidebar(ctx);
    }
    syncVisibleMessages();
  });
  pi.on("session_shutdown", (_event, ctx) => {
    sessionEpoch += 1;
    workingWord = undefined;
    stopWave();
    thinkingFold.stop();
    tokenRate.dispose();
    images?.dispose();
    selection.dispose();
    stopDashboard();
    mcpFiles.clear();
    background.reset("");
    branch.dispose();
    updates.dispose();
    toolGroups?.dispose();
    toolGroups = undefined;
    messageWindow?.dispose();
    messageWindow = undefined;
    noticeFilterDispose?.(); noticeFilterDispose = undefined; noticeFilterActive = false;
    conversations?.dispose();
    conversations = undefined;
    activeTui = undefined;
    sidebar.dispose();
    requestRender(true);
    currentContext = undefined;
    if (ctx.mode !== "tui") return;
    // Host chrome has no header/footer ownership getters. /reload resets it;
    // cleanup must not clear a successor's slots (or any unselected surface).
    activeEditor = undefined;
    gitBranch = null;
    requestRender = () => {};
  });

  const apply = (next: SlateConfig, message: string, ctx: ExtensionContext): void => {
    if (loaded.error) { ctx.ui.notify(loaded.error, "warning"); return; }
    try {
      saveConfig(next);
      config = next;
      setProgressStyle(next.progress ?? "waves");
      if (owns("sidebar")) {
        sidebar.setPreferredWidth(config.sidebarPercent);
        sidebar.setHidden(config.focused === true);
        sidebar.setFolds(config.sidebarSections);
      }
      activeEditor?.setPaddingX(composerPaddingX(config.density));
      syncVisibleMessages();
      requestRender(true);
      ctx.ui.notify(message, "info");
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Could not save Slate settings: ${messageText}`, "error");
    }
  };

  const pickProgress = async (ctx: ExtensionContext): Promise<ProgressStyle | undefined> => {
    const value = await ctx.ui.select("Progress indicator", PROGRESS_STYLES.map((s) =>
      withCurrent(PROGRESS_LABELS[s], (config.progress ?? "waves") === s)));
    if (!value) return undefined;
    const key = withoutCurrent(value);
    return PROGRESS_STYLES.find((s) => PROGRESS_LABELS[s] === key);
  };

  const pickLogo = async (ctx: ExtensionContext): Promise<LogoStyle | undefined> => {
    const value = await ctx.ui.select("Header logo", LOGO_STYLES.map((style) =>
      withCurrent(style === "minimal" ? "Minimal (classic white Pi)" : "Original", (config.logo ?? "minimal") === style)));
    const key = value ? withoutCurrent(value) : undefined;
    if (key === "Original") return "original";
    if (key === "Minimal (classic white Pi)") return "minimal";
    return undefined;
  };

  const pickDensity = async (ctx: ExtensionContext): Promise<SlateConfig["density"] | undefined> => {
    const value = await ctx.ui.select("Density", [
      withCurrent("Comfortable", config.density === "comfortable"),
      withCurrent("Compact", config.density === "compact"),
    ]);
    const key = value ? withoutCurrent(value) : undefined;
    if (key === "Comfortable") return "comfortable";
    if (key === "Compact") return "compact";
    return undefined;
  };

  const pickFooter = async (ctx: ExtensionContext): Promise<SlateConfig["composerMetadata"] | undefined> => {
    const value = await ctx.ui.select("Composer metadata", [
      withCurrent("Standard", config.composerMetadata === "standard"),
      withCurrent("Minimal", config.composerMetadata === "minimal"),
    ]);
    const key = value ? withoutCurrent(value) : undefined;
    if (key === "Standard") return "standard";
    if (key === "Minimal") return "minimal";
    return undefined;
  };

  const currentCatppuccin = (ctx: ExtensionContext) => resolveCatppuccinTheme(ctx.ui.theme.name);

  const pickStyle = async (ctx: ExtensionContext): Promise<Style | undefined> => {
    const current = currentCatppuccin(ctx).style;
    const value = await ctx.ui.select(
      "Style",
      STYLES.map((style) => withCurrent(STYLE_LABELS[style], style === current)),
    );
    if (!value) return undefined;
    const key = withoutCurrent(value);
    return STYLES.find((style) => STYLE_LABELS[style] === key);
  };

  const applyNamedTheme = (ctx: ExtensionContext, name: string, message?: string): void => {
    const result = ctx.ui.setTheme(name);
    if (!result.success) {
      ctx.ui.notify(result.error ?? `Could not load ${name}. Run /reload first.`, "error");
      return;
    }
    persistTheme(ctx.cwd, name);
    requestRender(true);
    ctx.ui.notify(message ?? `Theme set to ${name === SLATE_NATIVE_THEME ? "system default" : name}`, "info");
  };

  const applyCatppuccin = (ctx: ExtensionContext, flavor: Flavor, style: Style): void => {
    const next = resolveCatppuccinTheme(ctx.ui.theme.name, flavor, style);
    applyNamedTheme(ctx, next.name, themeMessage(next.flavor, next.style));
  };

  const pickTheme = async (ctx: ExtensionContext): Promise<void> => {
    const mocha = currentCatppuccin(ctx).style;
    const value = await ctx.ui.select("Theme", [
      withCurrent("System default", ctx.ui.theme.name === SLATE_NATIVE_THEME),
      withCurrent("Tokyo Night", ctx.ui.theme.name === SLATE_THEME),
      ...STYLES.map((style) => withCurrent(STYLE_LABELS[style], ctx.ui.theme.name?.startsWith("catppuccin-") === true && style === mocha)),
    ]);
    if (!value) return;
    const key = withoutCurrent(value);
    if (key === "System default") { applyNamedTheme(ctx, SLATE_NATIVE_THEME); return; }
    if (key === "Tokyo Night") { applyNamedTheme(ctx, SLATE_THEME, "Theme set to Tokyo Night"); return; }
    const style = STYLES.find((item) => STYLE_LABELS[item] === key);
    if (style) applyCatppuccin(ctx, currentCatppuccin(ctx).flavor, style);
  };

  const pickWidth = async (ctx: ExtensionContext): Promise<{ picked: true; width?: number } | undefined> => {
    const percent = sidebar.preferredWidth ?? config.sidebarPercent;
    const defaultLabel = "Default (20%)";
    const narrowLabel = "Narrow (minimum)";
    const mediumLabel = "Medium (30%)";
    const wideLabel = "Wide (40%)";
    const customLabel = percent !== undefined
      && percent !== SIDEBAR_PERCENT_NARROW
      && percent !== SIDEBAR_PERCENT_DEFAULT
      && percent !== SIDEBAR_PERCENT_MEDIUM
      && percent !== SIDEBAR_PERCENT_WIDE
      ? `Custom (${percent}%)`
      : "Custom…";
    const choice = await ctx.ui.select("Sidebar width", [
      withCurrent(defaultLabel, percent === undefined || percent === SIDEBAR_PERCENT_DEFAULT),
      withCurrent(narrowLabel, percent === SIDEBAR_PERCENT_NARROW),
      withCurrent(mediumLabel, percent === SIDEBAR_PERCENT_MEDIUM),
      withCurrent(wideLabel, percent === SIDEBAR_PERCENT_WIDE),
      withCurrent(customLabel, customLabel.startsWith("Custom (")),
    ]);
    if (!choice) return undefined;
    const key = withoutCurrent(choice);
    if (key === defaultLabel) return { picked: true };
    if (key === narrowLabel) return { picked: true, width: SIDEBAR_PERCENT_NARROW };
    if (key === mediumLabel) return { picked: true, width: SIDEBAR_PERCENT_MEDIUM };
    if (key === wideLabel) return { picked: true, width: SIDEBAR_PERCENT_WIDE };
    if (key !== customLabel) return undefined;
    const typed = await ctx.ui.input(
      "Sidebar percent",
      percent !== undefined && percent > 0 ? String(percent) : "30",
    );
    if (!typed) return undefined;
    const parsed = parseSidebarWidthArg(typed);
    if (!parsed.ok || parsed.percent === undefined) {
      ctx.ui.notify(SLATE_USAGE, "error");
      return undefined;
    }
    return { picked: true, width: parsed.percent };
  };

  const pickMessageLength = async (ctx: ExtensionContext): Promise<{ picked: true; value?: number | "all" } | undefined> => {
    const current = config.messageLength;
    const defaultLabel = `Default (${MESSAGE_LENGTH_DEFAULT})`;
    const shortLabel = String(MESSAGE_LENGTH_SHORT);
    const longLabel = String(MESSAGE_LENGTH_LONG);
    const allLabel = "All";
    const customLabel = typeof current === "number"
      && current !== MESSAGE_LENGTH_DEFAULT
      && current !== MESSAGE_LENGTH_SHORT
      && current !== MESSAGE_LENGTH_LONG
      ? `Custom (${current})`
      : "Custom…";
    const choice = await ctx.ui.select("Message length", [
      withCurrent(defaultLabel, current === undefined || current === MESSAGE_LENGTH_DEFAULT),
      withCurrent(shortLabel, current === MESSAGE_LENGTH_SHORT),
      withCurrent(longLabel, current === MESSAGE_LENGTH_LONG),
      withCurrent(allLabel, current === "all"),
      withCurrent(customLabel, customLabel.startsWith("Custom (")),
    ]);
    if (!choice) return undefined;
    const key = withoutCurrent(choice);
    if (key === defaultLabel) return { picked: true };
    if (key === shortLabel) return { picked: true, value: MESSAGE_LENGTH_SHORT };
    if (key === longLabel) return { picked: true, value: MESSAGE_LENGTH_LONG };
    if (key === allLabel) return { picked: true, value: "all" };
    if (key !== customLabel) return undefined;
    const typed = await ctx.ui.input(
      "Visible messages",
      typeof current === "number" ? String(current) : String(MESSAGE_LENGTH_DEFAULT),
    );
    if (!typed) return undefined;
    const parsed = parseMessageLengthArg(typed);
    if (!parsed.ok) {
      ctx.ui.notify(SLATE_USAGE, "error");
      return undefined;
    }
    return { picked: true, value: parsed.value };
  };

  const openUrl = async (url: string): Promise<boolean> => {
    const { command, args } = openExternalArgs(url);
    const result = await pi.exec(command, args, { timeout: 5000 });
    return result.code === 0;
  };

  const fileBug = async (ctx: ExtensionContext, active: () => boolean): Promise<void> => {
    const title = (await ctx.ui.input("Issue title", "Short summary"))?.trim();
    if (!active() || !title) return;
    const body = await ctx.ui.editor(
      "Issue details",
      issueTemplate({
        slateVersion: SLATE_VERSION,
        piVersion: VERSION,
        platform: `${process.platform} ${process.arch}`,
      }),
    );
    if (!active() || body === undefined) return;
    try {
      await copyToClipboard(formatBugReport(title, body));
      if (active()) ctx.ui.notify("Bug report copied to clipboard", "info");
    } catch {
      if (active()) ctx.ui.notify("Could not copy bug report", "error");
    }
  };

  const handleBug = async (ctx: ExtensionContext, action?: "file" | "open"): Promise<void> => {
    const owner = sessionEpoch;
    const active = (): boolean => {
      if (owner !== sessionEpoch) return false;
      try { void ctx.mode; return true; } catch { return false; }
    };
    let next = action;
    if (!next) {
      const choice = await ctx.ui.select("Slate bug", ["Copy a bug report", "Open package page"]);
      if (!active()) return;
      if (choice === "Copy a bug report") next = "file";
      else if (choice === "Open package page") next = "open";
      else return;
    }
    if (next === "open") {
      const opened = await openUrl(SLATE_ISSUES_URL);
      if (active()) ctx.ui.notify(opened ? "Opened pi-slate on npm" : `Open ${SLATE_ISSUES_URL}`, opened ? "info" : "error");
      return;
    }
    await fileBug(ctx, active);
  };

  const applyFocused = (ctx: ExtensionContext, value?: boolean): void => {
    const on = value ?? !config.focused;
    apply({ ...config, focused: on }, on ? "Focused mode on" : "Focused mode off", ctx);
  };

  const sessionMenu = async (ctx: ExtensionContext, section?: "mcp" | "skills" | "prompts" | "commands" | "tasks" | "image"): Promise<void> => {
    if (ctx.mode !== "tui" || !owns("sidebar")) {
      ctx.ui.notify("Select the Slate sidebar surface and /reload to use the session dashboard", "info"); return;
    }
    const owner = ctx.sessionManager.getSessionId(), epoch = sessionEpoch;
    const active = (): boolean => {
      const ctx = liveContext();
      return epoch === sessionEpoch && ctx !== undefined && ctx.mode === "tui" && ctx.sessionManager.getSessionId() === owner;
    };
    refreshResources(ctx); syncSidebar(ctx);
    if (!section) {
      const choice = await pickSidebarItem(ctx, "Session dashboard", ["Session details", "MCP servers", "Skills", "Prompts", "Commands", "Background tasks", "Image"]);
      if (!choice || !active()) return;
      if (choice === "Session details") { inspect(ctx, "Session", sidebar.sessionDetails()); return; }
      section = ({ "MCP servers": "mcp", Skills: "skills", Prompts: "prompts", Commands: "commands", "Background tasks": "tasks", Image: "image" } as const)[choice as "MCP servers" | "Skills" | "Prompts" | "Commands" | "Background tasks" | "Image"];
    }
    if (section === "mcp" || section === "skills" || section === "prompts") {
      const mcp = [...resources.mcp]; const skills = [...resources.skills]; const prompts = [...resources.prompts];
      const items = section === "mcp" ? mcp : section === "skills" ? skills : prompts;
      const expanded = !sidebar.getFolds()[section];
      const toggle = `${expanded ? "Expand" : "Collapse"} sidebar section`;
      const labels = items.map((item, i) => `${i + 1}. ${item.name}`);
      const choice = await pickSidebarItem(ctx, section === "mcp" ? "MCP servers (configured state)" : section === "skills" ? "Skills (available vs observed loaded)" : "Prompts (templates)", [toggle, ...labels]);
      if (!choice || !active()) return;
      if (choice === toggle) { sidebar.setSection(section, expanded); return; }
      const index = labels.indexOf(choice);
      if (section === "mcp") {
        const item = mcp[index];
        if (item) inspect(ctx, item.name, `${item.enabled === null ? "—" : item.enabled ? "enabled" : "disabled"} (configuration, not connection status)\nSource: ${item.source}\nUse /mcp to manage this server.`);
      } else if (section === "skills") {
        const item = skills[index];
        if (item) inspect(ctx, item.name, `${item.loaded ? "Instructions observed loaded on this branch" : "Available; not observed loaded"}\n${item.path}`);
      } else {
        const item = prompts[index];
        if (item) inspect(ctx, item.name, `${item.description ? `${item.description}\n` : ""}Source: ${item.source}\nInsert with /slate session commands.`);
      }
    } else if (section === "commands") {
      const items = [...resources.commands, ...resources.prompts];
      const labels = items.map(item => `/${item.name} · ${item.source}`);
      if (!labels.length) { ctx.ui.notify("No extension or prompt commands available", "info"); return; }
      const choice = await pickSidebarItem(ctx, "Insert command (does not execute)", labels);
      if (!active()) return;
      const item = choice ? items[labels.indexOf(choice)] : undefined;
      if (item) ctx.ui.pasteToEditor(`/${item.name} `);
    } else if (section === "tasks") {
      const tasks = background.snapshot();
      const labels = tasks.map((task, i) => `${i + 1}. ${task.label} · ${task.state}`);
      if (!tasks.length) { inspect(ctx, "Background tasks", "No agent-started tasks observed. Detached jobs appear when their owner reports them."); return; }
      const choice = await pickSidebarItem(ctx, "Background tasks (read-only)", labels);
      if (!active()) return;
      const task = choice ? tasks[labels.indexOf(choice)] : undefined;
      if (task) inspect(ctx, task.label, `${task.kind} · ${task.state}\nSource: ${task.source}\nID: ${task.id}\n${task.pid ? `PID: ${task.pid}\n` : ""}${task.detail ?? ""}`);
    } else if (section === "image") {
      const path = sidebar.imagePath();
      if (!path) { ctx.ui.notify("No image selected", "info"); return; }
      const pinned = !sidebar.isImagePinned();
      const choice = await pickSidebarItem(ctx, "Image", [pinned ? "Pin" : "Unpin", "Copy path", "Open", "Clear selection"]);
      if (!active() || sidebar.imagePath() !== path) return;
      if (choice === "Pin" || choice === "Unpin") sidebar.setImagePinned(pinned);
      else if (choice === "Clear selection") sidebar.clearImage();
      else if (choice === "Copy path") void copyWithFeedback(activeTui, (message, kind) => {
        if (active()) ctx.ui.notify(message, kind);
      }, path);
      else if (choice === "Open") {
        const { command, args } = openExternalArgs(path);
        try {
          const result = await pi.exec(command, args, { timeout: 5000 });
          if (result.code !== 0 && active()) ctx.ui.notify("Could not open image", "error");
        } catch {
          if (active()) ctx.ui.notify("Could not open image", "error");
        }
      }
    }
  };

  pi.registerCommand("slate", {
    description: "Session dashboard, surfaces, density, composer metadata, sidebar, focused mode, PID display, header logo, progress indicator, message length, theme, or file a bug",
    getArgumentCompletions: slateArgumentCompletions,
    handler: async (args, ctx) => {
      const parsed = parseSlateArgs(args);
      if (!parsed.ok) {
        ctx.ui.notify(SLATE_USAGE, "error");
        return;
      }

      let kind = parsed.kind;
      if (kind === "menu") {
        const setting = await ctx.ui.select("Slate", ["Session dashboard", "Surfaces", "Density", "Composer metadata", "Sidebar width", "Focused", "PID display", "Header logo", "Progress indicator", "Message length", "Theme", "File a bug"]);
        if (setting === "Session dashboard") { await sessionMenu(ctx); return; }
        if (setting === "Surfaces") {
          const names = await ctx.ui.input("Surfaces (names separated by spaces, full, or none; reload required)", formatSurfaces(config.surfaces));
          if (!names) return;
          const choice = parseSlateArgs(`surfaces ${names === "full" || names === "none" ? names : `set ${names}`}`);
          if (!choice.ok || choice.kind !== "surfaces" || choice.value === undefined) { ctx.ui.notify(SLATE_USAGE, "error"); return; }
          apply({ ...config, surfaces: choice.value }, `Slate surfaces saved: ${formatSurfaces(choice.value)}. Run /reload (reload required).`, ctx);
          return;
        }
        if (setting === "Density") kind = "density";
        else if (setting === "Composer metadata") kind = "footer";
        else if (setting === "Sidebar width") kind = "width-menu";
        else if (setting === "Focused") kind = "focused";
        else if (setting === "PID display") kind = "pid";
        else if (setting === "Header logo") kind = "logo";
        else if (setting === "Progress indicator") kind = "progress";
        else if (setting === "Message length") kind = "message-length-menu";
        else if (setting === "Theme") kind = "theme-menu";
        else if (setting === "File a bug") kind = "bug-menu";
        else return;
      }

      if (parsed.kind === "session") { await sessionMenu(ctx, parsed.section); return; }

      if (parsed.kind === "surfaces") {
        if (parsed.value === undefined) {
          ctx.ui.notify(`Slate surfaces: ${formatSurfaces(config.surfaces)}. Active: ${formatSurfaces(selected)}. Use /slate surfaces set <names>, full, or none; changes require /reload.`, "info");
        } else {
          apply({ ...config, surfaces: parsed.value }, `Slate surfaces saved: ${formatSurfaces(parsed.value)}. Run /reload (reload required).`, ctx);
        }
        return;
      }

      if (kind === "density") {
        const density = (parsed.kind === "density" ? parsed.value : undefined) ?? await pickDensity(ctx);
        if (!density) return;
        apply({ ...config, density }, `Density set to ${density}`, ctx);
        return;
      }

      if (kind === "footer") {
        const footer = (parsed.kind === "footer" ? parsed.value : undefined) ?? await pickFooter(ctx);
        if (!footer) return;
        apply({ ...config, composerMetadata: footer }, `Composer metadata set to ${footer}`, ctx);
        return;
      }

      if (kind === "progress") {
        const progress = (parsed.kind === "progress" ? parsed.value : undefined) ?? await pickProgress(ctx);
        if (!progress) return;
        apply({ ...config, progress }, `Progress indicator set to ${PROGRESS_LABELS[progress]}`, ctx);
        return;
      }

      if (kind === "focused") {
        applyFocused(ctx, parsed.kind === "focused" ? parsed.value : undefined);
        return;
      }

      if (kind === "pid") {
        const on = parsed.kind === "pid" && parsed.value !== undefined ? parsed.value : !config.showPid;
        apply({ ...config, showPid: on }, on ? "PID display on" : "PID display off", ctx);
        return;
      }

      if (kind === "logo") {
        const logo = (parsed.kind === "logo" ? parsed.value : undefined) ?? await pickLogo(ctx);
        if (!logo) return;
        apply({ ...config, logo }, logo === "minimal" ? "Header logo set to minimal (classic white Pi)" : "Header logo set to original", ctx);
        return;
      }

      if (parsed.kind === "width") {
        apply(withSidebarPercent({ ...config, focused: false }, parsed.width), widthMessage(parsed.width), ctx);
        return;
      }

      if (parsed.kind === "message-length") {
        apply(withMessageLength(config, parsed.value), messageLengthMessage(parsed.value), ctx);
        return;
      }

      if (kind === "message-length" || kind === "message-length-menu") {
        const picked = await pickMessageLength(ctx);
        if (!picked) return;
        apply(withMessageLength(config, picked.value), messageLengthMessage(picked.value), ctx);
        return;
      }

      if (kind === "bug" || kind === "bug-menu") {
        await handleBug(ctx, parsed.kind === "bug" ? parsed.action : undefined);
        return;
      }

      if (kind === "theme-menu") {
        await pickTheme(ctx);
        return;
      }

      if (parsed.kind === "named-theme") {
        applyNamedTheme(ctx, parsed.name); return;
      }

      if (parsed.kind === "theme") {
        const style = parsed.style ?? (parsed.flavor ? currentCatppuccin(ctx).style : await pickStyle(ctx));
        if (!style) return;
        applyCatppuccin(ctx, parsed.flavor ?? currentCatppuccin(ctx).flavor, style);
        return;
      }

      if (kind === "style") {
        const style = (parsed.kind === "style" ? parsed.value : undefined) ?? await pickStyle(ctx);
        if (!style) return;
        applyCatppuccin(ctx, currentCatppuccin(ctx).flavor, style);
        return;
      }

      const picked = await pickWidth(ctx);
      if (!picked) return;
      apply(withSidebarPercent({ ...config, focused: false }, picked.width), widthMessage(picked.width), ctx);
    },
  });
}
