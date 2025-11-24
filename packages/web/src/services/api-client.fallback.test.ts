import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./api-client.js";

declare const global: any;

const makeJsonResponse = (body: unknown) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});

const originalWindow = global.window;
const originalFetch = global.fetch;

describe("ApiClient fallback resolution", () => {
	beforeEach(() => {
		// Provide a window origin so fallbacks include both origin and localhost.
		global.window = { location: { origin: "https://app.test" } };
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (originalWindow === undefined) global.window = undefined;
		else global.window = originalWindow;
		global.fetch = originalFetch;
	});

	it("falls back to secondary base when the primary fetch fails", async () => {
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(new Error("primary failed"))
			.mockResolvedValueOnce(makeJsonResponse({ id: "m", provider: "p" }));

		global.fetch = fetchMock;

		const api = new ApiClient();
		const model = await api.getCurrentModel();

		expect(model?.id).toBe("m");
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(String(fetchMock.mock.calls[0][0])).toContain("https://app.test");
		expect(String(fetchMock.mock.calls[1][0])).toContain(
			"http://localhost:8080",
		);
	});
});
