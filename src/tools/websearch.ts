import { Type } from "@sinclair/typebox";
import { createTypeboxTool } from "./typebox-tool.js";

const EXA_API_BASE = "https://api.exa.ai";

interface ExaSearchResult {
	title: string;
	url: string;
	publishedDate?: string;
	author?: string;
	text?: string;
	summary?: string;
	highlights?: string[];
}

interface ExaSearchResponse {
	requestId: string;
	results: ExaSearchResult[];
	resolvedSearchType?: string;
	costDollars?: {
		total: number;
	};
}

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
			default: 10,
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
			default: false,
		}),
	),
	summary: Type.Optional(
		Type.Boolean({
			description: "Return AI-generated summary of each result",
			default: false,
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
});

export const websearchTool = createTypeboxTool({
	name: "websearch",
	label: "websearch",
	description:
		"Search the web using Exa AI for real-time information beyond training cutoff. Supports semantic (neural) and keyword search with optional full text and summaries. Use for: recent news, documentation, research papers, current events.",
	schema: websearchSchema,
	async execute(_toolCallId, params) {
		const apiKey = process.env.EXA_API_KEY;
		if (!apiKey) {
			throw new Error(
				"EXA_API_KEY environment variable is required. Get your key at https://dashboard.exa.ai/api-keys",
			);
		}

		const requestBody: Record<string, unknown> = {
			query: params.query,
			numResults: params.numResults ?? 10,
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
		if (params.text || params.summary) {
			requestBody.contents = {
				text: params.text ?? false,
				summary: params.summary ?? false,
			};
		}

		const response = await fetch(`${EXA_API_BASE}/search`, {
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

		const data = (await response.json()) as ExaSearchResponse;

		// Format results
		const outputLines: string[] = [];
		outputLines.push(`Query: "${params.query}"`);
		outputLines.push(
			`Search type: ${data.resolvedSearchType || params.type || "auto"}`,
		);
		outputLines.push(`Found ${data.results.length} results`);
		if (data.costDollars) {
			outputLines.push(
				`Cost: $${data.costDollars.total.toFixed(4)} (charged to Exa account)`,
			);
		}
		outputLines.push("");

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
				costDollars: data.costDollars?.total,
				results: data.results,
			},
		};
	},
});
