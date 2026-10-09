import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Isolated read-only host adapter. Never imports the MCP client or resolves credentials. */
export type SidebarMcpHost = {
  validate(name: string, value: unknown): unknown;
  namespace(name: string): string;
  projectOverrides: boolean;
};

export async function loadSidebarMcpHost(packageDir: string, version: string): Promise<SidebarMcpHost | undefined> {
  try {
    // Modern semantics are checked against the running native file parser.
    // 1.1.0 retains 1.0.4 overrides/namespaces; unknown formats still fail closed.
    const patch = /^1\.0\.(\d+)$/.exec(version);
    const modern = version === "1.1.0" || (patch !== null && Number(patch[1]) >= 4);
    const legacy = version === "0.99.0" || version === "1.0.0";
    if (!legacy && !modern) return undefined;
    const native = await import(pathToFileURL(join(packageDir, "dist/core/mcp-servers.js")).href) as {
      validateMcpServerConfig?: SidebarMcpHost["validate"];
      mcpNamespace?: SidebarMcpHost["namespace"];
    };
    if (typeof native.validateMcpServerConfig !== "function") return undefined;
    const projectOverrides = !legacy;
    if (projectOverrides && typeof native.mcpNamespace !== "function") return undefined;
    return { validate: native.validateMcpServerConfig,
      namespace: projectOverrides ? native.mcpNamespace! : name => name, projectOverrides };
  } catch { return undefined; }
}
