import type { AskParams } from "../types.ts";
import { normalizeQuestions } from "./normalize.ts";
import { createInitialState as createBaseState } from "./transitions.ts";

export function createInitialState(params: AskParams) {
	return createBaseState({
		title: params.title?.trim() || undefined,
		questions: normalizeQuestions(params),
	});
}
