import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JudgeAnswer, JevResponse } from "../../src/jev/api.ts";

type Registry = ExtensionContext["modelRegistry"];
const model = { provider: "typesafe", id: "jev-latest" };

/** Adapt legacy policy specimens to Pi's typed classifier boundary, without HTTP/auth mocks. */
export function classifierRegistry(response: JevResponse | (() => Promise<never>)): Registry {
	return {
		findOfType: () => model,
		getAvailableOfType: async () => [model],
		classify: async (_model: unknown, context: { questions: Record<string, { type: string; criteria?: Record<string, string> }> }) => {
			if (typeof response === "function") return response();
			// Legacy policy specimens specified only the judgments relevant to each assertion.
			// Native Pi requires a typed answer for every question in the batch.
			const answers = Object.fromEntries(Object.entries(context.questions).map(([id, question]) => {
				const answer: JudgeAnswer | undefined = response.answers[id];
				return [id, answer ?? (question.type === "bool"
					? { type: "bool", probability: 0.9 }
					: { type: "choice", choice: "safe", probabilities: { safe: 0.99 }, confidence: 0.99 })];
			}));
			return { stopReason: "stop", answers, usage: response.usage };
		},
	} as unknown as Registry;
}
