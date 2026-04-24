import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionApprovalService } from "../../src/agent/action-approval.js";
import { ToolRetryService } from "../../src/agent/tool-retry.js";
import type { WebServerContext } from "../../src/server/app-context.js";
import { handlePendingRequestResume } from "../../src/server/handlers/pending-requests.js";
import { serverRequestManager } from "../../src/server/server-request-manager.js";

const cors = { "Access-Control-Allow-Origin": "*" };

interface MockResponse {
	statusCode: number;
	headers: Record<string, string | number>;
	body: string;
	writableEnded: boolean;
	writeHead(status: number, headers?: Record<string, string | number>): void;
	write(chunk: string | Buffer): void;
	end(chunk?: string | Buffer): void;
}

interface MockRequest extends PassThrough {
	method: string;
	url: string;
	headers: Record<string, string>;
}

function makeReq(body: unknown): MockRequest {
	const req = new PassThrough() as MockRequest;
	req.method = "POST";
	req.url = "/api/pending-requests/request/resume";
	req.headers = {};
	req.end(JSON.stringify(body));
	return req;
}

function makeRes(): MockResponse {
	return {
		statusCode: 200,
		headers: {},
		body: "",
		writableEnded: false,
		writeHead(status: number, headers?: Record<string, string | number>) {
			this.statusCode = status;
			this.headers = headers ?? {};
		},
		write(chunk: string | Buffer) {
			this.body += chunk.toString();
		},
		end(chunk?: string | Buffer) {
			if (chunk) this.write(chunk);
			this.writableEnded = true;
		},
	};
}

async function resume(requestId: string, body: unknown) {
	const req = makeReq(body);
	const res = makeRes();
	await handlePendingRequestResume(
		req,
		res,
		{ corsHeaders: cors } as WebServerContext,
		{ requestId: encodeURIComponent(requestId) },
	);
	return res;
}

describe("handlePendingRequestResume", () => {
	afterEach(() => {
		for (const request of serverRequestManager.listPending()) {
			serverRequestManager.cancel(request.id, "test cleanup", "runtime");
		}
		vi.restoreAllMocks();
	});

	it("resumes Platform-backed approvals through the unified endpoint", async () => {
		const service = new ActionApprovalService("prompt");
		const resolve = vi.spyOn(service, "resolve").mockReturnValue(true);
		serverRequestManager.registerApproval({
			sessionId: "session-platform",
			request: {
				id: "approval-platform",
				toolName: "bash",
				args: { command: "deploy" },
				reason: "Needs approval",
				platform: {
					source: "tool_execution",
					toolExecutionId: "texec-1",
					approvalRequestId: "approval-platform",
				},
			},
			service,
		});

		const res = await resume("approval-platform", {
			kind: "approval",
			sessionId: "session-platform",
			decision: "approved",
			reason: "Looks good",
		});

		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body)).toEqual({
			success: true,
			request: {
				id: "approval-platform",
				kind: "approval",
				sessionId: "session-platform",
				resolution: "approved",
				source: "platform",
				platform: {
					source: "tool_execution",
					toolExecutionId: "texec-1",
					approvalRequestId: "approval-platform",
				},
				platformOperation: "ResumeToolExecution",
			},
		});
		expect(resolve).toHaveBeenCalledWith("approval-platform", {
			approved: true,
			reason: "Looks good",
			resolvedBy: "user",
		});
		expect(serverRequestManager.get("approval-platform")).toBeUndefined();
	});

	it("resumes client-side prompts without the caller knowing the legacy endpoint", async () => {
		const resolve = vi.fn().mockReturnValue(true);
		serverRequestManager.registerClientTool({
			id: "ask-user-1",
			sessionId: "session-client",
			toolName: "ask_user",
			args: { question: "Continue?" },
			kind: "user_input",
			resolve,
			cancel: vi.fn().mockReturnValue(true),
		});

		const res = await resume("ask-user-1", {
			sessionId: "session-client",
			content: [{ type: "text", text: "Yes" }],
			isError: false,
		});

		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body)).toEqual({
			success: true,
			request: {
				id: "ask-user-1",
				kind: "user_input",
				sessionId: "session-client",
				resolution: "answered",
				source: "local",
			},
		});
		expect(resolve).toHaveBeenCalledWith(
			[{ type: "text", text: "Yes" }],
			false,
		);
	});

	it("resumes tool retry requests from the same endpoint", async () => {
		const service = new ToolRetryService("prompt");
		const retry = vi.spyOn(service, "retry").mockReturnValue(true);
		serverRequestManager.registerToolRetry({
			sessionId: "session-retry",
			request: {
				id: "retry-1",
				toolCallId: "tool-call-1",
				toolName: "bash",
				args: { command: "make test" },
				errorMessage: "Timed out",
				attempt: 1,
			},
			service,
		});

		const res = await resume("retry-1", {
			kind: "tool_retry",
			action: "retry",
			reason: "Try again",
		});

		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body).request).toMatchObject({
			id: "retry-1",
			kind: "tool_retry",
			sessionId: "session-retry",
			resolution: "retried",
			source: "local",
		});
		expect(retry).toHaveBeenCalledWith("retry-1", "Try again", "user");
	});

	it("rejects resume attempts for a different session", async () => {
		const service = new ActionApprovalService("prompt");
		vi.spyOn(service, "resolve").mockReturnValue(true);
		serverRequestManager.registerApproval({
			sessionId: "session-owner",
			request: {
				id: "approval-owner",
				toolName: "bash",
				args: {},
				reason: "Needs approval",
			},
			service,
		});

		const res = await resume("approval-owner", {
			kind: "approval",
			sessionId: "session-other",
			decision: "approved",
		});

		expect(res.statusCode).toBe(404);
		expect(JSON.parse(res.body)).toMatchObject({
			error: "Pending request not found for session",
		});
		expect(serverRequestManager.get("approval-owner")).toBeDefined();
	});
});
