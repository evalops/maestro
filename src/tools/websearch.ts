/**
 * Web Search Tool - Exa-Powered Internet Search
 *
 * This module provides a web search tool that uses the Exa AI search API
 * to find current information on the internet. It supports multiple search
 * types, content extraction, and domain filtering.
 *
 * ## Search Types
 *
 * | Type    | Description                                | Use Case             |
 * |---------|--------------------------------------------|-----------------------|
 * | neural  | Semantic search using embeddings           | Conceptual queries    |
 * | keyword | Traditional keyword-based SERP search      | Exact phrase matching |
 * | auto    | Intelligent mix of neural and keyword      | General queries       |
 * | fast    | Streamlined search for quick results       | Speed-critical tasks  |
 *
 * ## Features
 *
 * - **Domain filtering**: Include/exclude specific domains
 * - **Date filtering**: Filter by publication date
 * - **Content extraction**: Get full text, summaries, or highlights
 * - **Live crawling**: Fresh content when cache is stale
 * - **Subpage crawling**: Crawl linked pages from results
 * - **Category focus**: Target specific content types (news, GitHub, PDF, etc.)
 *
 * ## Requirements
 *
 * - `EXA_API_KEY` environment variable must be set
 *
 * ## Example
 *
 * ```typescript
 * // Basic search
 * websearchTool.execute('call-id', {
 *   query: 'TypeScript 5.0 new features',
 *   numResults: 5,
 * });
 *
 * // Focused search on specific domains
 * websearchTool.execute('call-id', {
 *   query: 'React hooks best practices',
 *   includeDomains: ['react.dev', 'github.com'],
 *   category: 'github',
 * });
 * ```
 *
 * ## Output Limits
 *
 * - Max text per result: 800 characters
 * - Max total output: 6000 characters
 * - Results truncated with indicator when limits exceeded
 *
 * @module tools/websearch
 */

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

const MAX_RESULT_TEXT_CHARS = 800;
const MAX_OUTPUT_CHARS = 6000;

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
	truncated?: boolean;
}

export const websearchTool = createTool<
	typeof websearchSchema,
	WebsearchDetails
>({
	name: "websearch",
	label: "websearch",
	description:
		"Search the web for current information. Returns URLs, titles, and optional text/summaries. Use for recent docs, news, or research beyond training data.",
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

		let outputChars = 0;
		let truncated = false;
		let printedResults = 0;
		const maxDisplayResults = params.numResults ?? data.results.length;

		for (let i = 0; i < data.results.length; i++) {
			if (printedResults >= maxDisplayResults) {
				truncated = true;
				respond.text(
					`[truncated] Additional results omitted to honor requested limit of ${maxDisplayResults}.`,
				);
				break;
			}
			const result = data.results[i];

			if (!result) continue;
			const textPreview = result.text
				? result.text.length > MAX_RESULT_TEXT_CHARS
					? `${result.text.substring(0, MAX_RESULT_TEXT_CHARS)}...`
					: result.text
				: null;
			const textWeight = result.text
				? Math.min(result.text.length, MAX_RESULT_TEXT_CHARS * 2)
				: 0;
			const prospectiveOutput =
				outputChars +
				result.title.length +
				(result.summary?.length ?? 0) +
				textWeight;
			if (printedResults > 0 && prospectiveOutput >= MAX_OUTPUT_CHARS) {
				truncated = true;
				respond.text(
					`[truncated] Additional results omitted to keep output under ${MAX_OUTPUT_CHARS} characters.`,
				);
				break;
			}
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

			if (textPreview) {
				respond.text(`   Text: ${textPreview}`);
				if (result.text && result.text.length > textPreview.length) {
					respond.text("   [text truncated]");
				}
			}

			if (result.highlights && result.highlights.length > 0) {
				respond.text("   Highlights:");
				for (const highlight of result.highlights) {
					respond.text(`     - ${highlight}`);
				}
			}

			respond.text("");

			// Update budget after printing
			outputChars = prospectiveOutput;
			printedResults += 1;
		}

		const detailResults = truncated
			? data.results.slice(0, printedResults).map((result) => ({
					...result,
					text: result.text
						? result.text.length > MAX_RESULT_TEXT_CHARS
							? `${result.text.substring(0, MAX_RESULT_TEXT_CHARS)}...`
							: result.text
						: undefined,
				}))
			: data.results;

		respond.detail({
			requestId: data.requestId,
			resolvedSearchType: data.resolvedSearchType ?? "auto",
			resultsCount: data.results.length,
			costDollars: totalCost ?? null,
			context: data.context,
			results: detailResults,
			truncated,
		});

		return respond;
	},
});
