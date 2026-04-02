/**
 * Structured question tool for gathering user input.
 *
 * Provides a structured way to ask users questions with predefined options,
 * improving UX over free-form text input.
 */

import { type Static, Type } from "@sinclair/typebox";
import { createTool } from "./tool-dsl.js";

export const questionOptionSchema = Type.Object({
	label: Type.String({
		description:
			"The display text for this option (1-5 words). Should clearly describe the choice.",
		minLength: 1,
		maxLength: 50,
	}),
	description: Type.String({
		description:
			"Explanation of what this option means or what will happen if chosen.",
		minLength: 1,
		maxLength: 200,
	}),
});

export const questionSchema = Type.Object({
	question: Type.String({
		description:
			'The complete question to ask. Should be clear, specific, and end with a question mark. E.g., "Which library should we use for date formatting?"',
		minLength: 5,
		maxLength: 500,
	}),
	header: Type.String({
		description:
			'Short label displayed as a chip/tag (max 12 chars). E.g., "Auth method", "Library", "Approach".',
		minLength: 1,
		maxLength: 12,
	}),
	options: Type.Array(questionOptionSchema, {
		description:
			"Available choices (2-4 options). Each should be distinct. An 'Other' option is automatically added.",
		minItems: 2,
		maxItems: 4,
	}),
	multiSelect: Type.Optional(
		Type.Boolean({
			description:
				"Allow selecting multiple options. Use when choices are not mutually exclusive.",
			default: false,
		}),
	),
});

export const askUserSchema = Type.Object({
	questions: Type.Array(questionSchema, {
		description: "Questions to ask the user (1-4 questions)",
		minItems: 1,
		maxItems: 4,
	}),
});

export type QuestionOption = Static<typeof questionOptionSchema>;
export type Question = Static<typeof questionSchema>;
export type AskUserInput = Static<typeof askUserSchema>;

export interface AskUserResult {
	/** Whether the user provided answers */
	answered: boolean;
	/** Map of question index to selected option(s) */
	answers: Map<number, string | string[]>;
	/** Raw answer data */
	rawAnswers: Record<string, string>;
}

type AskUserDetails = {
	questions: Question[];
	status: "pending" | "answered" | "cancelled";
};

/**
 * Format questions for display when the tool is invoked.
 */
export function formatQuestionsForDisplay(questions: Question[]): string {
	const lines: string[] = [];

	for (const [index, q] of questions.entries()) {
		lines.push(`**[${q.header}]** ${q.question}`);
		for (const [optIndex, opt] of q.options.entries()) {
			const marker = q.multiSelect ? "☐" : "○";
			lines.push(
				`  ${marker} ${optIndex + 1}. **${opt.label}**: ${opt.description}`,
			);
		}
		lines.push(
			`  ${q.multiSelect ? "☐" : "○"} ${q.options.length + 1}. **Other**: Provide custom answer`,
		);
		if (index < questions.length - 1) {
			lines.push("");
		}
	}

	return lines.join("\n");
}

/**
 * Parse user response to questions.
 * Supports formats like:
 * - "1" (single selection)
 * - "1, 3" (multi-select)
 * - "Option A" (label match)
 * - Free text (for "Other")
 */
export function parseUserResponse(
	response: string,
	question: Question,
): string | string[] {
	const trimmed = response.trim();

	// Check if it's a number or comma-separated numbers
	const numbers = trimmed
		.split(/[,\s]+/)
		.map((s) => Number.parseInt(s.trim(), 10));
	const allValidNumbers = numbers.every((n) => !Number.isNaN(n));

	if (allValidNumbers && numbers.length > 0) {
		const selected = numbers
			.filter((n) => n >= 1 && n <= question.options.length + 1)
			.map((n) => {
				if (n === question.options.length + 1) {
					return "Other";
				}
				return question.options[n - 1]?.label || `Option ${n}`;
			});

		return question.multiSelect ? selected : selected[0] || trimmed;
	}

	// Check if it matches an option label
	const matchedOption = question.options.find(
		(opt) => opt.label.toLowerCase() === trimmed.toLowerCase(),
	);
	if (matchedOption) {
		return matchedOption.label;
	}

	// Return as free-form answer
	return trimmed;
}

export const askUserTool = createTool<typeof askUserSchema, AskUserDetails>({
	name: "ask_user",
	label: "ask",
	description: `Ask the user structured questions with predefined options.

Use this tool when you need to:
- Gather user preferences or requirements
- Clarify ambiguous instructions
- Get decisions on implementation choices
- Offer choices about direction to take

Parameters:
- questions: Array of 1-4 questions, each with:
  - question: The full question text
  - header: Short label (max 12 chars) like "Library", "Approach"
  - options: 2-4 choices with label and description
  - multiSelect: Allow multiple selections (default: false)

An "Other" option is automatically added to allow custom input.
Users can respond with option numbers, labels, or free text.`,
	schema: askUserSchema,

	// This tool requires special handling - the TUI will intercept it
	// and display a proper selection UI rather than executing directly
	deferApiDefinition: true,

	async run({ questions }, { respond }) {
		// Format the questions for display
		// In practice, this tool should be intercepted by the UI layer
		// before reaching here, but we provide a fallback text format

		const formatted = formatQuestionsForDisplay(questions);

		return respond
			.text(
				`Please answer the following question(s):\n\n${formatted}\n\nReply with option numbers (e.g., '1' or '1, 3' for multi-select), option labels, or your own answer for 'Other'.`,
			)
			.detail({
				questions,
				status: "pending",
			});
	},
});

/**
 * Check if a tool call is an ask_user call.
 */
export function isAskUserCall(
	toolName: string,
	_args: Record<string, unknown>,
): boolean {
	return toolName === "ask_user";
}

/**
 * Extract questions from an ask_user tool call.
 */
export function extractQuestions(args: Record<string, unknown>): Question[] {
	const input = args as AskUserInput;
	return input.questions || [];
}
