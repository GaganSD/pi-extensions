import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export const AskOptionSchema = Type.Object({
	value: Type.String({
		description:
			"Required machine-readable value returned for this option in the result",
	}),
	label: Type.String({
		description: "Required short visible option label shown in the list",
	}),
	description: Type.Optional(
		Type.String({
			description: "Optional one-line explanation to help the user choose",
		})
	),
	recommended: Type.Optional(
		Type.Boolean({
			description:
				"Optional presentation marker for a grounded preference; use the description to explain the reason",
		})
	),
});

export const AskQuestionSchema = Type.Object({
	id: Type.String({
		description:
			"Required stable question identifier used as the key in returned answers",
	}),
	label: Type.Optional(
		Type.String({
			description: "Short tab label, e.g. Goal, Audience, Tone, Scope",
		})
	),
	prompt: Type.String({
		description:
			"Required direct question shown to the user; ask about one decision at a time",
	}),
	type: Type.Optional(
		StringEnum(["single", "multi", "text"] as const, {
			description:
				"Question type: `single` means one answer is expected, `multi` means multiple answers could reasonably be selected, and `text` means the user should type an unconstrained answer. `text` questions have no options.",
		})
	),
	options: Type.Optional(
		Type.Array(AskOptionSchema, {
			description:
				"Answer options for single/multi questions; provide clear, distinct choices and do not add filler options. Omit for text questions.",
		})
	),
});

export const AskParamsSchema = Type.Object({
	title: Type.Optional(
		Type.String({
			description:
				"Optional short title shown above the clarification flow, e.g. README direction",
		})
	),
	questions: Type.Array(AskQuestionSchema, {
		description: "Questions to ask in the interactive clarification flow",
	}),
});

const AnswerExtractionQuestionSchema = Type.Object({
	id: Type.String({ description: "Stable snake_case question identifier" }),
	label: AskQuestionSchema.properties.label,
	prompt: Type.String({ description: "Direct question shown to the user" }),
	type: AskQuestionSchema.properties.type,
	options: Type.Optional(
		Type.Array(AskOptionSchema, {
			description:
				"Choices explicitly offered by the assistant. Omit for text questions.",
		})
	),
});

export const AnswerExtractionParamsSchema = Type.Object({
	...AskParamsSchema.properties,
	questions: Type.Array(AnswerExtractionQuestionSchema, {
		description: "Questions extracted from the assistant message",
	}),
});
