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

	it("posts approval decisions to the unified pending request resume endpoint", async () => {
		global.fetch = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					success: true,
					request: {
						id: "req_123",
						kind: "approval",
						resolution: "approved",
						source: "local",
					},
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
		await api.submitApprovalDecision({
			requestId: "req_123",
			decision: "approved",
		});

		expect(global.fetch).toHaveBeenCalled();
		const [url, init] = vi.mocked(global.fetch).mock.calls[0] ?? [];
		const headers = new Headers((init as RequestInit).headers);
		expect(String(url)).toContain("/api/pending-requests/req_123/resume");
		expect((init as RequestInit).body).toBe(
			JSON.stringify({ kind: "approval", decision: "approved" }),
		);
		expect(headers.get("authorization")).toBe("Bearer access-token");
		expect(headers.get("x-composer-api-key")).toBe("api-key");
		expect(headers.get("x-composer-csrf")).toBe("csrf-token");
	});

	it("posts tool retry decisions to the unified pending request resume endpoint", async () => {
		global.fetch = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					success: true,
					request: {
						id: "retry_123",
						kind: "tool_retry",
						resolution: "retried",
						source: "local",
					},
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
		await api.submitToolRetryDecision({
			requestId: "retry_123",
			action: "retry",
			reason: "Try again",
		});

		expect(global.fetch).toHaveBeenCalled();
		const [url, init] = vi.mocked(global.fetch).mock.calls[0] ?? [];
		const headers = new Headers((init as RequestInit).headers);
		expect(String(url)).toContain("/api/pending-requests/retry_123/resume");
		expect((init as RequestInit).body).toBe(
			JSON.stringify({
				kind: "tool_retry",
				action: "retry",
				reason: "Try again",
			}),
		);
		expect(headers.get("authorization")).toBe("Bearer access-token");
		expect(headers.get("x-composer-api-key")).toBe("api-key");
		expect(headers.get("x-composer-csrf")).toBe("csrf-token");
	});

	it("posts client tool results to the unified pending request resume endpoint", async () => {
		global.fetch = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					success: true,
					request: {
						id: "tool_call_123",
						kind: "user_input",
						resolution: "answered",
						source: "local",
					},
				}),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			),
		);

		const api = new ApiClient("http://localhost:8080");
		await api.sendClientToolResult({
			toolCallId: "tool_call_123",
			content: [{ type: "text", text: "done" }],
			isError: false,
		});

		expect(global.fetch).toHaveBeenCalled();
		const [url, init] = vi.mocked(global.fetch).mock.calls[0] ?? [];
		expect(String(url)).toContain("/api/pending-requests/tool_call_123/resume");
		expect((init as RequestInit).body).toBe(
			JSON.stringify({
				content: [{ type: "text", text: "done" }],
				isError: false,
			}),
		);
	});
});
