import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerRequestActionApprovalService } from "../../src/server/approval-service.js";
import { serverRequestManager } from "../../src/server/server-request-manager.js";

async function waitForPendingRequest(id: string) {
	for (let i = 0; i < 20; i++) {
		const request = serverRequestManager.get(id);
		if (request) {
			return request;
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error(`Timed out waiting for pending request ${id}`);
}

describe("ServerRequestActionApprovalService", () => {
	afterEach(() => {
		for (const request of serverRequestManager.listPending()) {
			serverRequestManager.cancel(request.id, "test cleanup");
		}
		vi.unstubAllGlobals();
	});

	it("resolves the session id lazily for each approval request", async () => {
		let sessionId = "session-1";
		const service = new ServerRequestActionApprovalService(
			"prompt",
			() => sessionId,
		);

		const firstRequest = {
			id: "approval-1",
			toolName: "bash",
			args: { command: "echo one" },
			reason: "Needs approval",
		};
		const firstPromise = service.requestApproval(firstRequest);
		expect(serverRequestManager.get(firstRequest.id)?.sessionId).toBe(
			"session-1",
		);
		expect(
			serverRequestManager.resolveApproval(firstRequest.id, {
				approved: true,
				reason: "Approved",
				resolvedBy: "user",
			}),
		).toBe(true);
		await expect(firstPromise).resolves.toMatchObject({
			approved: true,
			reason: "Approved",
			resolvedBy: "user",
		});

		sessionId = "session-2";

		const secondRequest = {
			id: "approval-2",
			toolName: "bash",
			args: { command: "echo two" },
			reason: "Needs approval again",
		};
		const secondPromise = service.requestApproval(secondRequest);
		expect(serverRequestManager.get(secondRequest.id)?.sessionId).toBe(
			"session-2",
		);
		expect(
			serverRequestManager.resolveApproval(secondRequest.id, {
				approved: false,
				reason: "Denied",
				resolvedBy: "user",
			}),
		).toBe(true);
		await expect(secondPromise).resolves.toMatchObject({
			approved: false,
			reason: "Denied",
			resolvedBy: "user",
		});
	});

	it("registers prompt approvals with the approvals service and mirrors the local decision", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({ approvalRequest: { id: "remote-approval-1" } }),
					{ status: 200 },
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						decision: {
							decision: "DECISION_TYPE_APPROVED",
							reason: "Approved",
						},
					}),
					{ status: 200 },
				),
			);
		vi.stubGlobal("fetch", fetchMock);
		const service = new ServerRequestActionApprovalService(
			"prompt",
			"session-1",
			{
				baseUrl: "https://approvals.test/",
				maxAttempts: 1,
				timeoutMs: 500,
				token: "approval-token",
				workspaceId: "workspace-1",
			},
		);

		const request = {
			id: "approval-remote-1",
			toolName: "bash",
			args: { command: "git commit -m test" },
			reason: "Needs approval",
		};
		const approvalPromise = service.requestApproval(request);

		expect((await waitForPendingRequest(request.id)).sessionId).toBe(
			"session-1",
		);
		expect(
			serverRequestManager.resolveApproval(request.id, {
				approved: true,
				reason: "Approved",
				resolvedBy: "user",
			}),
		).toBe(true);
		await expect(approvalPromise).resolves.toMatchObject({
			approved: true,
			reason: "Approved",
			resolvedBy: "user",
		});

		expect(fetchMock).toHaveBeenCalledTimes(2);
		const [requestUrl, requestInit] = fetchMock.mock.calls[0] as [
			string,
			RequestInit,
		];
		expect(requestUrl).toBe(
			"https://approvals.test/approvals.v1.ApprovalService/RequestApproval",
		);
		expect(requestInit.headers).toMatchObject({
			Authorization: "Bearer approval-token",
			"Connect-Protocol-Version": "1",
			"Content-Type": "application/json",
		});
		const requestBody = JSON.parse(String(requestInit.body)) as {
			actionPayload: string;
			actionType: string;
			agentId: string;
			workspaceId: string;
		};
		expect(requestBody).toMatchObject({
			actionType: "bash",
			agentId: "maestro",
			workspaceId: "workspace-1",
		});
		expect(
			JSON.parse(
				Buffer.from(requestBody.actionPayload, "base64").toString("utf8"),
			),
		).toMatchObject({
			localRequestId: request.id,
			sessionId: "session-1",
			toolName: "bash",
		});

		const [resolveUrl, resolveInit] = fetchMock.mock.calls[1] as [
			string,
			RequestInit,
		];
		expect(resolveUrl).toBe(
			"https://approvals.test/approvals.v1.ApprovalService/ResolveApproval",
		);
		expect(JSON.parse(String(resolveInit.body))).toMatchObject({
			approvalRequestId: "remote-approval-1",
			decision: "DECISION_TYPE_APPROVED",
			decidedBy: "maestro_user",
			reason: "Approved",
		});
	});

	it("falls back to local approval when the optional approvals service fails", async () => {
		const fetchMock = vi
			.fn()
			.mockRejectedValue(new Error("connection refused"));
		vi.stubGlobal("fetch", fetchMock);
		const service = new ServerRequestActionApprovalService(
			"prompt",
			"session-1",
			{
				baseUrl: "https://approvals.test",
				maxAttempts: 1,
				timeoutMs: 500,
				workspaceId: "workspace-1",
			},
		);

		const request = {
			id: "approval-fallback-1",
			toolName: "bash",
			args: { command: "echo hello" },
			reason: "Needs approval",
		};
		const approvalPromise = service.requestApproval(request);

		expect((await waitForPendingRequest(request.id)).sessionId).toBe(
			"session-1",
		);
		expect(
			serverRequestManager.resolveApproval(request.id, {
				approved: false,
				reason: "Denied",
				resolvedBy: "user",
			}),
		).toBe(true);
		await expect(approvalPromise).resolves.toMatchObject({
			approved: false,
			reason: "Denied",
			resolvedBy: "user",
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("returns a policy approval when the approvals service auto-approves", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					approvalRequest: { id: "remote-auto-1" },
					autoApproveEvidence: {
						pattern: "maestro:bash",
						confidence: 0.99,
						observationCount: 25,
						thresholdApplied: 0.95,
					},
				}),
				{ status: 200 },
			),
		);
		vi.stubGlobal("fetch", fetchMock);
		const service = new ServerRequestActionApprovalService(
			"prompt",
			"session-1",
			{
				baseUrl: "https://approvals.test",
				maxAttempts: 1,
				timeoutMs: 500,
				workspaceId: "workspace-1",
			},
		);

		const decision = await service.requestApproval({
			id: "approval-auto-1",
			toolName: "bash",
			args: { command: "git status" },
			reason: "Needs approval",
		});

		expect(decision).toMatchObject({
			approved: true,
			resolvedBy: "policy",
		});
		expect(decision.reason).toContain("Auto-approved by approvals service");
		expect(serverRequestManager.get("approval-auto-1")).toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("denies when the required approvals service is unavailable", async () => {
		const fetchMock = vi
			.fn()
			.mockRejectedValue(new Error("connection refused"));
		vi.stubGlobal("fetch", fetchMock);
		const service = new ServerRequestActionApprovalService(
			"prompt",
			"session-1",
			{
				baseUrl: "https://approvals.test",
				maxAttempts: 1,
				required: true,
				timeoutMs: 500,
				workspaceId: "workspace-1",
			},
		);

		const decision = await service.requestApproval({
			id: "approval-required-1",
			toolName: "bash",
			args: { command: "echo hello" },
			reason: "Needs approval",
		});

		expect(decision).toMatchObject({
			approved: false,
			resolvedBy: "policy",
		});
		expect(decision.reason).toContain("Approvals service unavailable");
		expect(serverRequestManager.get("approval-required-1")).toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
