import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  copyToClipboard,
  getAgentDir,
  VERSION,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
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
import { GitStatusPoller } from "./git-status.ts";
import { GitBranchPoller } from "./git-branch.ts";
import { formatSurfaces, has, parseSurfaceConfig, type SurfaceConfig } from "./surfaces.ts";
import { fileKey, formatFileLabel } from "./files-modified.ts";
import { GitDiffPreviewLoader } from "./git-diff.ts";
import { Sidebar } from "./sidebar.ts";
import { DiffWorkspaceView } from "./workspace.ts";
import { TurnImpactTracker } from "./turn-impact.ts";
import { resolveContextTokens, sessionSpend } from "./context-usage.ts";
import { estimateAssistantTokens, TokenRateTracker } from "./token-rate.ts";
import { createWordPicker } from "./working-words.ts";
import { formatLiveThinking, ThinkingFoldTracker } from "./thinking-fold.ts";
import {
  countSkillCommands,
  formatFocusedContextResources,
  formatFocusedContextTokens,
  mergeMcpServerMaps,
  parseMcpEnabledCount,
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
import { syncMessageWindow, type MessageWindow } from "./message-window.ts";
import {
  STYLE_LABELS,
  STYLES,
  resolveCatppuccinTheme,
  themeMessage,
  type Flavor,
  type Style,
} from "./catppuccin.ts";
import { persistTheme } from "./install-defaults.ts";

type SlateConfig = SurfaceConfig & {
  density: "comfortable" | "compact";
  sidebarPercent?: number;
  focused?: boolean;
  messageLength?: number | "all";
  modelDisplay?: ModelDisplay;
  showPid?: boolean;
};

function loadMessageLength(value: unknown): number | "all" | undefined {
  if (value === "all") return "all";
  return parseMessageLength(value);
}

function readOptionalJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
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

function loadConfig(configPath: string): { config: SlateConfig; error?: string } {
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


function writeConfig(configPath: string, config: SlateConfig): void {
  const temporaryPath = `${configPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify({ ...config, footer: config.composerMetadata }, null, 2)}\n`, "utf8");
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
  const saveConfig = (next: SlateConfig): void => writeConfig(configPath, next);
  let config = loaded.config;
  // Runtime ownership is fixed until /reload, even when a command saves a new set.
  const selected = [...config.surfaces];
  const owns = (surface: typeof selected[number]): boolean => has(selected, surface);
  if (owns("tool-cards")) {
    installDiff(pi);
    installRead(pi);
  }
  if (owns("editor")) installPromptPicker(pi);
  installExitCommand(pi);
  const sidebar = new Sidebar();
  const images = owns("editor") ? installImagePlaceholders(pi, owns("sidebar") ? sidebar : undefined, () => editorActive()) : undefined;
  const selection = new ComposerSelectionController();
  let fileSnapshot = "";
  const files = new GitStatusPoller((changes) => {
    fileSnapshot = changes.map((file) => `${file.index}${file.worktree}:${file.path}:${file.origPath ?? ""}`).join("\0");
    sidebar.setFiles(changes);
  });
  const diffs = new GitDiffPreviewLoader();
  const refreshFiles = (): void => {
    if (!owns("sidebar") || currentContext?.mode !== "tui") return;
    diffs.clear();
    void files.refresh();
  };
  const turnImpact = new TurnImpactTracker();
  let currentContext: ExtensionContext | undefined;
  let activeEditor: ComposerEditor | undefined;
  let gitBranch: string | null = null;
  let activeTui: TUI | undefined;
  let editorFactory: Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0];
  const editorActive = (): boolean => owns("editor") && currentContext?.mode === "tui"
    && (typeof currentContext.ui.getEditorComponent !== "function" || currentContext.ui.getEditorComponent() === editorFactory);
  let conversations: ReturnType<typeof installConversationBridge> | undefined;
  let messageWindow: MessageWindow | undefined;
  const tokenRate = new TokenRateTracker();
  const thinkingFold = new ThinkingFoldTracker({ onChange: () => syncThinkingStatus() });
  const updates = new UpdateWatcher();
  const branch = new GitBranchPoller(pi, (next) => { gitBranch = next; requestRender(); });
  let contextEdge = {
    tokens: formatFocusedContextTokens(null, null, null),
    resources: formatFocusedContextResources(null, 0, 0),
  };
  let requestRender = (_force = false) => {};

  const syncVisibleMessages = (): void => {
    if (!owns("transcript") || currentContext?.mode !== "tui") return;
    messageWindow = syncMessageWindow(messageWindow, activeTui, resolveMessageLength(config.messageLength));
  };

  const getContext = (): ExtensionContext => {
    if (!currentContext) throw new Error("pi-slate has not received a session context");
    return currentContext;
  };

  // A selected split allocates header width; unavailable sidebar hosts stay full-width.
  const columnWidth = (width: number): number => width;

  const syncSidebar = (ctx: ExtensionContext): void => {
    if (ctx.mode !== "tui" || (!owns("sidebar") && !owns("editor"))) return;
    let tokens: number | null;
    let percent: number | null;
    let spend: number;
    let contextWindow: number | null;
    try {
      const usage = ctx.getContextUsage();
      const resolved = resolveContextTokens(
        usage,
        ctx.sessionManager.buildContextEntries(),
        ctx.model?.contextWindow,
      );
      tokens = resolved.tokens;
      percent = resolved.percent;
      contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? null;
      spend = sessionSpend(ctx.sessionManager.getBranch());
    } catch {
      return;
    }
    const skills = countSkillCommands(pi.getCommands());
    const mcp = parseMcpEnabledCount({
      mcpServers: mergeMcpServerMaps(
        readOptionalJson(join(getAgentDir(), "mcp.json")),
        readOptionalJson(join(ctx.cwd, ".pi", "mcp.json")),
      ),
    });
    if (owns("sidebar")) {
      sidebar.setContext({ tokens, percent, tokensPerSec: tokenRate.rate(), spend });
      sidebar.setSkillsLoaded(skills);
      sidebar.setMcpConnected(mcp);
    }
    contextEdge = {
      tokens: formatFocusedContextTokens(percent, tokenRate.rate(), contextWindow),
      resources: formatFocusedContextResources(spend, skills, mcp),
    };
  };
  let disposeAsync: (() => void) | undefined;
  if (owns("sidebar")) {
    pi.on("resources_discover", () => {
      if (currentContext?.mode === "tui") queueMicrotask(() => sidebar.setSkillsLoaded(countSkillCommands(pi.getCommands())));
    });
  }

  const install = (ctx: ExtensionContext): void => {
    currentContext = ctx;
    conversations?.dispose();
    conversations = ctx.mode === "tui" && owns("editor") ? installConversationBridge(pi, {
      context: () => currentContext,
      editor: () => editorActive() ? activeEditor : undefined,
      tui: () => activeTui,
      canMount: () => owns("sidebar") && sidebar.splitActive && typeof (activeTui as TUI & { getFocusedComponent?: unknown })?.getFocusedComponent === "function",
      workspaceFocus: component => sidebar.ownsFocus(component),
      replaceChat: view => sidebar.replaceChat(view),
    }) : undefined;
    thinkingFold.stop();
    workingWord = undefined;
    if (loaded.error) ctx.ui.notify(loaded.error, "warning");
    if (ctx.mode !== "tui") return;
    if (owns("tool-cards")) {
      // Pi uses first registration per tool name. Report, never repair, a lost slot.
      try {
        const lost = pi.getAllTools().filter((tool) => ["edit", "write", "read"].includes(tool.name)
          && resolve(tool.sourceInfo.path) !== fileURLToPath(import.meta.url));
        if (lost.length) ctx.ui.notify(`Slate tool-cards unavailable for: ${lost.map((tool) => tool.name).join(", ")} (first registration wins)`, "warning");
      } catch { /* Older hosts cannot expose tool ownership. */ }
    }
    if (owns("editor")) branch.start(ctx.cwd);
    if (owns("editor") || owns("sidebar")) {
      tokenRate.setOnChange(() => {
        syncSidebar(getContext());
        if (thinkingFold.elapsedMs() !== null) syncThinkingStatus();
      });
      syncSidebar(ctx);
    }

    if (owns("sidebar")) {
      disposeAsync?.();
      disposeAsync = pi.events.on("subagent:async-complete", refreshFiles);
      files.start(ctx.cwd);
      diffs.clear();
      sidebar.setCwd(ctx.cwd);
      sidebar.setSelectedPreview(undefined);
      sidebar.setTurnImpact(turnImpact.restore(ctx.sessionManager.getBranch()));
      sidebar.setPreferredWidth(config.sidebarPercent);
      sidebar.setHidden(config.focused === true);
      sidebar.setActions({
        persistWidth: (percent) => {
          try {
            const next = withSidebarPercent(config, percent);
            saveConfig(next);
            config = next;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            ctx.ui.notify(`Could not save sidebar width: ${message}`, "error");
          }
        },
        copy: (text) => {
          void copyWithFeedback(activeTui, ctx.ui.notify, text);
        },
        openFile: (filePath) => {
          const target = resolve(ctx.cwd, filePath);
          const { command, args } = openExternalArgs(target);
          void Promise.resolve(pi.exec(command, args, { timeout: 5000 })).then(
            (result) => {
              if (result.code !== 0) ctx.ui.notify("Could not open file", "error");
            },
            () => ctx.ui.notify("Could not open file", "error"),
          );
        },
        selectFile: (file) => {
          const selectionId = fileKey(file);
          const title = formatFileLabel(file);
          const cached = diffs.peek(ctx.cwd, file, fileSnapshot);
          sidebar.setSelectedPreview(new DiffWorkspaceView(
            selectionId,
            cached?.state ?? "loading",
            cached?.text ?? "",
            ctx.ui.theme,
            title,
            file.path,
          ));
          void diffs.select(ctx.cwd, file, fileSnapshot, (result) => {
            sidebar.setSelectedPreview(new DiffWorkspaceView(
              selectionId,
              result.state,
              result.text,
              ctx.ui.theme,
              title,
              file.path,
            ));
          });
        },
      });
    }
    // belowEditor has no host leading spacer. This factory renders exactly zero rows.
    // It is a TUI handle, not a chrome owner or application bootstrap header.
    if (owns("sidebar") || owns("transcript")) {
      ctx.ui.setWidget("pi-slate:surface-host", (tui, theme) => {
        activeTui = tui;
        requestRender = (force = false) => tui.requestRender(force);
        if (owns("sidebar")) {
          sidebar.attach(tui, theme);
          if (!sidebar.splitActive && config.focused !== true) {
            ctx.ui.notify("Slate sidebar unavailable: a compatible fullscreen host is required", "warning");
          }
        }
        if (owns("transcript")) queueMicrotask(() => {
          syncVisibleMessages();
          if (!messageWindow) ctx.ui.notify("Slate transcript unavailable: a compatible message-window host is required", "warning");
        });
        return { render: () => [], invalidate() {} };
      }, { placement: "belowEditor" });
    }
    if (owns("header")) {
      updates.setOnChange(() => requestRender());
      updates.start(ctx.cwd);
      ctx.ui.setHeader((tui, theme) => {
        requestRender = (force = false) => tui.requestRender(force);
        return new SlateHeader(theme, getContext, columnWidth, () => updates.notice, VERSION, () => config.modelDisplay);
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
        activeEditor = new ComposerEditor(
          tui,
          minimalEditorTheme,
          keybindings,
          () => {
            const current = getContext();
            return {
              project: basename(current.cwd) || current.cwd,
              branch: gitBranch,
              model: current.model,
              modelDisplay: config.modelDisplay,
              thinking: current.thinkingLevel,
              footer: config.composerMetadata,
              showPid: config.showPid === true,
              theme: current.ui.theme,
              ...(config.focused !== false ? { context: contextEdge } : {}),
            };
          },
          {
            paddingX: composerPaddingX(config.density),
            autocompleteMaxVisible: 8,
            embedWorkingStatus: true,
          },
        );
        if (previousDown) activeEditor.onDownBoundary = previousDown;
        selection.attach(activeEditor, {
          copy: (text) => copyWithFeedback(tui, ctx.ui.notify, text),
          requestRender: () => tui.requestRender(),
        });
        images?.attachEditor(activeEditor);
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
  const syncThinkingStatus = (): void => {
    const ctx = currentContext;
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

  pi.on("session_start", (_event, ctx) => install(ctx));
  pi.on("agent_start", (_event, ctx) => {
    currentContext = ctx;
    if (!editorActive()) return;
    thinkingFold.stop();
    workingWord = workingWords.next();
    syncThinkingStatus();
  });
  pi.on("agent_end", (_event, ctx) => {
    currentContext = ctx;
    thinkingFold.stop();
  });
  pi.on("model_select", (_event, ctx) => {
    currentContext = ctx;
    syncSidebar(ctx);
  });
  pi.on("thinking_level_select", (_event, ctx) => {
    currentContext = ctx;
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
    }
    syncSidebar(ctx);
    syncVisibleMessages();
  });
  if (owns("sidebar")) {
    pi.on("before_agent_start", (_event, ctx) => {
      if (ctx.mode !== "tui") return;
      // Last Turn is the last user prompt, not each LLM round inside it.
      sidebar.setTurnImpact(turnImpact.reset());
    });
    pi.on("tool_call", (event, ctx) => {
      if (ctx.mode !== "tui") return;
      sidebar.setTurnImpact(turnImpact.toolCall({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input as Record<string, unknown> | undefined,
      }));
    });
    pi.on("tool_execution_end", (event, ctx) => {
      if (ctx.mode !== "tui") return;
      sidebar.setTurnImpact(turnImpact.toolEnd({
        toolCallId: event.toolCallId,
        isError: event.isError,
        result: event.result,
        toolName: event.toolName,
      }));
      refreshFiles();
    });
  }
  pi.on("turn_end", (_event, ctx) => {
    currentContext = ctx;
    syncSidebar(ctx);
    refreshFiles();
  });
  pi.on("agent_settled", (_event, ctx) => {
    currentContext = ctx;
    syncSidebar(ctx);
    refreshFiles();
  });
  pi.on("session_compact", (_event, ctx) => {
    currentContext = ctx;
    syncSidebar(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    currentContext = ctx;
    thinkingFold.stop();
    if (owns("sidebar") && ctx.mode === "tui") sidebar.setTurnImpact(turnImpact.restore(ctx.sessionManager.getBranch()));
    syncVisibleMessages();
  });
  pi.on("session_shutdown", (_event, ctx) => {
    workingWord = undefined;
    thinkingFold.stop();
    tokenRate.dispose();
    images?.dispose();
    selection.dispose();
    files.dispose();
    disposeAsync?.();
    disposeAsync = undefined;
    branch.dispose();
    updates.dispose();
    diffs.clear();
    messageWindow?.dispose();
    messageWindow = undefined;
    conversations?.dispose();
    conversations = undefined;
    activeTui = undefined;
    sidebar.dispose();
    requestRender(true);
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
      if (owns("sidebar")) {
        sidebar.setPreferredWidth(config.sidebarPercent);
        sidebar.setHidden(config.focused === true);
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

  const applyNamedTheme = (ctx: ExtensionContext, name: string, message: string): void => {
    const result = ctx.ui.setTheme(name);
    if (!result.success) {
      ctx.ui.notify(result.error ?? `Could not load ${name}. Run /reload first.`, "error");
      return;
    }
    persistTheme(ctx.cwd, name);
    requestRender(true);
    ctx.ui.notify(message, "info");
  };

  const applyCatppuccin = (ctx: ExtensionContext, flavor: Flavor, style: Style): void => {
    const next = resolveCatppuccinTheme(ctx.ui.theme.name, flavor, style);
    applyNamedTheme(ctx, next.name, themeMessage(next.flavor, next.style));
  };

  const pickTheme = async (ctx: ExtensionContext): Promise<void> => {
    const mocha = currentCatppuccin(ctx).style;
    const value = await ctx.ui.select("Theme", [
      ...STYLES.map((style) => withCurrent(STYLE_LABELS[style], style === mocha)),
    ]);
    if (!value) return;
    const key = withoutCurrent(value);
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

  const fileBug = async (ctx: ExtensionContext): Promise<void> => {
    const title = (await ctx.ui.input("Issue title", "Short summary"))?.trim();
    if (!title) return;
    const body = await ctx.ui.editor(
      "Issue details",
      issueTemplate({
        slateVersion: SLATE_VERSION,
        piVersion: VERSION,
        platform: `${process.platform} ${process.arch}`,
      }),
    );
    if (body === undefined) return;
    try {
      await copyToClipboard(formatBugReport(title, body));
      ctx.ui.notify("Bug report copied to clipboard", "info");
    } catch {
      ctx.ui.notify("Could not copy bug report", "error");
    }
  };

  const handleBug = async (ctx: ExtensionContext, action?: "file" | "open"): Promise<void> => {
    let next = action;
    if (!next) {
      const choice = await ctx.ui.select("Slate bug", ["Copy a bug report", "Open package page"]);
      if (choice === "Copy a bug report") next = "file";
      else if (choice === "Open package page") next = "open";
      else return;
    }
    if (next === "open") {
      const opened = await openUrl(SLATE_ISSUES_URL);
      ctx.ui.notify(opened ? "Opened pi-slate on npm" : `Open ${SLATE_ISSUES_URL}`, opened ? "info" : "error");
      return;
    }
    await fileBug(ctx);
  };

  const applyFocused = (ctx: ExtensionContext, value?: boolean): void => {
    const on = value ?? !config.focused;
    apply({ ...config, focused: on }, on ? "Focused mode on" : "Focused mode off", ctx);
  };

  pi.registerCommand("slate", {
    description: "Surfaces, density, composer metadata, sidebar, focused mode, PID display, message length, theme, or file a bug",
    getArgumentCompletions: slateArgumentCompletions,
    handler: async (args, ctx) => {
      const parsed = parseSlateArgs(args);
      if (!parsed.ok) {
        ctx.ui.notify(SLATE_USAGE, "error");
        return;
      }

      let kind = parsed.kind;
      if (kind === "menu") {
        const setting = await ctx.ui.select("Slate", ["Surfaces", "Density", "Composer metadata", "Sidebar width", "Focused", "PID display", "Message length", "Theme", "File a bug"]);
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
        else if (setting === "Message length") kind = "message-length-menu";
        else if (setting === "Theme") kind = "theme-menu";
        else if (setting === "File a bug") kind = "bug-menu";
        else return;
      }

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

      if (kind === "focused") {
        applyFocused(ctx, parsed.kind === "focused" ? parsed.value : undefined);
        return;
      }

      if (kind === "pid") {
        const on = parsed.kind === "pid" && parsed.value !== undefined ? parsed.value : !config.showPid;
        apply({ ...config, showPid: on }, on ? "PID display on" : "PID display off", ctx);
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
