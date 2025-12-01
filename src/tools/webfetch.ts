import { Type } from "@sinclair/typebox";
import { callExa } from "./exa-client.js";
import {
	ExaHighlightsOptionSchema,
	ExaSummaryOptionSchema,
	ExaTextOptionSchema,
	buildContentsOptions,
} from "./exa-contents.js";
import type { ExaContentsResponse } from "./exa-types.js";
import { createTool } from "./tool-dsl.js";

const MAX_CONTENT_CHARS = 2000;
const MAX_OUTPUT_CHARS = 8000;

const webfetchSchema = Type.Object({
	urls: Type.Union(
		[
			Type.String({
				description: "Single URL to fetch content from",
				minLength: 1,
			}),
			Type.Array(Type.String({ minLength: 1 }), {
				description: "Multiple URLs to fetch content from",
				minItems: 1,
				maxItems: 100,
			}),
		],
		{
			description: "URL(s) to fetch content from",
		},
	),
	text: Type.Optional(ExaTextOptionSchema),
	summary: Type.Optional(ExaSummaryOptionSchema),
	highlights: Type.Optional(ExaHighlightsOptionSchema),
});

export interface WebfetchDetails {
	resultsCount: number;
	errors?: string[];
	results: ExaContentsResponse["results"];
	truncated?: boolean;
}

// Retry on network errors
const isWebfetchRetryable = (error: unknown): boolean => {
	if (!(error instanceof Error)) return false;
	const msg = error.message.toLowerCase();
	return (
		msg.includes("network") ||
		msg.includes("timeout") ||
		msg.includes("econnreset") ||
		msg.includes("fetch failed")
	);
};

export const webfetchTool = createTool<typeof webfetchSchema, WebfetchDetails>({
	name: "webfetch",
	label: "webfetch",
	description:
		"Fetch content from URLs. Returns clean markdown with optional summaries and highlights. Use when you have specific URLs to read.",
	schema: webfetchSchema,
	maxRetries: 2,
	retryDelayMs: 1000,
	shouldRetry: isWebfetchRetryable,
	run: async (params, { respond }) => {
		const urls = Array.isArray(params.urls) ? params.urls : [params.urls];
		const contents = buildContentsOptions(
			{
				text: params.text,
				summary: params.summary,
				highlights: params.highlights,
			},
			{ text: true, summary: false, highlights: false },
		);
		const requestBody: Record<string, unknown> = { ids: urls };
		if (contents) {
			requestBody.contents = contents;
		}

		const data = await callExa<ExaContentsResponse>("/contents", requestBody, {
			toolName: "webfetch",
			operation: "contents",
		});

		const errors: string[] = [];
		if (data.statuses) {
			for (const status of data.statuses) {
				if (status.status === "error" && status.error) {
					errors.push(
						`${status.id}: ${status.error.tag} (HTTP ${status.error.httpStatusCode})`,
					);
				}
			}
		}

		if (errors.length > 0) {
			respond.text("[WARN] Some URLs failed to fetch:");
			for (const error of errors) {
				respond.text(`   ${error}`);
			}
			respond.text("");
		}

		respond.text(`Fetched ${data.results.length} URL(s)`);
		respond.text("");

		let outputChars = 0;
		let truncatedOutput = false;
		let printedResults = 0;

		for (let i = 0; i < data.results.length; i++) {
			const result = data.results[i];
			const textWeight = result.text
				? Math.min(result.text.length, MAX_CONTENT_CHARS * 2)
				: 0;
			const prospectiveOutput =
				outputChars + (result.summary?.length ?? 0) + textWeight;
			if (printedResults > 0 && prospectiveOutput >= MAX_OUTPUT_CHARS) {
				truncatedOutput = true;
				respond.text(
					`[truncated] Additional content omitted to keep output under ${MAX_OUTPUT_CHARS} characters.`,
				);
				break;
			}
			respond.text(`${i + 1}. ${result.title || result.url}`);
			respond.text(`   URL: ${result.url}`);

			if (result.summary) {
				respond.text(`   Summary: ${result.summary}`);
				respond.text("");
			}

			if (result.highlights && result.highlights.length > 0) {
				respond.text("   Highlights:");
				for (const highlight of result.highlights) {
					respond.text(`     - ${highlight}`);
				}
				respond.text("");
			}

			if (result.text) {
				respond.text("   Content:");
				respond.text(`   ${"─".repeat(78)}`);
				const limited =
					result.text.length > MAX_CONTENT_CHARS
						? `${result.text.slice(0, MAX_CONTENT_CHARS)}...`
						: result.text;
				const textLines = limited.split("\n");
				for (const line of textLines) {
					respond.text(`   ${line}`);
				}
				if (limited.length < result.text.length) {
					respond.text("   [content truncated]");
				}
				respond.text(`   ${"─".repeat(78)}`);
			}

			respond.text("");

			outputChars = prospectiveOutput;
			printedResults += 1;
		}

		const detailResults = truncatedOutput
			? data.results.slice(0, printedResults).map((result) => ({
					...result,
					text: result.text
						? result.text.length > MAX_CONTENT_CHARS
							? `${result.text.slice(0, MAX_CONTENT_CHARS)}...`
							: result.text
						: undefined,
				}))
			: data.results;

		respond.detail({
			resultsCount: data.results.length,
			errors: errors.length > 0 ? errors : undefined,
			results: detailResults,
			truncated: truncatedOutput,
		});

		return respond;
	},
});
