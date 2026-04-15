import { describe, expect, it } from "vitest";
import type { AgentToolResult } from "../../src/agent/types.js";
import {
	type Question,
	askUserTool,
	extractQuestions,
	formatQuestionsForDisplay,
	isAskUserCall,
	parseUserResponse,
} from "../../src/tools/ask-user.js";

// Helper to extract text from content blocks
function getTextOutput(result: AgentToolResult<unknown>): string {
	return (
		result.content
			?.filter((c): c is { type: "text"; text: string } => {
				return (
					c != null && typeof c === "object" && "type" in c && c.type === "text"
				);
			})
			.map((c) => c.text)
			.join("\n") || ""
	);
}

describe("ask-user tool", () => {
	describe("basic execution", () => {
		it("formats a single question", async () => {
			const result = await askUserTool.execute("ask-1", {
				questions: [
					{
						question: "Which database should we use?",
						header: "Database",
						options: [
							{ label: "PostgreSQL", description: "Relational database" },
							{ label: "MongoDB", description: "Document database" },
						],
					},
				],
			});

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("Database");
			expect(output).toContain("Which database should we use?");
			expect(output).toContain("PostgreSQL");
			expect(output).toContain("MongoDB");
		});

		it("formats multiple questions", async () => {
			const result = await askUserTool.execute("ask-2", {
				questions: [
					{
						question: "Which framework?",
						header: "Framework",
						options: [
							{ label: "React", description: "Popular UI library" },
							{ label: "Vue", description: "Progressive framework" },
						],
					},
					{
						question: "Which styling approach?",
						header: "Styling",
						options: [
							{ label: "Tailwind", description: "Utility-first CSS" },
							{ label: "CSS Modules", description: "Scoped CSS" },
						],
					},
				],
			});

			const output = getTextOutput(result);
			expect(output).toContain("Framework");
			expect(output).toContain("Which framework?");
			expect(output).toContain("Styling");
			expect(output).toContain("Which styling approach?");
		});

		it("includes details with questions", async () => {
			const questions = [
				{
					question: "Test question?",
					header: "Test",
					options: [
						{ label: "Option 1", description: "Description 1" },
						{ label: "Option 2", description: "Description 2" },
					],
				},
			];

			const result = await askUserTool.execute("ask-3", { questions });

			const details = result.details as {
				questions: Question[];
				status: string;
			};
			expect(details.questions).toEqual(questions);
			expect(details.status).toBe("pending");
		});
	});

	describe("multi-select support", () => {
		it("shows multi-select indicator", async () => {
			const result = await askUserTool.execute("ask-4", {
				questions: [
					{
						question: "Which features do you want?",
						header: "Features",
						options: [
							{ label: "Auth", description: "Authentication" },
							{ label: "API", description: "REST API" },
						],
						multiSelect: true,
					},
				],
			});

			const output = getTextOutput(result);
			// Multi-select uses checkbox symbol
			expect(output).toContain("☐");
		});

		it("shows single-select indicator", async () => {
			const result = await askUserTool.execute("ask-5", {
				questions: [
					{
						question: "Which one?",
						header: "Choice",
						options: [
							{ label: "A", description: "Option A" },
							{ label: "B", description: "Option B" },
						],
						multiSelect: false,
					},
				],
			});

			const output = getTextOutput(result);
			// Single-select uses radio symbol
			expect(output).toContain("○");
		});
	});

	describe("Other option", () => {
		it("includes automatic Other option", async () => {
			const result = await askUserTool.execute("ask-6", {
				questions: [
					{
						question: "Which color?",
						header: "Color",
						options: [
							{ label: "Red", description: "Red color" },
							{ label: "Blue", description: "Blue color" },
						],
					},
				],
			});

			const output = getTextOutput(result);
			expect(output).toContain("Other");
			expect(output).toContain("custom answer");
		});
	});
});

