import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	ASK_TOOL_DESCRIPTION,
	ASK_TOOL_PROMPT_GUIDELINES,
	invalidPayloadResponse,
	nonInteractiveResponse,
	renderAskToolCall,
	renderAskToolResult,
	successfulResponse,
	validateParams,
} from "./ask-tool-helpers.ts";
import { AskParamsSchema } from "./schema.ts";
import { prepareAskParams } from "./state/normalize.ts";
import type { AskParams } from "./types.ts";
import { runAskFlow } from "./ui/controller.ts";

export function registerAskTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description: ASK_TOOL_DESCRIPTION,
		promptSnippet:
			"Interview the user to clarify gaps in context or requirements, get missing authorization, or brainstorm",
		promptGuidelines: [...ASK_TOOL_PROMPT_GUIDELINES],
		parameters: AskParamsSchema,
		prepareArguments: (args) => prepareAskParams(args) as AskParams,
		execute: (_toolCallId, params, _signal, _onUpdate, ctx) =>
			executeAskTool(params as AskParams, ctx),
		renderCall: renderAskToolCall,
		renderResult: renderAskToolResult,
	});
}

async function executeAskTool(params: AskParams, ctx: ExtensionContext) {
	const validation = validateParams(params);
	if (!validation.ok) {
		return invalidPayloadResponse(params, validation.issues);
	}
	if (ctx.mode !== "tui") {
		return nonInteractiveResponse(validation.state);
	}
	ctx.ui.setWorkingVisible(false);
	try {
		const result = await runAskFlow(ctx, params);
		return successfulResponse(result);
	} finally {
		ctx.ui.setWorkingVisible(true);
	}
}
