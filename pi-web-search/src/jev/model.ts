import type { ClassifierApi, ClassifierModel } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type ModelRegistry = ExtensionContext["modelRegistry"];

export const JEV_BACKENDS = ["typesafe", "vercel", "openrouter"] as const;
export type JevBackend = (typeof JEV_BACKENDS)[number];
/** Compatibility setting: auto uses TypeSafe only, never a paid gateway fallback. */
export type JevBackendSetting = "auto" | JevBackend;

/** Former direct-API default, retained as a compatibility alias. */
export const JEV_LEGACY_MODEL = "jev-1.13.0";
export const JEV_NATIVE_MODEL = "jev-latest";
export const JEV_VERCEL_MODEL = "typesafe-ai/jev";
export const JEV_OPENROUTER_MODEL = "~typesafe/jev-latest";

const PROVIDERS = { typesafe: "typesafe", vercel: "vercel-ai-gateway", openrouter: "openrouter" } as const;
const DEFAULT_MODELS = { typesafe: JEV_NATIVE_MODEL, vercel: JEV_VERCEL_MODEL, openrouter: JEV_OPENROUTER_MODEL } as const;

export interface JevModelOptions {
	backend?: JevBackendSetting;
	model?: string;
}

export function isJevBackend(value: unknown): value is JevBackend {
	return JEV_BACKENDS.some((backend) => backend === value);
}

/** Resolve one explicitly selected provider; credentials and execution stay in Pi. */
export function resolveJevTarget(options: JevModelOptions) {
	const backend = options.backend === undefined || options.backend === "auto" ? "typesafe" : options.backend;
	const requested = options.model?.trim() || JEV_NATIVE_MODEL;
	return {
		provider: PROVIDERS[backend],
		model: requested === JEV_NATIVE_MODEL || requested === JEV_LEGACY_MODEL ? DEFAULT_MODELS[backend] : requested,
	};
}

/** No cross-provider fallback: missing auth or model leaves retrieved evidence unjudged. */
export async function selectJevModel(
	registry: ModelRegistry,
	options: JevModelOptions,
	signal?: AbortSignal,
): Promise<ClassifierModel<ClassifierApi> | undefined> {
	const target = resolveJevTarget(options);
	const model = registry.findOfType("classifier", target.provider, target.model);
	if (!model) return undefined;
	const available = await registry.getAvailableOfType("classifier", target.provider, { signal });
	return available.some((entry) => entry.provider === target.provider && entry.id === target.model) ? model : undefined;
}

/** User-facing diagnostic; never resolves or exposes a key. */
export function jevUnavailableMessage(options: JevModelOptions): string {
	const target = resolveJevTarget(options);
	return `jev judging unavailable: Pi has no available classifier for ${target.provider}/${target.model}. Run /login ${target.provider} if needed; existing Pi authentication is reused. Check /web-search-settings or select a provider with /web-search-settings typesafe|vercel|openrouter. No other classifier provider is tried.`;
}
