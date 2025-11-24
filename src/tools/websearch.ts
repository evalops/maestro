import { Type } from "@sinclair/typebox";
import { callExa, normalizeCostDollars } from "./exa-client.js";
import {
	ExaContextOptionSchema,
	ExaHighlightsOptionSchema,
	ExaSummaryOptionSchema,
	ExaTextOptionSchema,
	buildContentsOptions,
} from "./exa-contents.js";
import type { ExaSearchResponse } from "./exa-types.js";
import { createTool } from "./tool-dsl.js";

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
	text: Type.Optional(ExaTextOptionSchema),
	summary: Type.Optional(ExaSummaryOptionSchema),
	highlights: Type.Optional(ExaHighlightsOptionSchema),
	context: Type.Optional(ExaContextOptionSchema),
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

export interface WebsearchDetails {
	requestId: string;
	resolvedSearchType: string;
	resultsCount: number;
	costDollars: number | null;
	context?: string;
	results: ExaSearchResponse["results"];
}

export const websearchTool = createTool<
	typeof websearchSchema,
	WebsearchDetails
>({
	name: "websearch",
	label: "websearch",
	description:
		"Search the web using Exa AI for real-time information beyond training cutoff. Supports semantic (neural) and keyword search with optional full text and summaries. Use for: recent news, documentation, research papers, current events.",
	schema: websearchSchema,
	run: async (params, { respond }) => {
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

		respond.text(`Query: "${params.query}"`);
		respond.text(
			`Search type: ${data.resolvedSearchType || params.type || "auto"}`,
		);
		respond.text(`Found ${data.results.length} results`);

		const totalCost = normalizeCostDollars(data.costDollars);
		if (typeof totalCost === "number") {
			respond.text(`Cost: $${totalCost.toFixed(4)} (charged to Exa account)`);
		}
		respond.text("");

		if (data.context) {
			respond.text("LLM-Optimized Context:");
			respond.text("─".repeat(80));
			respond.text(data.context);
			respond.text("─".repeat(80));
			respond.text("");
		}

		for (let i = 0; i < data.results.length; i++) {
			const result = data.results[i];
			respond.text(`${i + 1}. ${result.title}`);
			respond.text(`   URL: ${result.url}`);

			if (result.publishedDate) {
				const date = new Date(result.publishedDate).toLocaleDateString();
				respond.text(`   Published: ${date}`);
			}

			if (result.author) {
				respond.text(`   Author: ${result.author}`);
			}

			if (result.summary) {
				respond.text(`   Summary: ${result.summary}`);
			}

			if (result.text) {
				const textPreview =
					result.text.length > 500
						? `${result.text.substring(0, 500)}...`
						: result.text;
				respond.text(`   Text: ${textPreview}`);
			}

			if (result.highlights && result.highlights.length > 0) {
				respond.text("   Highlights:");
				for (const highlight of result.highlights) {
					respond.text(`     - ${highlight}`);
				}
			}

			respond.text("");
		}

		respond.detail({
			requestId: data.requestId,
			resolvedSearchType: data.resolvedSearchType ?? "auto",
			resultsCount: data.results.length,
			costDollars: totalCost ?? null,
			context: data.context,
			results: data.results,
		});

		return respond;
	},
});
