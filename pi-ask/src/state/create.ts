import type { AskParams, AskState } from "../types.ts";
import { normalizeQuestions } from "./normalize.ts";
import { navigateView } from "./view.ts";

export function createInitialState(params: AskParams): AskState {
	return {
		title: params.title?.trim() || undefined,
		questions: normalizeQuestions(params),
		activeTabIndex: 0,
		activeOptionIndex: 0,
		activeSubmitActionIndex: 0,
		view: navigateView(),
		answers: {},
		completed: false,
		cancelled: false,
	};
}
