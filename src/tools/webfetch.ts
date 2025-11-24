import { Type } from "@sinclair/typebox";
import { createTypeboxTool } from "./typebox-tool.js";

const EXA_API_BASE = "https://api.exa.ai";

interface ExaContentsResult {
	id: string;
	url: string;
	title?: string;
	text?: string;
	summary?: string;
	highlights?: string[];
}

interface ExaContentsResponse {
	results: ExaContentsResult[];
	statuses?: Array<{
		id: string;
		status: "success" | "error";
		error?: {
			tag: string;
			httpStatusCode: number;
		};
	}>;
}

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
		Type.Boolean({
			description: "Return relevant highlights/excerpts",
			default: false,
		}),
	),
});

export const webfetchTool = createTypeboxTool({
	name: "webfetch",
	label: "webfetch",
	description:
		"Fetch and extract content from specific URLs using Exa. Converts HTML to clean markdown, optionally returns summaries and highlights. Use for: reading documentation, fetching article content, extracting information from known URLs.",
	schema: webfetchSchema,
	async execute(_toolCallId, params) {
		const apiKey = process.env.EXA_API_KEY;
		if (!apiKey) {
			throw new Error(
				"EXA_API_KEY environment variable is required. Get your key at https://dashboard.exa.ai/api-keys",
			);
		}

		// Normalize URLs to array
		const urls = Array.isArray(params.urls) ? params.urls : [params.urls];

		const requestBody: Record<string, unknown> = {
			ids: urls,
			contents: {
				text: params.text ?? true,
				summary: params.summary ?? false,
				highlights: params.highlights ?? false,
			},
		};

		const response = await fetch(`${EXA_API_BASE}/contents`, {
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

		const data = (await response.json()) as ExaContentsResponse;

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
