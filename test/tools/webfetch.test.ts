import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentToolResult } from "../../src/agent/types.js";

// Mock the exa-client
vi.mock("../../src/tools/exa-client.js", () => ({
	callExa: vi.fn(),
}));

import { callExa } from "../../src/tools/exa-client.js";
import { webfetchTool } from "../../src/tools/webfetch.js";

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

describe("webfetch tool", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("schema validation", () => {
		it("has correct name", () => {
			expect(webfetchTool.name).toBe("webfetch");
		});

		it("has description", () => {
			expect(webfetchTool.description).toBeTruthy();
		});
	});

	describe("single URL fetch", () => {
		it("fetches content from a single URL", async () => {
			mockCallExa.mockResolvedValueOnce({
				results: [
					{
						url: "https://example.com",
						title: "Example Domain",
						text: "This is example content.",
					},
				],
			});

			const result = await webfetchTool.execute("wf-1", {
				urls: "https://example.com",
			});

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("Fetched 1 URL");
			expect(output).toContain("Example Domain");
		});
	});

	describe("multiple URL fetch", () => {
		it("fetches content from multiple URLs", async () => {
			mockCallExa.mockResolvedValueOnce({
				results: [
					{
						url: "https://example1.com",
						title: "Example 1",
						text: "Content 1",
					},
					{
						url: "https://example2.com",
						title: "Example 2",
						text: "Content 2",
					},
				],
			});

			const result = await webfetchTool.execute("wf-2", {
				urls: ["https://example1.com", "https://example2.com"],
			});

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("Fetched 2 URL");
		});
	});

	describe("error handling", () => {
		it("handles fetch errors gracefully", async () => {
			mockCallExa.mockResolvedValueOnce({
				results: [],
				statuses: [
					{
						id: "https://example.com",
						status: "error",
						error: {
							tag: "FetchError",
							httpStatusCode: 404,
						},
					},
				],
			});

			const result = await webfetchTool.execute("wf-3", {
				urls: "https://example.com",
			});

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("WARN");
			expect(output).toContain("failed to fetch");
		});

		it("handles network errors", async () => {
			// Use mockRejectedValue (not Once) to cover all retry attempts
			// Fast-forward retry delays to keep test runtime low.
			vi.useFakeTimers();
			try {
				mockCallExa.mockRejectedValue(new Error("Network timeout"));

				const promise = webfetchTool.execute("wf-4", {
					urls: "https://example.com",
				});
				const rejection = expect(promise).rejects.toThrow("Network timeout");
				await vi.runAllTimersAsync();
				await rejection;
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe("content options", () => {
		it("supports text option", async () => {
			mockCallExa.mockResolvedValueOnce({
				results: [
					{
						url: "https://example.com",
						title: "Example",
						text: "Full text content here",
					},
				],
			});

			const result = await webfetchTool.execute("wf-5", {
				urls: "https://example.com",
				text: true,
			});

			expect(result.isError).toBeFalsy();
			expect(mockCallExa).toHaveBeenCalledWith(
				"/contents",
				expect.objectContaining({ ids: ["https://example.com"] }),
				expect.any(Object),
			);
		});

		it("supports summary option", async () => {
			mockCallExa.mockResolvedValueOnce({
				results: [
					{
						url: "https://example.com",
						title: "Example",
						summary: "This is a summary of the content.",
					},
				],
			});

			const result = await webfetchTool.execute("wf-6", {
				urls: "https://example.com",
				summary: true,
			});

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("Summary");
		});

		it("supports highlights option", async () => {
			mockCallExa.mockResolvedValueOnce({
				results: [
					{
						url: "https://example.com",
						title: "Example",
						highlights: ["Important point 1", "Important point 2"],
					},
				],
			});

			const result = await webfetchTool.execute("wf-7", {
				urls: "https://example.com",
				highlights: true,
			});

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("Highlights");
		});
	});

	describe("content truncation", () => {
		it("truncates long content", async () => {
			const longText = "A".repeat(5000);
			mockCallExa.mockResolvedValueOnce({
				results: [
					{
						url: "https://example.com",
						title: "Example",
						text: longText,
					},
				],
			});

			const result = await webfetchTool.execute("wf-8", {
				urls: "https://example.com",
			});

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("truncated");
		});

		it("truncates output when many URLs", async () => {
			const results = Array.from({ length: 20 }, (_, i) => ({
				url: `https://example${i}.com`,
				title: `Example ${i}`,
				text: "A".repeat(500),
			}));

			mockCallExa.mockResolvedValueOnce({ results });

			const result = await webfetchTool.execute("wf-9", {
				urls: results.map((r) => r.url),
			});

			expect(result.isError).toBeFalsy();
		});
	});

	describe("retry behavior", () => {
		it("retries on network errors", async () => {
			vi.useFakeTimers();
			try {
				mockCallExa
					.mockRejectedValueOnce(new Error("fetch failed"))
					.mockResolvedValueOnce({
						results: [
							{
								url: "https://example.com",
								title: "Example",
								text: "Content",
							},
						],
					});

				const promise = webfetchTool.execute("wf-10", {
					urls: "https://example.com",
				});
				const resolved = promise.then((result) => {
					expect(result.isError).toBeFalsy();
					expect(mockCallExa).toHaveBeenCalledTimes(2);
				});

				await vi.runAllTimersAsync();
				await resolved;
			} finally {
				vi.useRealTimers();
			}
		});
	});
});
