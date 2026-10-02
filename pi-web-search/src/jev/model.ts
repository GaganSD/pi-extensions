import type { ClassifierApi, ClassifierModel } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type ModelRegistry = ExtensionContext["modelRegistry"];

export type JevBackend = "typesafe" | "vercel";
export type JevBackendSetting = "auto" | JevBackend;

/** Former direct-API default, retained as a compatibility alias. */
export const JEV_LEGACY_MODEL = "jev-1.13.0";
export const JEV_NATIVE_MODEL = "jev-latest";
export const JEV_VERCEL_MODEL = "typesafe-ai/jev";

/** The catalog uses a different ID and provider name for each backend. */
const PROVIDERS = { typesafe: "typesafe", vercel: "vercel-ai-gateway" } as const;

export interface JevModelOptions {
	backend?: JevBackendSetting;
	model?: string;
}

/**
 * Auto maps the current Jev default (and legacy alias) to TypeSafe, then Vercel.
 * Other catalog IDs are exact; an explicit backend never changes providers.
 * Pi, not the package, decides availability and resolves authentication.
 */
export async function selectJevModel(
	registry: ModelRegistry,
	options: JevModelOptions,
	signal?: AbortSignal,
): Promise<ClassifierModel<ClassifierApi> | undefined> {
	const requested = options.model?.trim() || JEV_NATIVE_MODEL;
	const defaultModel = requested === JEV_NATIVE_MODEL || requested === JEV_LEGACY_MODEL;
	const backend = options.backend ?? "auto";
	const order: JevBackend[] = backend === "auto"
		? defaultModel
			? ["typesafe", "vercel"]
			: requested === JEV_VERCEL_MODEL ? ["vercel"] : ["typesafe"]
		: [backend];
	for (const candidate of order) {
		const id = defaultModel
			? candidate === "typesafe" ? JEV_NATIVE_MODEL : JEV_VERCEL_MODEL
			: requested;
		const provider = PROVIDERS[candidate];
		const model = registry.findOfType("classifier", provider, id);
		if (!model) continue;
		const available = await registry.getAvailableOfType("classifier", provider, { signal });
		if (available.some((entry) => entry.provider === provider && entry.id === id)) {
			return model;
		}
	}
	return undefined;
}

/** User-facing diagnostic; never exposes credentials or falls back to an arbitrary model. */
export function jevUnavailableMessage(options: JevModelOptions): string {
	const backend = options.backend ?? "auto";
	const id = options.model?.trim() || JEV_NATIVE_MODEL;
	return `jev judging unavailable: Pi has no available classifier for jev.backend=${backend}, jev.model=${id}. Check the Pi classifier model catalog and configure TYPESAFE_API_KEY or AI_GATEWAY_API_KEY (or Pi stored/runtime/model auth).`;
}
