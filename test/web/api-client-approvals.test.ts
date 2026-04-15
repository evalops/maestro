import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../packages/web/src/services/api-client.js";

declare const global: {
	fetch?: typeof fetch;
};

const originalFetch = global.fetch;

describe("ApiClient approvals", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		global.fetch = originalFetch;
	});

	it("includes sessionId in the approval mode update body", async () => {
		global.fetch = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					success: true,
					mode: "auto",
					message: "Approval mode set to auto",
				}),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			),
		);

		const api = new ApiClient("http://localhost:8080", {
			auth: {
				accessToken: "access-token",
				apiKey: "api-key",
				csrfToken: "csrf-token",
			},
		});
		await api.setApprovalMode("auto", "session-123");

		expect(global.fetch).toHaveBeenCalled();
		const [, init] = vi.mocked(global.fetch).mock.calls[0] ?? [];
		const headers = new Headers((init as RequestInit).headers);
		expect((init as RequestInit).body).toBe(
			JSON.stringify({ mode: "auto", sessionId: "session-123" }),
		);
		expect(headers.get("authorization")).toBe("Bearer access-token");
		expect(headers.get("x-composer-api-key")).toBe("api-key");
		expect(headers.get("x-composer-csrf")).toBe("csrf-token");
	});

	it("posts approval decisions to the chat approval endpoint", async () => {
		global.fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ success: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		const api = new ApiClient("http://localhost:8080", {
			auth: {
				accessToken: "access-token",
				apiKey: "api-key",
				csrfToken: "csrf-token",
			},
		});
		await api.submitApprovalDecision({
			requestId: "req_123",
			decision: "approved",
		});

		expect(global.fetch).toHaveBeenCalled();
		const [url, init] = vi.mocked(global.fetch).mock.calls[0] ?? [];
		const headers = new Headers((init as RequestInit).headers);
		expect(String(url)).toContain("/api/chat/approval");
		expect((init as RequestInit).body).toBe(
			JSON.stringify({ requestId: "req_123", decision: "approved" }),
		);
		expect(headers.get("authorization")).toBe("Bearer access-token");
		expect(headers.get("x-composer-api-key")).toBe("api-key");
		expect(headers.get("x-composer-csrf")).toBe("csrf-token");
	});

	it("posts tool retry decisions to the chat tool-retry endpoint", async () => {
		global.fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ success: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		const api = new ApiClient("http://localhost:8080", {
			auth: {
				accessToken: "access-token",
				apiKey: "api-key",
				csrfToken: "csrf-token",
			},
		});
		await api.submitToolRetryDecision({
			requestId: "retry_123",
			action: "retry",
			reason: "Try again",
		});

		expect(global.fetch).toHaveBeenCalled();
		const [url, init] = vi.mocked(global.fetch).mock.calls[0] ?? [];
		const headers = new Headers((init as RequestInit).headers);
		expect(String(url)).toContain("/api/chat/tool-retry");
		expect((init as RequestInit).body).toBe(
			JSON.stringify({
				requestId: "retry_123",
				action: "retry",
				reason: "Try again",
			}),
		);
		expect(headers.get("authorization")).toBe("Bearer access-token");
		expect(headers.get("x-composer-api-key")).toBe("api-key");
		expect(headers.get("x-composer-csrf")).toBe("csrf-token");
	});
});
