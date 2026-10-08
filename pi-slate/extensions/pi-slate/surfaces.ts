export const SURFACES = ["header", "footer", "editor", "sidebar", "tool-cards", "transcript"] as const;
export type Surface = typeof SURFACES[number];
export const SURFACE_CONFIG_VERSION = 1;
export const FRESH_SURFACES: readonly Surface[] = ["editor", "sidebar", "tool-cards"];

export function parseSurfaces(value: unknown): Surface[] | undefined {
  if (!Array.isArray(value) || value.some((name) => !SURFACES.includes(name as Surface))) return undefined;
  return SURFACES.filter((name) => value.includes(name));
}

export function has(surfaces: readonly Surface[], surface: Surface): boolean {
  return surfaces.includes(surface);
}

export function formatSurfaces(surfaces: readonly Surface[]): string {
  return surfaces.length ? surfaces.join(" ") : "none";
}

export type SurfaceConfig = {
  version: typeof SURFACE_CONFIG_VERSION;
  surfaces: Surface[];
  composerMetadata: "standard" | "minimal";
};

export type ParsedSurfaceConfig =
  | { ok: true; value: Record<string, unknown> & SurfaceConfig; migrated: boolean }
  | { ok: false; value: SurfaceConfig; error: string };

/** Undefined means ENOENT, not an unreadable or malformed existing file. */
export function parseSurfaceConfig(text: string | undefined): ParsedSurfaceConfig {
  const base: SurfaceConfig = { version: SURFACE_CONFIG_VERSION, surfaces: [], composerMetadata: "standard" };
  if (text === undefined) {
    return { ok: true, value: { ...base, surfaces: [...FRESH_SURFACES], focused: true }, migrated: false };
  }
  try {
    const raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("expected a settings object");
    const value = raw as Record<string, unknown>;
    if (value.version !== undefined && value.version !== SURFACE_CONFIG_VERSION) throw new Error("unsupported version");
    const surfaces = value.surfaces === undefined ? [...SURFACES] : parseSurfaces(value.surfaces);
    if (!surfaces) throw new Error("unknown surface or invalid surfaces array");
    const metadata = value.composerMetadata ?? value.footer;
    return {
      ok: true,
      migrated: value.surfaces === undefined,
      value: { ...value, version: SURFACE_CONFIG_VERSION, surfaces, composerMetadata: metadata === "minimal" ? "minimal" : "standard" },
    };
  } catch (error) {
    return { ok: false, value: base, error: `Slate surfaces unavailable: ${error instanceof Error ? error.message : String(error)}. Settings file preserved; repair pi-slate.json and /reload.` };
  }
}
