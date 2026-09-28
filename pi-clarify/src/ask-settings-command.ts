import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { showAskSettings } from "./ui/show-settings.ts";

export function registerAskSettingsCommand(pi: ExtensionAPI) {
	pi.registerCommand("clarify-settings", {
		description: "Open clarify settings",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await showAskSettings(ctx);
		},
	});
}
