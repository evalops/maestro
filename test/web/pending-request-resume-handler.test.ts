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
	return resumeWithContext(requestId, body, {});
}

async function resumeWithContext(
	requestId: string,
	body: unknown,
	context: Partial<WebServerContext> & Record<string, unknown>,
) {
	const req = makeReq(body);
	const res = makeRes();
	await handlePendingRequestResume(
		req,
		res,
		{ corsHeaders: cors, ...context } as WebServerContext,
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
		vi.useRealTimers();
	});

	it("resolves ToolExecution-backed approvals locally without replaying Platform", async () => {
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

		const res = await resumeWithContext(
			"approval-platform",
			{
				kind: "approval",
				sessionId: "session-platform",
				decision: "approved",
				reason: "Looks good",
			},
			{},
		);

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
			},
		});
		expect(resolve).toHaveBeenCalledWith("approval-platform", {
			approved: true,
			reason: "Looks good",
			resolvedBy: "user",
			resolvedAtMs: expect.any(Number),
		});
		expect(serverRequestManager.get("approval-platform")).toBeUndefined();
	});

	it("keeps ToolExecution resume tokens out of pending approval snapshots", async () => {
		const service = new ActionApprovalService("prompt");
		serverRequestManager.registerApproval({
			sessionId: "session-platform-private",
			request: {
				id: "approval-platform-private",
				toolName: "bash",
				args: { command: "deploy" },
				reason: "Needs approval",
				platform: {
					source: "tool_execution",
					toolExecutionId: "texec-private",
					approvalRequestId: "approval-platform-private",
				},
			},
			service,
		});

		expect(serverRequestManager.get("approval-platform-private")).toMatchObject(
			{
				platform: {
					source: "tool_execution",
					toolExecutionId: "texec-private",
					approvalRequestId: "approval-platform-private",
				},
			},
		);
	});

	it("claims hosted user-input waits before Platform AgentRuntime resume", async () => {
		const resolve = vi.fn().mockReturnValue(true);
		const resumeRun = vi.fn().mockImplementation(() => {
			expect(serverRequestManager.get("ask-user-platform-1")).toBeUndefined();
			expect(resolve).toHaveBeenCalledWith(
				[{ type: "text", text: "Yes" }],
				false,
			);
			return Promise.resolve({
				run: { id: "run_1" },
				event: { id: "event_resume" },
			});
		});
		serverRequestManager.registerClientTool({
			id: "ask-user-platform-1",
			sessionId: "session-platform-wait",
			toolName: "ask_user",
			args: { question: "Continue?" },
			kind: "user_input",
			resolve,
			cancel: vi.fn().mockReturnValue(true),
		});

		const res = await resumeWithContext(
			"ask-user-platform-1",
			{
				sessionId: "session-platform-wait",
				content: [{ type: "text", text: "Yes" }],
			},
			{
				hostedRunner: {
					enabled: true,
					runnerSessionId: "runner_1",
					workspaceRoot: "/workspace",
					agentRunId: "run_1",
					activeMaestroSessionId: "session-platform-wait",
				},
				platformPendingRequestResume: { resumeRun },
			},
		);

		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body)).toMatchObject({
			success: true,
			request: {
				id: "ask-user-platform-1",
				kind: "user_input",
				sessionId: "session-platform-wait",
				resolution: "answered",
				source: "platform",
				platformOperation: "ResumeRun",
			},
		});
		expect(resumeRun).toHaveBeenCalledWith({
			runId: "run_1",
			waitId: "maestro:session-platform-wait:wait:ask-user-platform-1",
			resumeEventId: "maestro:session-platform-wait:resume:ask-user-platform-1",
			payload: expect.objectContaining({
				maestro_session_id: "session-platform-wait",
				request_id: "ask-user-platform-1",
				request_type: "user_input",
				resolution: "answered",
				resolved_by: "user",
				content: [{ type: "text", text: "Yes" }],
			}),
		});
		expect(resolve).toHaveBeenCalledWith(
			[{ type: "text", text: "Yes" }],
			false,
		);
	});

	it("returns local success when hosted user-input Platform resume aborts after local resolution", async () => {
		const resolve = vi.fn().mockReturnValue(true);
		const abortError = new Error("aborted");
		abortError.name = "AbortError";
		const resumeRun = vi.fn().mockRejectedValue(abortError);
		serverRequestManager.registerClientTool({
			id: "ask-user-platform-abort",
			sessionId: "session-platform-wait-abort",
			toolName: "ask_user",
			args: { question: "Continue?" },
			kind: "user_input",
			resolve,
			cancel: vi.fn().mockReturnValue(true),
		});

		const body = {
			sessionId: "session-platform-wait-abort",
			content: [{ type: "text", text: "Yes" }],
		};

		const res = await resumeWithContext("ask-user-platform-abort", body, {
			hostedRunner: {
				enabled: true,
				runnerSessionId: "runner_1",
				workspaceRoot: "/workspace",
				agentRunId: "run_1",
				activeMaestroSessionId: "session-platform-wait-abort",
			},
			platformPendingRequestResume: { resumeRun },
		});
		const retry = await resumeWithContext("ask-user-platform-abort", body, {
			hostedRunner: {
				enabled: true,
				runnerSessionId: "runner_1",
				workspaceRoot: "/workspace",
				agentRunId: "run_1",
				activeMaestroSessionId: "session-platform-wait-abort",
			},
			platformPendingRequestResume: { resumeRun },
		});

		expect(res.statusCode).toBe(200);
		expect(retry.statusCode).toBe(200);
		expect(JSON.parse(retry.body)).toEqual(JSON.parse(res.body));
		expect(JSON.parse(res.body)).toMatchObject({
			success: true,
			request: {
				id: "ask-user-platform-abort",
				kind: "user_input",
				resolution: "answered",
				source: "local",
			},
		});
		expect(resolve).toHaveBeenCalledWith(
			[{ type: "text", text: "Yes" }],
			false,
		);
		expect(resumeRun).toHaveBeenCalledTimes(1);
		expect(serverRequestManager.get("ask-user-platform-abort")).toBeUndefined();
	});

	it("caches local success when hosted user-input Platform resume fails after local resolution", async () => {
		const resolve = vi.fn().mockReturnValue(true);
		const resumeRun = vi
			.fn()
			.mockRejectedValueOnce(new Error("network down"))
			.mockResolvedValueOnce({
				run: { id: "run_1" },
				event: { id: "event_resume" },
			});
		serverRequestManager.registerClientTool({
			id: "ask-user-platform-fail-after-local",
			sessionId: "session-platform-wait-fail-after-local",
			toolName: "ask_user",
			args: { question: "Continue?" },
			kind: "user_input",
			resolve,
			cancel: vi.fn().mockReturnValue(true),
		});
		const context = {
			hostedRunner: {
				enabled: true,
				runnerSessionId: "runner_1",
				workspaceRoot: "/workspace",
				agentRunId: "run_1",
				activeMaestroSessionId: "session-platform-wait-fail-after-local",
			},
			platformPendingRequestResume: { resumeRun },
		};
		const body = {
			sessionId: "session-platform-wait-fail-after-local",
			content: [{ type: "text", text: "Yes" }],
		};

		const failed = await resumeWithContext(
			"ask-user-platform-fail-after-local",
			body,
			context,
		);
		const retry = await resumeWithContext(
			"ask-user-platform-fail-after-local",
			body,
			context,
		);

		expect(failed.statusCode).toBe(502);
		expect(JSON.parse(failed.body)).toMatchObject({
			error:
				"Platform AgentRuntime resume failed; local pending request was resolved",
		});
		expect(retry.statusCode).toBe(200);
		expect(JSON.parse(retry.body)).toMatchObject({
			success: true,
			request: {
				id: "ask-user-platform-fail-after-local",
				kind: "user_input",
				resolution: "answered",
				source: "platform",
				platformOperation: "ResumeRun",
			},
		});
		expect(resolve).toHaveBeenCalledTimes(1);
		expect(resumeRun).toHaveBeenCalledTimes(2);
	});

	it("keeps hosted Platform retry recovery available beyond the duplicate-submit cache ttl", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-05-08T00:00:00.000Z"));
		const resolve = vi.fn().mockReturnValue(true);
		const resumeRun = vi
			.fn()
			.mockRejectedValueOnce(new Error("network down"))
			.mockResolvedValueOnce({
				run: { id: "run_1" },
				event: { id: "event_resume" },
			});
		serverRequestManager.registerClientTool({
			id: "ask-user-platform-long-retry",
			sessionId: "session-platform-long-retry",
			toolName: "ask_user",
			args: { question: "Continue?" },
			kind: "user_input",
			resolve,
			cancel: vi.fn().mockReturnValue(true),
		});
		const context = {
			hostedRunner: {
				enabled: true,
				runnerSessionId: "runner_1",
				workspaceRoot: "/workspace",
				agentRunId: "run_1",
				activeMaestroSessionId: "session-platform-long-retry",
			},
			platformPendingRequestResume: { resumeRun },
		};
		const body = {
			sessionId: "session-platform-long-retry",
			content: [{ type: "text", text: "Yes" }],
		};

		const failed = await resumeWithContext(
			"ask-user-platform-long-retry",
			body,
			context,
		);
		vi.setSystemTime(new Date("2026-05-08T00:02:00.000Z"));
		const retry = await resumeWithContext(
			"ask-user-platform-long-retry",
			body,
			context,
		);

		expect(failed.statusCode).toBe(502);
		expect(retry.statusCode).toBe(200);
		expect(JSON.parse(retry.body)).toMatchObject({
			success: true,
			request: {
				id: "ask-user-platform-long-retry",
				kind: "user_input",
				resolution: "answered",
				source: "platform",
				platformOperation: "ResumeRun",
			},
		});
		expect(resolve).toHaveBeenCalledTimes(1);
		expect(resumeRun).toHaveBeenCalledTimes(2);
	});

	it("coalesces concurrent cached hosted Platform retry replays", async () => {
		const resolve = vi.fn().mockReturnValue(true);
		let resolvePlatform!: () => void;
		const resumeRun = vi
			.fn()
			.mockRejectedValueOnce(new Error("network down"))
			.mockImplementationOnce(
				() =>
					new Promise((resolveResume) => {
						resolvePlatform = () =>
							resolveResume({
								run: { id: "run_1" },
								event: { id: "event_resume" },
							});
					}),
			);
		serverRequestManager.registerClientTool({
			id: "ask-user-platform-cached-concurrent",
			sessionId: "session-platform-cached-concurrent",
			toolName: "ask_user",
			args: { question: "Continue?" },
			kind: "user_input",
			resolve,
			cancel: vi.fn().mockReturnValue(true),
		});
		const context = {
			hostedRunner: {
				enabled: true,
				runnerSessionId: "runner_1",
				workspaceRoot: "/workspace",
				agentRunId: "run_1",
				activeMaestroSessionId: "session-platform-cached-concurrent",
			},
			platformPendingRequestResume: { resumeRun },
		};
		const body = {
			sessionId: "session-platform-cached-concurrent",
			content: [{ type: "text", text: "Yes" }],
		};

		const failed = await resumeWithContext(
			"ask-user-platform-cached-concurrent",
			body,
			context,
		);
		const firstRetryPromise = resumeWithContext(
			"ask-user-platform-cached-concurrent",
			body,
			context,
		);
		await new Promise((resolve) => setImmediate(resolve));
		const secondRetryPromise = resumeWithContext(
			"ask-user-platform-cached-concurrent",
			{ content: [{ type: "text", text: "Yes" }] },
			context,
		);
		resolvePlatform();
		const [firstRetry, secondRetry] = await Promise.all([
			firstRetryPromise,
			secondRetryPromise,
		]);

		expect(failed.statusCode).toBe(502);
		expect(firstRetry.statusCode).toBe(200);
		expect(secondRetry.statusCode).toBe(200);
		expect(JSON.parse(secondRetry.body)).toEqual(JSON.parse(firstRetry.body));
		expect(resolve).toHaveBeenCalledTimes(1);
		expect(resumeRun).toHaveBeenCalledTimes(2);
	});

	it("returns cached success for duplicate hosted wait submits without replaying Platform", async () => {
		const resolve = vi.fn().mockReturnValue(true);
		const resumeRun = vi.fn().mockResolvedValue({
			run: { id: "run_1" },
			event: { id: "event_resume" },
		});
		serverRequestManager.registerClientTool({
			id: "ask-user-platform-duplicate",
			sessionId: "session-platform-duplicate",
			toolName: "ask_user",
			args: { question: "Continue?" },
			kind: "user_input",
			resolve,
			cancel: vi.fn().mockReturnValue(true),
		});
		const context = {
			hostedRunner: {
				enabled: true,
				runnerSessionId: "runner_1",
				workspaceRoot: "/workspace",
				agentRunId: "run_1",
				activeMaestroSessionId: "session-platform-duplicate",
			},
			platformPendingRequestResume: { resumeRun },
		};
		const firstBody = {
			kind: "user_input",
			sessionId: "session-platform-duplicate",
			content: [{ type: "text", text: "Yes" }],
		};
		const retryBody = {
			content: [{ type: "text", text: "Yes" }],
		};

		const first = await resumeWithContext(
			"ask-user-platform-duplicate",
			firstBody,
			context,
		);
		const second = await resumeWithContext(
			"ask-user-platform-duplicate",
			retryBody,
			context,
		);
		const conflicting = await resumeWithContext(
			"ask-user-platform-duplicate",
			{ ...retryBody, isError: true },
			context,
		);
		const changedContent = await resumeWithContext(
			"ask-user-platform-duplicate",
			{
				...retryBody,
				content: [{ type: "text", text: "Actually, no" }],
			},
			context,
		);
		const mismatchedSession = await resumeWithContext(
			"ask-user-platform-duplicate",
			{
				kind: "user_input",
				sessionId: "session-other",
				content: [{ type: "text", text: "Yes" }],
			},
			context,
		);

		expect(first.statusCode).toBe(200);
		expect(second.statusCode).toBe(200);
		expect(conflicting.statusCode).toBe(404);
		expect(changedContent.statusCode).toBe(404);
		expect(mismatchedSession.statusCode).toBe(404);
		expect(JSON.parse(second.body)).toEqual(JSON.parse(first.body));
		expect(resumeRun).toHaveBeenCalledTimes(1);
		expect(resolve).toHaveBeenCalledTimes(1);
	});

	it("coalesces concurrent duplicate hosted wait submits before replaying Platform", async () => {
		const resolve = vi.fn().mockReturnValue(true);
		let resolvePlatform!: () => void;
		const resumeRun = vi.fn(
			() =>
				new Promise((resolveResume) => {
					resolvePlatform = () =>
						resolveResume({
							run: { id: "run_1" },
							event: { id: "event_resume" },
						});
				}),
		);
		serverRequestManager.registerClientTool({
			id: "ask-user-platform-concurrent",
			sessionId: "session-platform-concurrent",
			toolName: "ask_user",
			args: { question: "Continue?" },
			kind: "user_input",
			resolve,
			cancel: vi.fn().mockReturnValue(true),
		});
		const context = {
			hostedRunner: {
				enabled: true,
				runnerSessionId: "runner_1",
				workspaceRoot: "/workspace",
				agentRunId: "run_1",
				activeMaestroSessionId: "session-platform-concurrent",
			},
			platformPendingRequestResume: { resumeRun },
		};
		const firstBody = {
			kind: "user_input",
			sessionId: "session-platform-concurrent",
			content: [{ type: "text", text: "Yes" }],
		};
		const retryBody = {
			content: [{ type: "text", text: "Yes" }],
		};

		const firstPromise = resumeWithContext(
			"ask-user-platform-concurrent",
			firstBody,
			context,
		);
		await new Promise((resolve) => setImmediate(resolve));
		const secondPromise = resumeWithContext(
			"ask-user-platform-concurrent",
			retryBody,
			context,
		);
		resolvePlatform();
		const [first, second] = await Promise.all([firstPromise, secondPromise]);

		expect(first.statusCode).toBe(200);
		expect(second.statusCode).toBe(200);
		expect(JSON.parse(second.body)).toEqual(JSON.parse(first.body));
		expect(resumeRun).toHaveBeenCalledTimes(1);
		expect(resolve).toHaveBeenCalledTimes(1);
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
