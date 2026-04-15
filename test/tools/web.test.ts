import { describe, expect, it, vi } from "vitest";
import type { AgentToolResult } from "../../src/agent/types.js";
import { webfetchTool } from "../../src/tools/webfetch.js";
import { websearchTool } from "../../src/tools/websearch.js";

// Mock the Exa client
vi.mock("../../src/tools/exa-client.js", () => ({
	callExa: vi.fn().mockImplementation((endpoint: string) => {
		if (endpoint === "/search") {
			return {
				requestId: "test-request-id",
				resolvedSearchType: "neural",
				costDollars: 0.001,
				results: [
					{
						title: "Test Result 1",
						url: "https://example.com/1",
						text: "This is the content of the first result.",
						publishedDate: "2024-01-15T00:00:00Z",
						author: "Test Author",
						summary: "Summary of the first result",
					},
					{
						title: "Test Result 2",
						url: "https://example.com/2",
						text: "This is the content of the second result.",
					},
				],
			};
		}
		if (endpoint === "/contents") {
			return {
				results: [
					{
						title: "Fetched Page",
						url: "https://example.com/page",
						text: "The page content goes here.",
						summary: "Page summary",
						highlights: ["Important highlight 1", "Important highlight 2"],
					},
				],
				statuses: [{ id: "https://example.com/page", status: "success" }],
			};
		}
		throw new Error(`Unknown endpoint: ${endpoint}`);
	}),
	normalizeCostDollars: vi.fn().mockImplementation((cost) => cost),
}));

// Helper to extract text from content blocks
function getTextOutput(result: AgentToolResult<unknown>): string {
	return (
		result.content
			?.filter((c): c is { type: "text"; text: string } => {
				return (
					c != null && typeof c === "object" && "type" in c && c.type === "text"
				);
			})
			.map((c) => c.text)
			.join("\n") || ""
	);
}

describe("websearch tool", () => {
	describe("basic search", () => {
		it("searches and returns results", async () => {
			const result = await websearchTool.execute("ws-1", {
				query: "test search query",
			});

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("test search query");
			expect(output).toContain("Test Result 1");
			expect(output).toContain("Test Result 2");
		});

		it("includes URLs in output", async () => {
			const result = await websearchTool.execute("ws-2", {
				query: "test",
			});

			const output = getTextOutput(result);
			expect(output).toContain("https://example.com/1");
			expect(output).toContain("https://example.com/2");
		});

		it("shows author and date when available", async () => {
			const result = await websearchTool.execute("ws-3", {
				query: "test",
			});

			const output = getTextOutput(result);
			expect(output).toContain("Test Author");
			expect(output).toContain("Published:");
		});

		it("shows summary when available", async () => {
			const result = await websearchTool.execute("ws-4", {
				query: "test",
			});

			const output = getTextOutput(result);
			expect(output).toContain("Summary of the first result");
		});
	});

	describe("search options", () => {
		it("accepts numResults parameter", async () => {
			const result = await websearchTool.execute("ws-5", {
				query: "test",
				numResults: 10,
			});

			expect(result.isError).toBeFalsy();
		});

		it("accepts type parameter", async () => {
			const result = await websearchTool.execute("ws-6", {
				query: "test",
				type: "neural",
			});

			expect(result.isError).toBeFalsy();
		});

		it("accepts category parameter", async () => {
			const result = await websearchTool.execute("ws-7", {
				query: "test",
				category: "news",
			});

			expect(result.isError).toBeFalsy();
		});

		it("accepts domain filtering", async () => {
			const result = await websearchTool.execute("ws-8", {
				query: "test",
				includeDomains: ["example.com"],
				excludeDomains: ["bad.com"],
			});

			expect(result.isError).toBeFalsy();
		});

		it("accepts date range", async () => {
			const result = await websearchTool.execute("ws-9", {
				query: "test",
				startPublishedDate: "2024-01-01",
				endPublishedDate: "2024-12-31",
			});

			expect(result.isError).toBeFalsy();
		});

		it("accepts livecrawl option", async () => {
			const result = await websearchTool.execute("ws-10", {
				query: "test",
				livecrawl: "always",
			});

			expect(result.isError).toBeFalsy();
		});
	});

	describe("details metadata", () => {
		it("includes requestId in details", async () => {
			const result = await websearchTool.execute("ws-11", {
				query: "test",
			});

			const details = result.details as { requestId: string };
			expect(details.requestId).toBe("test-request-id");
		});

		it("includes resultsCount in details", async () => {
			const result = await websearchTool.execute("ws-12", {
				query: "test",
			});

			const details = result.details as { resultsCount: number };
			expect(details.resultsCount).toBe(2);
		});

		it("includes costDollars in details", async () => {
			const result = await websearchTool.execute("ws-13", {
				query: "test",
			});

			const details = result.details as { costDollars: number };
			expect(details.costDollars).toBe(0.001);
		});

		it("includes results array in details", async () => {
			const result = await websearchTool.execute("ws-14", {
				query: "test",
			});

			const details = result.details as {
				results: Array<{ title: string; url: string }>;
			};
			expect(details.results).toHaveLength(2);
			expect(details.results[0]!.title).toBe("Test Result 1");
		});
	});
});

describe("webfetch tool", () => {
	describe("basic fetch", () => {
		it("fetches single URL", async () => {
			const result = await webfetchTool.execute("wf-1", {
				urls: "https://example.com/page",
			});

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("Fetched 1 URL");
		});

		it("fetches multiple URLs", async () => {
			const result = await webfetchTool.execute("wf-2", {
				urls: ["https://example.com/1", "https://example.com/2"],
			});

			expect(result.isError).toBeFalsy();
		});

		it("includes page title in output", async () => {
			const result = await webfetchTool.execute("wf-3", {
				urls: "https://example.com/page",
			});

			const output = getTextOutput(result);
			expect(output).toContain("Fetched Page");
		});

		it("includes URL in output", async () => {
			const result = await webfetchTool.execute("wf-4", {
				urls: "https://example.com/page",
			});

			const output = getTextOutput(result);
			expect(output).toContain("https://example.com/page");
		});

		it("includes content in output", async () => {
			const result = await webfetchTool.execute("wf-5", {
				urls: "https://example.com/page",
			});

			const output = getTextOutput(result);
			expect(output).toContain("The page content goes here");
		});
	});

	describe("content options", () => {
		it("shows summary when available", async () => {
			const result = await webfetchTool.execute("wf-6", {
				urls: "https://example.com/page",
			});

			const output = getTextOutput(result);
			expect(output).toContain("Page summary");
		});

		it("shows highlights when available", async () => {
			const result = await webfetchTool.execute("wf-7", {
				urls: "https://example.com/page",
			});

			const output = getTextOutput(result);
			expect(output).toContain("Important highlight 1");
			expect(output).toContain("Important highlight 2");
		});
	});

	describe("details metadata", () => {
		it("includes resultsCount in details", async () => {
			const result = await webfetchTool.execute("wf-8", {
				urls: "https://example.com/page",
			});

			const details = result.details as { resultsCount: number };
			expect(details.resultsCount).toBe(1);
		});

		it("includes results array in details", async () => {
			const result = await webfetchTool.execute("wf-9", {
				urls: "https://example.com/page",
			});

			const details = result.details as {
				results: Array<{ title: string; url: string }>;
			};
			expect(details.results).toHaveLength(1);
			expect(details.results[0]!.url).toBe("https://example.com/page");
		});
	});
});
