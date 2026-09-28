import {
	CANCELLED_RESULT_TEXT,
	SUBMITTED_RESULT_TEXT,
} from "./constants/text.ts";
import { formatResultLines } from "./result-format.ts";
import type { AskResult } from "./types.ts";

export function renderResultText(result: AskResult): string {
	if (result.status === "invalid" || result.error) {
		return "Invalid tool payload";
	}
	if (result.status === "cancelled") {
		return CANCELLED_RESULT_TEXT;
	}
	if (result.status === "unavailable") {
		return "Needs user input";
	}

	const lines = formatResultLines(result, { mode: "render" });
	return lines.join("\n") || SUBMITTED_RESULT_TEXT;
}
