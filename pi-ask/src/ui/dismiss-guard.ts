import type { AskConfig } from "../config/schema.ts";
import type { AskState } from "../types.ts";

export const DIRTY_DISMISS_NOTICE =
	"Answers kept. Press Esc again to discard and close.";

export function shouldConfirmDirtyDismiss(args: {
	config: AskConfig;
	state: AskState;
	editingText?: string;
}): boolean {
	if (!args.config.behaviour.confirmDismissWhenDirty) {
		return false;
	}
	return hasDirtyFlowState(args.state, args.editingText ?? "");
}

export function hasDirtyFlowState(state: AskState, editingText = ""): boolean {
	return Object.keys(state.answers).length > 0 || editingText.length > 0;
}

export function shouldDiscardAfterConfirmation(
	confirmationPending: boolean
): boolean {
	return confirmationPending;
}