describe("formatQuestionsForDisplay", () => {
	it("formats questions with numbered options", () => {
		const questions: Question[] = [
			{
				question: "Test question?",
				header: "Test",
				options: [
					{ label: "Option A", description: "Description A" },
					{ label: "Option B", description: "Description B" },
				],
			},
		];

		const formatted = formatQuestionsForDisplay(questions);

		expect(formatted).toContain("[Test]");
		expect(formatted).toContain("Test question?");
		expect(formatted).toContain("1.");
		expect(formatted).toContain("2.");
		expect(formatted).toContain("Option A");
		expect(formatted).toContain("Option B");
	});

	it("adds Other option after defined options", () => {
		const questions: Question[] = [
			{
				question: "Choose?",
				header: "Q",
				options: [
					{ label: "A", description: "A" },
					{ label: "B", description: "B" },
				],
			},
		];

		const formatted = formatQuestionsForDisplay(questions);

		// Other should be option 3 (after A=1 and B=2)
		expect(formatted).toContain("3. **Other**");
	});

	it("separates multiple questions", () => {
		const questions: Question[] = [
			{
				question: "Q1?",
				header: "H1",
				options: [{ label: "A", description: "A" }],
			},
			{
				question: "Q2?",
				header: "H2",
				options: [{ label: "B", description: "B" }],
			},
		];

		const formatted = formatQuestionsForDisplay(questions);

		expect(formatted).toContain("[H1]");
		expect(formatted).toContain("[H2]");
		expect(formatted).toContain("Q1?");
		expect(formatted).toContain("Q2?");
	});
});

describe("parseUserResponse", () => {
	const singleSelectQuestion: Question = {
		question: "Which?",
		header: "Q",
		options: [
			{ label: "Option A", description: "A" },
			{ label: "Option B", description: "B" },
			{ label: "Option C", description: "C" },
		],
	};

	const multiSelectQuestion: Question = {
		...singleSelectQuestion,
		multiSelect: true,
	};

	describe("number parsing", () => {
		it("parses single number to option label", () => {
			const result = parseUserResponse("1", singleSelectQuestion);
			expect(result).toBe("Option A");
		});

		it("parses option 2", () => {
			const result = parseUserResponse("2", singleSelectQuestion);
			expect(result).toBe("Option B");
		});

		it("parses Other option (last number)", () => {
			const result = parseUserResponse("4", singleSelectQuestion);
			expect(result).toBe("Other");
		});

		it("parses comma-separated numbers for multi-select", () => {
			const result = parseUserResponse("1, 3", multiSelectQuestion);
			expect(result).toEqual(["Option A", "Option C"]);
		});

		it("parses space-separated numbers", () => {
			const result = parseUserResponse("1 2", multiSelectQuestion);
			expect(result).toEqual(["Option A", "Option B"]);
		});
	});

	describe("label matching", () => {
		it("matches option label exactly", () => {
			const result = parseUserResponse("Option A", singleSelectQuestion);
			expect(result).toBe("Option A");
		});

		it("matches label case-insensitively", () => {
			const result = parseUserResponse("option a", singleSelectQuestion);
			expect(result).toBe("Option A");
		});

		it("matches uppercase label", () => {
			const result = parseUserResponse("OPTION B", singleSelectQuestion);
			expect(result).toBe("Option B");
		});
	});

	describe("free-form text", () => {
		it("returns trimmed free-form answer", () => {
			const result = parseUserResponse(
				"  My custom answer  ",
				singleSelectQuestion,
			);
			expect(result).toBe("My custom answer");
		});

		it("returns non-matching text as-is", () => {
			const result = parseUserResponse(
				"Something completely different",
				singleSelectQuestion,
			);
			expect(result).toBe("Something completely different");
		});
	});

	describe("edge cases", () => {
		it("handles out of range numbers", () => {
			const result = parseUserResponse("99", singleSelectQuestion);
			// Out of range numbers should return the input
			expect(result).toBe("99");
		});

		it("filters invalid numbers from multi-select", () => {
			const result = parseUserResponse("1, 99, 2", multiSelectQuestion);
			expect(result).toEqual(["Option A", "Option B"]);
		});
	});
});

describe("helper functions", () => {
	describe("isAskUserCall", () => {
		it("returns true for ask_user tool", () => {
			expect(isAskUserCall("ask_user", {})).toBe(true);
		});

		it("returns false for other tools", () => {
			expect(isAskUserCall("bash", {})).toBe(false);
			expect(isAskUserCall("read", {})).toBe(false);
		});
	});

	describe("extractQuestions", () => {
		it("extracts questions from args", () => {
			const questions = [
				{
					question: "Q?",
					header: "H",
					options: [{ label: "L", description: "D" }],
				},
			];

			const result = extractQuestions({ questions });

			expect(result).toEqual(questions);
		});

		it("returns empty array when no questions", () => {
			const result = extractQuestions({});
			expect(result).toEqual([]);
		});
	});
});
