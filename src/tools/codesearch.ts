import { Type } from "@sinclair/typebox";
import { callExa, normalizeCostDollars } from "./exa-client.js";
import type { ExaContextResponse } from "./exa-types.js";
import { createTool } from "./tool-dsl.js";

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

export interface CodesearchDetails {
	requestId: string;
	query: string;
	resultsCount: number;
	outputTokens: number;
	searchTime: number;
	costDollars: number;
	response: string;
}

export const codesearchTool = createTool<
	typeof codesearchSchema,
	CodesearchDetails
>({
	name: "codesearch",
	label: "codesearch",
	description:
		"Search billions of GitHub repos, documentation, and Stack Overflow for code examples and programming context using Exa Code API. Returns token-efficient, working code examples. Use for: framework usage, API syntax, library examples, best practices, setup instructions.",
	schema: codesearchSchema,
	run: async (params, { respond }) => {
		const data = await callExa<ExaContextResponse>(
			"/context",
			{
				query: params.query,
				tokensNum: params.tokensNum ?? "dynamic",
			},
			{
				toolName: "codesearch",
				operation: "context",
			},
		);

		const costTotal = normalizeCostDollars(data.costDollars) ?? 0;

		respond.text(`Query: "${data.query}"`);
		respond.text(
			`Results: ${data.resultsCount} sources, ${data.outputTokens} tokens`,
		);
		respond.text(
			`Search time: ${(data.searchTime / 1000).toFixed(2)}s, Cost: $${costTotal.toFixed(4)}`,
		);
		respond.text("");
		respond.text("Code Examples and Context:");
		respond.text("─".repeat(80));
		respond.text("");
		respond.text(data.response);

		respond.detail({
			requestId: data.requestId,
			query: data.query,
			resultsCount: data.resultsCount,
			outputTokens: data.outputTokens,
			searchTime: data.searchTime,
			costDollars: costTotal,
			response: data.response,
		});

		return respond;
	},
});
