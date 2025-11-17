import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ExaApiError,
	buildContentsOptions,
	callExa,
} from "../src/tools/exa-client.js";

const originalEnv = { ...process.env };

function mockFetchOnce(response: Partial<Response> & { body?: string }) {
	return {
		ok: response.ok ?? true,
		status: response.status ?? 200,
		text: vi.fn().mockResolvedValue(response.body ?? "{}"),
	} as unknown as Response;
}

describe("callExa", () => {
	beforeEach(() => {
		process.env = { ...originalEnv, EXA_API_KEY: "test-key" };
	});

	afterEach(() => {
		process.env = { ...originalEnv };
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("throws when EXA_API_KEY is missing", async () => {
		process.env.EXA_API_KEY = "";
		await expect(callExa("/search", {})).rejects.toThrow(
			"EXA_API_KEY environment variable is required",
		);
	});

	it("returns parsed data and emits telemetry", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			mockFetchOnce({
				body: JSON.stringify({
					requestId: "req-123",
					costDollars: { total: 0.0123 },
				}),
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const telemetry = vi.fn();
		const result = await callExa(
			"/search",
			{ query: "test" },
			{
				toolName: "websearch",
				onTelemetry: telemetry,
			},
		);

		expect(result).toMatchObject({ requestId: "req-123" });
		expect(fetchMock).toHaveBeenCalledWith("https://api.exa.ai/search", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": "test-key",
			},
			body: JSON.stringify({ query: "test" }),
		});
		expect(telemetry).toHaveBeenCalledWith(
			expect.objectContaining({
				success: true,
				requestId: "req-123",
				costDollars: 0.0123,
			}),
		);
	});

	it("throws ExaApiError with parsed message", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			mockFetchOnce({
				ok: false,
				status: 400,
				body: JSON.stringify({ error: { message: "Invalid query" } }),
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const telemetry = vi.fn();
		await expect(
			callExa("/search", {}, { onTelemetry: telemetry }),
		).rejects.toThrow(ExaApiError);
		expect(telemetry).toHaveBeenCalledWith(
			expect.objectContaining({
				success: false,
				status: 400,
				errorMessage: "Invalid query",
			}),
		);
	});

	it("retries on retryable status and succeeds", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				mockFetchOnce({ ok: false, status: 500, body: "{}" }),
			)
			.mockResolvedValueOnce(
				mockFetchOnce({ body: JSON.stringify({ ok: true }) }),
			);
		vi.stubGlobal("fetch", fetchMock);

		const telemetry = vi.fn();
		await expect(
			callExa("/search", {}, { retries: 1, onTelemetry: telemetry }),
		).resolves.toMatchObject({ ok: true });
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(telemetry).toHaveBeenCalledWith(
			expect.objectContaining({ success: false, status: 500 }),
		);
	});
});

describe("buildContentsOptions", () => {
	it("merges defaults with overrides", () => {
		const contents = buildContentsOptions(
			{ summary: true },
			{ text: true, summary: false },
		);
		expect(contents).toEqual({ text: true, summary: true });
	});

	it("returns undefined when no values provided", () => {
		const contents = buildContentsOptions({}, {});
		expect(contents).toBeUndefined();
	});
});
