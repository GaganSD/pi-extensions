// The release allowlist and CI test partition. New publishable packages belong here.
export const packages = {
  "pi-ask": {
    name: "@gagansd/pi-ask", tests: "tests",
    integration: ["contract.test.ts", "ask-tool.test.ts", "answer-commands.test.ts", "config-store.test.ts"],
    commands: ["answer", "ask-settings"], tools: ["ask_user"],
  },
  "pi-slate": {
    name: "pi-slate", tests: "tests",
    integration: ["install-defaults.test.ts", "sidebar-split.test.ts", "diff-tools.test.ts", "read.test.ts", "git-diff.test.ts", "package.test.mjs", "prompts.test.ts"],
    commands: ["slate", "prompts"], tools: [],
  },
  "pi-subagents": {
    name: "@gagansd/pi-subagents", tests: "test",
    integration: ["integration.test.ts", "extension.test.ts", "extension-native.test.ts", "native.test.ts", "package.test.ts"],
    commands: ["subagents"], tools: ["subagent"],
  },
  "pi-web-search": {
    name: "@gagansd/pi-web-search", tests: "tests",
    integration: ["integration.test.ts", "registration.test.ts", "native-sdk.test.ts", "package/package-content.test.ts", "package/validation.test.ts"],
    commands: ["web-search-settings"], tools: ["web_search", "code_search"],
  },
};

export function packageConfig(path) {
  if (!Object.hasOwn(packages, path)) throw new Error(`Unknown package: ${path}`);
  return packages[path];
}
