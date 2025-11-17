import { Type } from "@sinclair/typebox";
import {
	buildContentsOptions,
	callExa,
	normalizeCostDollars,
} from "./exa-client.js";
import type { ExaSearchResponse } from "./exa-types.js";
import { createTypeboxTool } from "./typebox-tool.js";

const websearchSchema = Type.Object({
	query: Type.String({
		description: "Search query",
		minLength: 1,
		maxLength: 2000,
	}),
	numResults: Type.Optional(
		Type.Integer({
			description: "Number of results to return (max varies by type)",
			minimum: 1,
			maximum: 100,
			default: 5,
		}),
	),
	type: Type.Optional(
		Type.Union(
			[
				Type.Literal("neural"),
				Type.Literal("keyword"),
				Type.Literal("auto"),
				Type.Literal("fast"),
			],
			{
				description:
					"Search type: neural (embeddings), keyword (SERP), auto (intelligent mix), fast (streamlined)",
				default: "auto",
			},
		),
	),
	category: Type.Optional(
		Type.Union(
			[
				Type.Literal("company"),
				Type.Literal("research paper"),
				Type.Literal("news"),
				Type.Literal("pdf"),
				Type.Literal("github"),
				Type.Literal("tweet"),
				Type.Literal("personal site"),
				Type.Literal("linkedin profile"),
				Type.Literal("financial report"),
			],
			{
				description: "Data category to focus on",
			},
		),
	),
	includeDomains: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"List of domains to include (results only from these domains)",
			maxItems: 50,
		}),
	),
	excludeDomains: Type.Optional(
		Type.Array(Type.String(), {
			description: "List of domains to exclude from results",
			maxItems: 50,
		}),
	),
	text: Type.Optional(
		Type.Boolean({
			description: "Return full page text content in markdown format",
			default: true,
		}),
	),
	summary: Type.Optional(
		Type.Boolean({
			description: "Return AI-generated summary of each result",
			default: false,
		}),
	),
	highlights: Type.Optional(
		Type.Union(
			[
				Type.Boolean({
					description: "Return relevant highlights/excerpts",
				}),
				Type.Object({
					numSentences: Type.Optional(
						Type.Integer({
							description: "Number of sentences per highlight",
							minimum: 1,
							maximum: 10,
							default: 3,
						}),
					),
					highlightsPerUrl: Type.Optional(
						Type.Integer({
							description: "Maximum highlights per URL",
							minimum: 1,
							maximum: 20,
							default: 5,
						}),
					),
				}),
			],
			{
				description:
					"Control highlight extraction (boolean or config object with numSentences/highlightsPerUrl)",
			},
		),
	),
	context: Type.Optional(
		Type.Boolean({
			description:
				"Return LLM-optimized context string combining all results (recommended for RAG). Better than individual text for LLM consumption.",
			default: true,
		}),
	),
	startPublishedDate: Type.Optional(
		Type.String({
			description:
				"Only results published after this date (ISO 8601 format: YYYY-MM-DD)",
		}),
	),
	endPublishedDate: Type.Optional(
		Type.String({
			description:
				"Only results published before this date (ISO 8601 format: YYYY-MM-DD)",
		}),
	),
	livecrawl: Type.Optional(
		Type.Union(
			[
				Type.Literal("never"),
				Type.Literal("fallback"),
				Type.Literal("preferred"),
				Type.Literal("always"),
			],
			{
				description:
					"Live crawling preference: never (cache only), fallback (use cache unless needed), preferred (prefer live crawl), always",
			},
		),
	),
	subpages: Type.Optional(
		Type.Object({
			limit: Type.Integer({
				description: "Number of subpages to crawl per root result",
				minimum: 1,
				maximum: 20,
				default: 5,
			}),
			depth: Type.Optional(
				Type.Integer({
					description: "Subpage crawl depth",
					minimum: 1,
					maximum: 5,
					default: 1,
				}),
			),
		}),
	),
});

export const websearchTool = createTypeboxTool({
	name: "websearch",
	label: "websearch",
	description:
		"Search the web using Exa AI for real-time information beyond training cutoff. Supports semantic (neural) and keyword search with optional full text and summaries. Use for: recent news, documentation, research papers, current events.",
	schema: websearchSchema,
	async execute(_toolCallId, params) {
		const requestBody: Record<string, unknown> = {
			query: params.query,
			numResults: params.numResults ?? 5,
			type: params.type ?? "auto",
		};

		if (params.category) requestBody.category = params.category;
		if (params.includeDomains)
			requestBody.includeDomains = params.includeDomains;
		if (params.excludeDomains)
			requestBody.excludeDomains = params.excludeDomains;
		if (params.startPublishedDate)
			requestBody.startPublishedDate = params.startPublishedDate;
		if (params.endPublishedDate)
			requestBody.endPublishedDate = params.endPublishedDate;

		// Configure contents retrieval
		const contents = buildContentsOptions(
			{
				text: params.text,
				summary: params.summary,
				context: params.context,
				highlights: params.highlights,
			},
			{ text: true, summary: false, context: true, highlights: false },
		);
		if (contents) {
			requestBody.contents = contents;
		}
		if (params.livecrawl) {
			requestBody.livecrawl = params.livecrawl;
		}
		if (params.subpages) {
			requestBody.subpages = params.subpages;
		}

		const data = await callExa<ExaSearchResponse>("/search", requestBody, {
			toolName: "websearch",
			operation: "search",
		});

		// Format results
		const outputLines: string[] = [];
		outputLines.push(`Query: "${params.query}"`);
		outputLines.push(
			`Search type: ${data.resolvedSearchType || params.type || "auto"}`,
		);
		outputLines.push(`Found ${data.results.length} results`);
		const totalCost = normalizeCostDollars(data.costDollars);
		if (typeof totalCost === "number") {
			outputLines.push(
				`Cost: $${totalCost.toFixed(4)} (charged to Exa account)`,
			);
		}
		outputLines.push("");

		// If context string is available, use it (LLM-optimized)
		if (data.context) {
			outputLines.push("LLM-Optimized Context:");
			outputLines.push("─".repeat(80));
			outputLines.push(data.context);
			outputLines.push("─".repeat(80));
			outputLines.push("");
		}

		for (let i = 0; i < data.results.length; i++) {
			const result = data.results[i];
			outputLines.push(`${i + 1}. ${result.title}`);
			outputLines.push(`   URL: ${result.url}`);

			if (result.publishedDate) {
				const date = new Date(result.publishedDate).toLocaleDateString();
				outputLines.push(`   Published: ${date}`);
			}

			if (result.author) {
				outputLines.push(`   Author: ${result.author}`);
			}

			if (result.summary) {
				outputLines.push(`   Summary: ${result.summary}`);
			}

			if (result.text) {
				// Show first 500 characters of text
				const textPreview =
					result.text.length > 500
						? `${result.text.substring(0, 500)}...`
						: result.text;
				outputLines.push(`   Text: ${textPreview}`);
			}

			if (result.highlights && result.highlights.length > 0) {
				outputLines.push("   Highlights:");
				for (const highlight of result.highlights) {
					outputLines.push(`     - ${highlight}`);
				}
			}

			outputLines.push("");
		}

		return {
			content: [{ type: "text", text: outputLines.join("\n") }],
			details: {
				requestId: data.requestId,
				resolvedSearchType: data.resolvedSearchType,
				resultsCount: data.results.length,
				costDollars: totalCost,
				context: data.context,
				results: data.results,
			},
		};
	},
});
