import { beforeEach, describe, expect, it, vi } from "vitest";
import { codesearchTool } from "../src/tools/codesearch.js";
import { callExa } from "../src/tools/exa-client.js";
import { webfetchTool } from "../src/tools/webfetch.js";
import { websearchTool } from "../src/tools/websearch.js";

vi.mock("../src/tools/exa-client.js", async () => {
	const actual = (await vi.importActual(
		"../src/tools/exa-client.js",
	)) as typeof import("../src/tools/exa-client.js");
	return {
		...actual,
		callExa: vi.fn(),
	};
});

const mockedCallExa = vi.mocked(callExa);

function getText(result: any): string {
	return (
		result.content
			?.filter((block: any) => block.type === "text")
			.map((block: any) => block.text)
			.join("\n") ?? ""
	);
}

describe("websearch tool", () => {
	beforeEach(() => {
		mockedCallExa.mockReset();
	});

	it("formats context output and forwards advanced options", async () => {
		mockedCallExa.mockResolvedValue({
			requestId: "req-1",
			resolvedSearchType: "auto",
			context: "context block",
			costDollars: { total: 0.004 },
			results: [
				{
					title: "Result",
					url: "https://example.com",
					summary: "Summary text",
					text: "Full text",
				},
			],
		});

		const result = await websearchTool.execute("call-1", {
			query: "react server components",
			livecrawl: "always",
			subpages: { limit: 2 },
			highlights: { numSentences: 2 },
			summary: { target: "news", model: "exa:claude" },
		});

		const requestBody = mockedCallExa.mock.calls[0][1];
		expect(requestBody).toMatchObject({
			livecrawl: "always",
			subpages: { limit: 2 },
			contents: {
				text: true,
				summary: { target: "news", model: "exa:claude" },
				context: true,
				highlights: { numSentences: 2 },
			},
		});

		const text = getText(result);
		expect(text).toContain("LLM-Optimized Context");
		expect(text).toContain("Result");
	});
});

describe("webfetch tool", () => {
	beforeEach(() => {
		mockedCallExa.mockReset();
	});

	it("supports highlight configuration", async () => {
		mockedCallExa.mockResolvedValue({
			results: [
				{
					id: "1",
					url: "https://docs",
					title: "Docs",
					text: "Line one\nLine two",
					summary: "Doc summary",
					highlights: ["Snippet"],
				},
			],
			statuses: [],
		});

		const params = {
			urls: "https://docs",
			highlights: { highlightsPerUrl: 2, numSentences: 4 },
		};
		const result = await webfetchTool.execute("call-2", params);

		const requestBody = mockedCallExa.mock.calls[0][1];
		expect(requestBody).toMatchObject({
			contents: {
				highlights: { highlightsPerUrl: 2, numSentences: 4 },
			},
		});
		expect(getText(result)).toContain("Line one");
	});
});

describe("codesearch tool", () => {
	beforeEach(() => {
		mockedCallExa.mockReset();
	});

	it("normalizes cost and formats response", async () => {
		mockedCallExa.mockResolvedValue({
			requestId: "ctx-1",
			query: "React hook example",
			response: "Code block",
			resultsCount: 3,
			costDollars: JSON.stringify({ total: 0.02 }),
			searchTime: 1500,
			outputTokens: 1200,
		});

		const result = await codesearchTool.execute("call-3", {
			query: "React hook example",
		});

		expect(getText(result)).toContain("Code Examples and Context");
		expect(result.details?.costDollars).toBeCloseTo(0.02);
	});
});
