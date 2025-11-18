import { Type } from "@sinclair/typebox";
import {
	ExaHighlightsOptionSchema,
	ExaSummaryOptionSchema,
	ExaTextOptionSchema,
	buildContentsOptions,
} from "./exa-contents.js";
import type { ExaContentsResponse } from "./exa-types.js";
import { createExaTool } from "./exa-tool.js";

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

export const webfetchTool = createExaTool({
	name: "webfetch",
	label: "webfetch",
	description:
		"Fetch and extract content from specific URLs using Exa. Converts HTML to clean markdown, optionally returns summaries and highlights. Use for: reading documentation, fetching article content, extracting information from known URLs.",
	schema: webfetchSchema,
	endpoint: "/contents",
	operation: "contents",
	buildRequest: (params) => {
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
		return requestBody;
	},
	mapResponse: (data: ExaContentsResponse) => {
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

		const outputLines: string[] = [];

		if (errors.length > 0) {
			outputLines.push("⚠️  Some URLs failed to fetch:");
			for (const error of errors) {
				outputLines.push(`   ${error}`);
			}
			outputLines.push("");
		}

		outputLines.push(`Fetched ${data.results.length} URL(s)`);
		outputLines.push("");

		for (let i = 0; i < data.results.length; i++) {
			const result = data.results[i];
			outputLines.push(`${i + 1}. ${result.title || result.url}`);
			outputLines.push(`   URL: ${result.url}`);

			if (result.summary) {
				outputLines.push(`   Summary: ${result.summary}`);
				outputLines.push("");
			}

			if (result.highlights && result.highlights.length > 0) {
				outputLines.push("   Highlights:");
				for (const highlight of result.highlights) {
					outputLines.push(`     - ${highlight}`);
				}
				outputLines.push("");
			}

			if (result.text) {
				outputLines.push("   Content:");
				outputLines.push(`   ${"─".repeat(78)}`);
				const textLines = result.text.split("\n");
				for (const line of textLines) {
					outputLines.push(`   ${line}`);
				}
				outputLines.push(`   ${"─".repeat(78)}`);
			}

			outputLines.push("");
		}

		return {
			content: [{ type: "text", text: outputLines.join("\n") }],
			details: {
				resultsCount: data.results.length,
				errors: errors.length > 0 ? errors : undefined,
				results: data.results,
			},
		};
	},
});
