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
}

export const webfetchTool = createTool<typeof webfetchSchema, WebfetchDetails>({
	name: "webfetch",
	label: "webfetch",
	description:
		"Fetch content from URLs. Returns clean markdown with optional summaries and highlights. Use when you have specific URLs to read.",
	schema: webfetchSchema,
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
			respond.text("⚠️  Some URLs failed to fetch:");
			for (const error of errors) {
				respond.text(`   ${error}`);
			}
			respond.text("");
		}

		respond.text(`Fetched ${data.results.length} URL(s)`);
		respond.text("");

		for (let i = 0; i < data.results.length; i++) {
			const result = data.results[i];
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
				const textLines = result.text.split("\n");
				for (const line of textLines) {
					respond.text(`   ${line}`);
				}
				respond.text(`   ${"─".repeat(78)}`);
			}

			respond.text("");
		}

		respond.detail({
			resultsCount: data.results.length,
			errors: errors.length > 0 ? errors : undefined,
			results: data.results,
		});

		return respond;
	},
});
