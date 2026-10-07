import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  DynamicBorder,
  getSelectListTheme,
  parseFrontmatter,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Input,
  matchesKey,
  type SelectItem,
  SelectList,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";

type Prompt = {
  id: string;
  name?: string;
  description?: string;
  content: string;
};

const pickString = (value: unknown): string | undefined => {
  const text = typeof value === "string" ? value.trim() : undefined;
  return text || undefined;
};

const parsePrompt = (id: string, source: string): Prompt => {
  const { frontmatter, body } = parseFrontmatter(source);

  return {
    id,
    name: pickString(frontmatter.name),
    description: pickString(frontmatter.description),
    content: body,
  };
};

const loadPrompt =
  (read: typeof readFile) =>
  async (path: string): Promise<Prompt> => {
    const id = basename(path, ".md").replace(/^prompt:/, "");
    const source = await read(path, "utf8");

    return parsePrompt(id, source);
  };

const loadPrompts = async (pi: ExtensionAPI): Promise<Prompt[]> => {
  const paths = pi
    .getCommands()
    .filter((command) => command.source === ("prompt" as const))
    .map((command) => command.sourceInfo.path);

  const settled = await Promise.allSettled(paths.map((path) => loadPrompt(readFile)(path)));

  return settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
};

const filterPrompts = (prompts: Prompt[]) => (query: string) => {
  const searchText = query.trim().toLowerCase();

  return prompts.filter((prompt) =>
    [prompt.id, prompt.name, prompt.description, prompt.content].some((field) =>
      field?.toLowerCase().includes(searchText),
    ),
  );
};

const queryPrompts = (prompts: Prompt[]) => (query: string) =>
  filterPrompts(prompts)(query).map((prompt) => ({
    label: prompt.name?.trim() || prompt.id,
    description: prompt.description,
    value: prompt.content,
  }));

const isListKey = (data: string): boolean =>
  matchesKey(data, "up") ||
  matchesKey(data, "down") ||
  matchesKey(data, "return") ||
  matchesKey(data, "escape");

const buildList = (items: SelectItem[]): SelectList => {
  items = items.sort((left, right) =>
    left.label.localeCompare(right.label, undefined, {
      numeric: true,
      sensitivity: "base",
    }),
  );

  return new SelectList(
    items,
    5, // maxVisible
    getSelectListTheme(),
  );
};

const buildContainer = (theme: Theme) => (search: Input, list: SelectList) => {
  const panel = new Container();

  panel.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
  panel.addChild(new Text(theme.bold("Prompts"), 1, 0));

  panel.addChild(search);
  panel.addChild(new Spacer(1));
  panel.addChild(list);
  panel.addChild(new Spacer(1));

  panel.addChild(new Text("↑↓ choose · Enter insert · Esc close", 1, 0));
  panel.addChild(new DynamicBorder((text) => theme.fg("accent", text)));

  return panel;
};

const openPromptsOverlay =
  (prompts: Prompt[]) =>
  async (ctx: ExtensionContext): Promise<void> => {
    const selected = await ctx.ui.custom<string | undefined>(
      (tui, theme, _keybindings, done) => {
        const search = new Input();
        search.onEscape = () => done(undefined);

        let list = buildList(queryPrompts(prompts)(""));
        let panel = buildContainer(theme)(search, list);

        list.onSelect = (item) => done(item.value);
        list.onCancel = () => done(undefined);

        const render = (width: number) => panel.render(width);
        const invalidate = () => panel.invalidate();

        const handleSearch = (data: string) => {
          const prevQuery = search.getValue();
          search.handleInput(data);

          if (search.getValue() !== prevQuery) {
            list = buildList(queryPrompts(prompts)(search.getValue()));
            search.onEscape = () => done(undefined);
            list.onSelect = (item) => done(item.value);
            list.onCancel = () => done(undefined);

            panel = buildContainer(theme)(search, list);
          }
        };

        const handleInput = (data: string) => {
          if (isListKey(data)) {
            list.handleInput(data);
          } else {
            handleSearch(data);
          }
          tui.requestRender();
        };

        return {
          render,
          invalidate,
          handleInput,

          get focused() {
            return search.focused;
          },
          set focused(value: boolean) {
            search.focused = value;
          },
        };
      },
      { overlay: true, overlayOptions: { width: 60 } },
    );

    if (selected !== undefined) {
      ctx.ui.pasteToEditor(selected);
    }
  };

export const installPromptPicker = (pi: ExtensionAPI): void => {
  const handler = async (ctx: ExtensionContext): Promise<void> => {
    await openPromptsOverlay(await loadPrompts(pi))(ctx);
  };

  pi.registerCommand("prompts", {
    description: "Pick a prompt",
    handler: async (_args, ctx) => handler(ctx),
  });

  pi.registerShortcut("ctrl+shift+p", {
    description: "Pick a prompt",
    handler,
  });
};
