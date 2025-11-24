import { Type } from "@sinclair/typebox";
import { createTypeboxTool } from "./typebox-tool.js";

const EXA_API_BASE = "https://api.exa.ai";

interface ExaContextResponse {
	requestId: string;
	query: string;
	response: string;
	resultsCount: number;
	costDollars: string;
	searchTime: number;
	outputTokens: number;
}

const codesearchSchema = Type.Object({
	query: Type.String({
		description:
			"Code-related search query (e.g., 'React hooks for state management', 'Express.js middleware patterns')",
		minLength: 1,
		maxLength: 2000,
	}),
	tokensNum: Type.Optional(
		Type.Union(
			[
				Type.Literal("dynamic"),
				Type.Integer({
					minimum: 50,
					maximum: 100000,
				}),
			],
			{
				description:
					"Token limit for response. 'dynamic' (recommended) adjusts automatically. 5000 is good default, 10000 for more context",
				default: "dynamic",
			},
		),
	),
});

export const codesearchTool = createTypeboxTool({
	name: "codesearch",
	label: "codesearch",
	description:
		"Search billions of GitHub repos, documentation, and Stack Overflow for code examples and programming context using Exa Code API. Returns token-efficient, working code examples. Use for: framework usage, API syntax, library examples, best practices, setup instructions.",
	schema: codesearchSchema,
	async execute(_toolCallId, params) {
		const apiKey = process.env.EXA_API_KEY;
		if (!apiKey) {
			throw new Error(
				"EXA_API_KEY environment variable is required. Get your key at https://dashboard.exa.ai/api-keys",
			);
		}

		const requestBody: Record<string, unknown> = {
			query: params.query,
			tokensNum: params.tokensNum ?? "dynamic",
		};

		const response = await fetch(`${EXA_API_BASE}/context`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": apiKey,
			},
			body: JSON.stringify(requestBody),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(
				`Exa API error (${response.status}): ${errorText || response.statusText}`,
			);
		}

		const data = (await response.json()) as ExaContextResponse;

		// Parse cost (returned as JSON string)
		let costTotal = 0;
		try {
			const costData = JSON.parse(data.costDollars);
			costTotal = costData.total || 0;
		} catch {
			// Ignore parse errors
		}

		// Format output
		const outputLines: string[] = [];
		outputLines.push(`Query: "${data.query}"`);
		outputLines.push(
			`Results: ${data.resultsCount} sources, ${data.outputTokens} tokens`,
		);
		outputLines.push(
			`Search time: ${(data.searchTime / 1000).toFixed(2)}s, Cost: $${costTotal.toFixed(4)}`,
		);
		outputLines.push("");
		outputLines.push("Code Examples and Context:");
		outputLines.push("─".repeat(80));
		outputLines.push("");
		outputLines.push(data.response);

		return {
			content: [{ type: "text", text: outputLines.join("\n") }],
			details: {
				requestId: data.requestId,
				query: data.query,
				resultsCount: data.resultsCount,
				outputTokens: data.outputTokens,
				searchTime: data.searchTime,
				costDollars: costTotal,
				response: data.response,
			},
		};
	},
});
