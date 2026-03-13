import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ApiClient,
	ApiClientError,
} from "../../packages/web/src/services/api-client.js";

declare const global: {
	fetch?: typeof fetch;
};

const originalFetch = global.fetch;

describe("ApiClient error handling", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		global.fetch = originalFetch;
	});

	it("surfaces composer error metadata from JSON responses", async () => {
		const payload = {
			error: "Invalid session",
			code: "INVALID_ARGUMENT",
			composer: {
				code: "SESSION_ERROR",
				category: "session",
				severity: "error",
				retriable: false,
				context: { sessionId: "bad" },
			},
		};

		global.fetch = vi.fn().mockImplementation(() => {
			return Promise.resolve(
				new Response(JSON.stringify(payload), {
					status: 400,
					headers: { "content-type": "application/json" },
				}),
			);
		});

		const api = new ApiClient("http://localhost:8080");
		await expect(api.getSession("bad")).rejects.toBeInstanceOf(ApiClientError);

		try {
			await api.getSession("bad");
		} catch (error) {
			expect(error).toBeInstanceOf(ApiClientError);
			const clientError = error as ApiClientError;
			expect(clientError.status).toBe(400);
			expect(clientError.payload?.composer?.code).toBe("SESSION_ERROR");
			expect(clientError.payload?.composer?.category).toBe("session");
		}
	});

	it("preserves structured composer errors for chat stream startup failures", async () => {
		const payload = {
			error: "Approval required",
			code: "POLICY_BLOCKED",
			composer: {
				code: "APPROVAL_REQUIRED",
				category: "permission",
				severity: "error",
				retriable: false,
				context: { sessionId: "session-1" },
			},
		};

		global.fetch = vi.fn().mockImplementation(() => {
			return Promise.resolve(
				new Response(JSON.stringify(payload), {
					status: 403,
					headers: { "content-type": "application/json" },
				}),
			);
		});

		const api = new ApiClient("http://localhost:8080");
		await expect(
			(async () => {
				for await (const _event of api.chatWithEvents({
					messages: [{ role: "user", content: "hi" }],
				})) {
					// consume stream
				}
			})(),
		).rejects.toBeInstanceOf(ApiClientError);

		try {
			for await (const _event of api.chatWithEvents({
				messages: [{ role: "user", content: "hi" }],
			})) {
				// consume stream
			}
		} catch (error) {
			expect(error).toBeInstanceOf(ApiClientError);
			const clientError = error as ApiClientError;
			expect(clientError.status).toBe(403);
			expect(clientError.payload?.composer?.code).toBe("APPROVAL_REQUIRED");
			expect(clientError.payload?.composer?.category).toBe("permission");
		}
	});
});
