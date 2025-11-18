import { Type } from "@sinclair/typebox";
import { normalizeCostDollars } from "./exa-client.js";
import { createExaTool } from "./exa-tool.js";
import type { ExaContextResponse } from "./exa-types.js";

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

export const codesearchTool = createExaTool({
	name: "codesearch",
	label: "codesearch",
	description:
		"Search billions of GitHub repos, documentation, and Stack Overflow for code examples and programming context using Exa Code API. Returns token-efficient, working code examples. Use for: framework usage, API syntax, library examples, best practices, setup instructions.",
	schema: codesearchSchema,
	endpoint: "/context",
	operation: "context",
	buildRequest: (params) => ({
		query: params.query,
		tokensNum: params.tokensNum ?? "dynamic",
	}),
	mapResponse: (data: ExaContextResponse) => {
		const costTotal = normalizeCostDollars(data.costDollars) ?? 0;

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
