import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAnswerCommands } from "./answer-commands.ts";
import { registerAskSettingsCommand } from "./ask-settings-command.ts";
import { registerAskTool } from "./ask-tool.ts";
import { resetAskConfigStore } from "./config/store.ts";

export default function askExtension(pi: ExtensionAPI) {
	resetAskConfigStore();
	registerAskTool(pi);
	registerAskSettingsCommand(pi);
	registerAnswerCommands(pi);
}
