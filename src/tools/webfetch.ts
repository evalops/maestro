import { Type } from "@sinclair/typebox";
import { buildContentsOptions, callExa } from "./exa-client.js";
import type { ExaContentsResponse } from "./exa-types.js";
import { createTypeboxTool } from "./typebox-tool.js";

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
	text: Type.Optional(
		Type.Boolean({
			description: "Return full page text content in markdown format",
			default: true,
		}),
	),
	summary: Type.Optional(
		Type.Boolean({
			description: "Return AI-generated summary",
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
					"Return highlights (boolean) or provide an object to control numSentences/highlightsPerUrl",
			},
		),
	),
});

export const webfetchTool = createTypeboxTool({
	name: "webfetch",
	label: "webfetch",
	description:
		"Fetch and extract content from specific URLs using Exa. Converts HTML to clean markdown, optionally returns summaries and highlights. Use for: reading documentation, fetching article content, extracting information from known URLs.",
	schema: webfetchSchema,
	async execute(_toolCallId, params) {
		// Normalize URLs to array
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

		// Check for errors
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

		// Format results
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
				// Split text into lines and indent each
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
