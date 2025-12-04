import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentToolResult } from "../../src/agent/types.js";
import { websearchTool } from "../../src/tools/websearch.js";

// Mock the exa-client
vi.mock("../../src/tools/exa-client.js", () => ({
	callExa: vi.fn(),
	normalizeCostDollars: vi.fn((cost) => cost),
}));

import { callExa } from "../../src/tools/exa-client.js";

const mockCallExa = vi.mocked(callExa);

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
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("schema validation", () => {
		it("has correct name", () => {
			expect(websearchTool.name).toBe("websearch");
		});

		it("has description", () => {
			expect(websearchTool.description).toBeTruthy();
		});
	});

	describe("basic search", () => {
		it("searches with query", async () => {
			mockCallExa.mockResolvedValueOnce({
				requestId: "req-123",
				resolvedSearchType: "auto",
				results: [
					{
						url: "https://example.com",
						title: "Example Result",
						score: 0.95,
					},
				],
			});

			const result = await websearchTool.execute("ws-1", {
				query: "test query",
			});

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("test query");
			expect(output).toContain("Found 1 result");
		});

		it("returns multiple results", async () => {
			mockCallExa.mockResolvedValueOnce({
				requestId: "req-124",
				resolvedSearchType: "neural",
				results: [
					{ url: "https://example1.com", title: "Result 1", score: 0.9 },
					{ url: "https://example2.com", title: "Result 2", score: 0.8 },
					{ url: "https://example3.com", title: "Result 3", score: 0.7 },
				],
			});

			const result = await websearchTool.execute("ws-2", {
				query: "test query",
				numResults: 3,
			});

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("Found 3 results");
		});
	});

	describe("search types", () => {
		it("supports neural search", async () => {
			mockCallExa.mockResolvedValueOnce({
				requestId: "req-125",
				resolvedSearchType: "neural",
				results: [],
			});

			await websearchTool.execute("ws-3", {
				query: "test",
				type: "neural",
			});

			expect(mockCallExa).toHaveBeenCalledWith(
				"/search",
				expect.objectContaining({ type: "neural" }),
				expect.any(Object),
			);
		});

		it("supports keyword search", async () => {
			mockCallExa.mockResolvedValueOnce({
				requestId: "req-126",
				resolvedSearchType: "keyword",
				results: [],
			});

			await websearchTool.execute("ws-4", {
				query: "test",
				type: "keyword",
			});

			expect(mockCallExa).toHaveBeenCalledWith(
				"/search",
				expect.objectContaining({ type: "keyword" }),
				expect.any(Object),
			);
		});

		it("supports fast search", async () => {
			mockCallExa.mockResolvedValueOnce({
				requestId: "req-127",
				resolvedSearchType: "fast",
				results: [],
			});

			await websearchTool.execute("ws-5", {
				query: "test",
				type: "fast",
			});

			expect(mockCallExa).toHaveBeenCalledWith(
				"/search",
				expect.objectContaining({ type: "fast" }),
				expect.any(Object),
			);
		});
	});

	describe("filters", () => {
		it("supports category filter", async () => {
			mockCallExa.mockResolvedValueOnce({
				requestId: "req-128",
				resolvedSearchType: "auto",
				results: [],
			});

			await websearchTool.execute("ws-6", {
				query: "test",
				category: "news",
			});

			expect(mockCallExa).toHaveBeenCalledWith(
				"/search",
				expect.objectContaining({ category: "news" }),
				expect.any(Object),
			);
		});

		it("supports includeDomains filter", async () => {
			mockCallExa.mockResolvedValueOnce({
				requestId: "req-129",
				resolvedSearchType: "auto",
				results: [],
			});

			await websearchTool.execute("ws-7", {
				query: "test",
				includeDomains: ["example.com", "test.com"],
			});

			expect(mockCallExa).toHaveBeenCalledWith(
				"/search",
				expect.objectContaining({
					includeDomains: ["example.com", "test.com"],
				}),
				expect.any(Object),
			);
		});

		it("supports excludeDomains filter", async () => {
			mockCallExa.mockResolvedValueOnce({
				requestId: "req-130",
				resolvedSearchType: "auto",
				results: [],
			});

			await websearchTool.execute("ws-8", {
				query: "test",
				excludeDomains: ["spam.com"],
			});

			expect(mockCallExa).toHaveBeenCalledWith(
				"/search",
				expect.objectContaining({ excludeDomains: ["spam.com"] }),
				expect.any(Object),
			);
		});

		it("supports date filters", async () => {
			mockCallExa.mockResolvedValueOnce({
				requestId: "req-131",
				resolvedSearchType: "auto",
				results: [],
			});

			await websearchTool.execute("ws-9", {
				query: "test",
				startPublishedDate: "2024-01-01",
				endPublishedDate: "2024-12-31",
			});

			expect(mockCallExa).toHaveBeenCalledWith(
				"/search",
				expect.objectContaining({
					startPublishedDate: "2024-01-01",
					endPublishedDate: "2024-12-31",
				}),
				expect.any(Object),
			);
		});
	});

	describe("content options", () => {
		it("supports text option", async () => {
			mockCallExa.mockResolvedValueOnce({
				requestId: "req-132",
				resolvedSearchType: "auto",
				results: [
					{
						url: "https://example.com",
						title: "Result",
						text: "Full text content",
					},
				],
			});

			const result = await websearchTool.execute("ws-10", {
				query: "test",
				text: true,
			});

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("Text:");
		});

		it("supports summary option", async () => {
			mockCallExa.mockResolvedValueOnce({
				requestId: "req-133",
				resolvedSearchType: "auto",
				results: [
					{
						url: "https://example.com",
						title: "Result",
						summary: "A brief summary",
					},
				],
			});

			const result = await websearchTool.execute("ws-11", {
				query: "test",
				summary: true,
			});

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("Summary:");
		});

		it("supports context option", async () => {
			mockCallExa.mockResolvedValueOnce({
				requestId: "req-134",
				resolvedSearchType: "auto",
				context: "LLM-optimized context string",
				results: [],
			});

			const result = await websearchTool.execute("ws-12", {
				query: "test",
				context: true,
			});

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("LLM-Optimized Context");
		});

		it("supports highlights option", async () => {
			mockCallExa.mockResolvedValueOnce({
				requestId: "req-135",
				resolvedSearchType: "auto",
				results: [
					{
						url: "https://example.com",
						title: "Result",
						highlights: ["Key point 1", "Key point 2"],
					},
				],
			});

			const result = await websearchTool.execute("ws-13", {
				query: "test",
				highlights: true,
			});

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("Highlights:");
		});
	});

	describe("livecrawl options", () => {
		it("supports never livecrawl", async () => {
			mockCallExa.mockResolvedValueOnce({
				requestId: "req-136",
				resolvedSearchType: "auto",
				results: [],
			});

			await websearchTool.execute("ws-14", {
				query: "test",
				livecrawl: "never",
			});

			expect(mockCallExa).toHaveBeenCalledWith(
				"/search",
				expect.objectContaining({ livecrawl: "never" }),
				expect.any(Object),
			);
		});

		it("supports always livecrawl", async () => {
			mockCallExa.mockResolvedValueOnce({
				requestId: "req-137",
				resolvedSearchType: "auto",
				results: [],
			});

			await websearchTool.execute("ws-15", {
				query: "test",
				livecrawl: "always",
			});

			expect(mockCallExa).toHaveBeenCalledWith(
				"/search",
				expect.objectContaining({ livecrawl: "always" }),
				expect.any(Object),
			);
		});
	});

	describe("subpages options", () => {
		it("supports subpages crawling", async () => {
			mockCallExa.mockResolvedValueOnce({
				requestId: "req-138",
				resolvedSearchType: "auto",
				results: [],
			});

			await websearchTool.execute("ws-16", {
				query: "test",
				subpages: { limit: 5, depth: 2 },
			});

			expect(mockCallExa).toHaveBeenCalledWith(
				"/search",
				expect.objectContaining({ subpages: { limit: 5, depth: 2 } }),
				expect.any(Object),
			);
		});
	});

	describe("cost tracking", () => {
		it("displays cost when available", async () => {
			mockCallExa.mockResolvedValueOnce({
				requestId: "req-139",
				resolvedSearchType: "auto",
				costDollars: 0.0015,
				results: [],
			});

			const result = await websearchTool.execute("ws-17", {
				query: "test",
			});

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("Cost:");
		});
	});

	describe("result metadata", () => {
		it("displays published date", async () => {
			mockCallExa.mockResolvedValueOnce({
				requestId: "req-140",
				resolvedSearchType: "auto",
				results: [
					{
						url: "https://example.com",
						title: "Result",
						publishedDate: "2024-06-15T00:00:00Z",
					},
				],
			});

			const result = await websearchTool.execute("ws-18", {
				query: "test",
			});

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("Published:");
		});

		it("displays author", async () => {
			mockCallExa.mockResolvedValueOnce({
				requestId: "req-141",
				resolvedSearchType: "auto",
				results: [
					{
						url: "https://example.com",
						title: "Result",
						author: "John Doe",
					},
				],
			});

			const result = await websearchTool.execute("ws-19", {
				query: "test",
			});

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("Author:");
		});
	});

	describe("truncation", () => {
		it("truncates long text results", async () => {
			const longText = "A".repeat(1500);
			mockCallExa.mockResolvedValueOnce({
				requestId: "req-142",
				resolvedSearchType: "auto",
				results: [
					{
						url: "https://example.com",
						title: "Result",
						text: longText,
					},
				],
			});

			const result = await websearchTool.execute("ws-20", {
				query: "test",
			});

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("truncated");
		});
	});

	describe("error handling", () => {
		it("handles API errors", async () => {
			mockCallExa.mockRejectedValueOnce(new Error("API rate limit exceeded"));

			await expect(
				websearchTool.execute("ws-21", {
					query: "test",
				}),
			).rejects.toThrow("API rate limit exceeded");
		});
	});
});
