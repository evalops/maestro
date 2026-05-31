import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionApprovalRequest } from "../../src/agent/action-approval.js";
import { PlatformBackedActionApprovalService } from "../../src/approvals/platform-action-approval.js";
import { resetApprovalsDownstreamForTests } from "../../src/approvals/service-client.js";

const approvalRequest: ActionApprovalRequest = {
	id: "approval-1",
	toolName: "bash",
	args: { command: "git push" },
	reason: "Publishing changes requires approval",
};

async function waitForPending(
	service: PlatformBackedActionApprovalService,
): Promise<void> {
	await vi.waitFor(() => {
		expect(service.getPendingRequests()).toHaveLength(1);
	});
}

function getRegistrationWaiterCount(
	service: PlatformBackedActionApprovalService,
	requestId: string,
): number {
	const waiters = (
		service as unknown as {
			pendingApprovalRegistrationWaiters: Map<string, unknown[]>;
		}
	).pendingApprovalRegistrationWaiters;
	return waiters.get(requestId)?.length ?? 0;
}

describe("platform-backed action approval service", () => {
	afterEach(() => {
		resetApprovalsDownstreamForTests();
		vi.unstubAllGlobals();
	});

	it("registers prompt-mode approvals with platform and syncs the user decision", async () => {
		const fetchMock = vi.fn(async (url: string | URL | Request) => {
			const href = String(url);
			if (href.endsWith("/approvals.v1.ApprovalService/RequestApproval")) {
				return new Response(
					JSON.stringify({ approvalRequest: { id: "remote-approval-1" } }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (href.endsWith("/approvals.v1.ApprovalService/ResolveApproval")) {
				return new Response(JSON.stringify({}), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("not found", { status: 404 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const service = new PlatformBackedActionApprovalService("prompt", {
			sessionIdProvider: "session-1",
			approvalsServiceConfig: {
				baseUrl: "https://platform.test",
				maxAttempts: 1,
				timeoutMs: 500,
				token: "token-1",
				workspaceId: "workspace-1",
			},
		});

		const approval = service.requestApproval(approvalRequest);
		await waitForPending(service);
		expect(service.approve("approval-1", "looks good")).toBe(true);

		await expect(approval).resolves.toMatchObject({
			approved: true,
			reason: "looks good",
			resolvedAtMs: expect.any(Number),
			resolvedBy: "user",
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);

		const requestBody = JSON.parse(
			String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}"),
		);
		expect(requestBody).toMatchObject({
			workspaceId: "workspace-1",
			agentId: "maestro",
			surface: "maestro",
			actionType: "bash",
		});
		expect(requestBody.contextJson).toContain("session-1");

		const resolveBody = JSON.parse(
			String(fetchMock.mock.calls[1]?.[1]?.body ?? "{}"),
		);
		expect(resolveBody).toMatchObject({
			approvalRequestId: "remote-approval-1",
			decision: "DECISION_TYPE_APPROVED",
			reason: "looks good",
			resolvedAtMs: expect.any(Number),
		});
	});

	it("propagates AbortError while syncing the remote approval decision", async () => {
		const abortError = new Error("aborted");
		abortError.name = "AbortError";
		const controller = new AbortController();
		const fetchMock = vi.fn(async (url: string | URL | Request) => {
			const href = String(url);
			if (href.endsWith("/approvals.v1.ApprovalService/RequestApproval")) {
				return new Response(
					JSON.stringify({ approvalRequest: { id: "remote-approval-abort" } }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (href.endsWith("/approvals.v1.ApprovalService/ResolveApproval")) {
				controller.abort();
				throw abortError;
			}
			return new Response("not found", { status: 404 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const service = new PlatformBackedActionApprovalService("prompt", {
			sessionIdProvider: "session-abort",
			approvalsServiceConfig: {
				baseUrl: "https://platform.test",
				maxAttempts: 1,
				timeoutMs: 500,
				token: "token-1",
				workspaceId: "workspace-1",
			},
		});

		const approval = service.requestApproval(
			{
				...approvalRequest,
				id: "approval-abort-sync",
			},
			controller.signal,
		);
		await waitForPending(service);
		expect(service.approve("approval-abort-sync", "looks good")).toBe(true);

		await expect(approval).rejects.toMatchObject({ name: "AbortError" });
	});

	it("propagates AbortError while registering the remote approval request", async () => {
		const abortError = new Error("aborted");
		abortError.name = "AbortError";
		const controller = new AbortController();
		const fetchMock = vi.fn(async (url: string | URL | Request) => {
			const href = String(url);
			if (href.endsWith("/approvals.v1.ApprovalService/RequestApproval")) {
				controller.abort();
				throw abortError;
			}
			return new Response("not found", { status: 404 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const service = new PlatformBackedActionApprovalService("prompt", {
			sessionIdProvider: "session-abort-register",
			approvalsServiceConfig: {
				baseUrl: "https://platform.test",
				maxAttempts: 1,
				timeoutMs: 500,
				token: "token-1",
				workspaceId: "workspace-1",
			},
		});

		await expect(
			service.requestApproval(
				{
					...approvalRequest,
					id: "approval-abort-register",
				},
				controller.signal,
			),
		).rejects.toMatchObject({ name: "AbortError" });
	});

	it("exposes remote approval registration metadata while the request is pending", async () => {
		const fetchMock = vi.fn(async (url: string | URL | Request) => {
			const href = String(url);
			if (href.endsWith("/approvals.v1.ApprovalService/RequestApproval")) {
				return new Response(
					JSON.stringify({ approvalRequest: { id: "remote-approval-2" } }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (href.endsWith("/approvals.v1.ApprovalService/ResolveApproval")) {
				return new Response(JSON.stringify({}), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("not found", { status: 404 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const service = new PlatformBackedActionApprovalService("prompt", {
			sessionIdProvider: "session-2",
			approvalsServiceConfig: {
				baseUrl: "https://platform.test",
				maxAttempts: 1,
				timeoutMs: 500,
				workspaceId: "workspace-1",
			},
		});

		const approval = service.requestApproval({
			...approvalRequest,
			id: "approval-2",
		});

		await expect(
			service.waitForPendingApprovalRegistration("approval-2"),
		).resolves.toEqual({
			remoteApprovalRequestId: "remote-approval-2",
		});
		expect(service.getPendingApprovalRegistration("approval-2")).toEqual({
			remoteApprovalRequestId: "remote-approval-2",
		});

		expect(service.approve("approval-2", "approved")).toBe(true);
		await expect(approval).resolves.toMatchObject({
			approved: true,
			reason: "approved",
			resolvedAtMs: expect.any(Number),
			resolvedBy: "user",
		});
		expect(
			service.getPendingApprovalRegistration("approval-2"),
		).toBeUndefined();
	});

	it("cleans up approval registration waiters when the caller aborts before registration", async () => {
		const service = new PlatformBackedActionApprovalService("prompt", {
			approvalsServiceConfig: false,
		});
		const controller = new AbortController();

		const registration = service.waitForPendingApprovalRegistration(
			"approval-abort",
			{ signal: controller.signal },
		);
		expect(getRegistrationWaiterCount(service, "approval-abort")).toBe(1);

		controller.abort();

		await expect(registration).resolves.toBeNull();
		expect(getRegistrationWaiterCount(service, "approval-abort")).toBe(0);
	});

	it("falls back to local prompt approvals when platform registration fails open", async () => {
		const fetchMock = vi.fn(
			async () => new Response("unavailable", { status: 503 }),
		);
		vi.stubGlobal("fetch", fetchMock);

		const service = new PlatformBackedActionApprovalService("prompt", {
			approvalsServiceConfig: {
				baseUrl: "https://platform.test",
				circuitFailureThreshold: 1,
				maxAttempts: 1,
				timeoutMs: 500,
				workspaceId: "workspace-1",
			},
		});

		const approval = service.requestApproval(approvalRequest);
		await waitForPending(service);
		expect(service.deny("approval-1", "not now")).toBe(true);

		await expect(approval).resolves.toMatchObject({
			approved: false,
			reason: "not now",
			resolvedAtMs: expect.any(Number),
			resolvedBy: "user",
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("fails closed without queuing locally when platform registration is required", async () => {
		const fetchMock = vi.fn(
			async () => new Response("unavailable", { status: 503 }),
		);
		vi.stubGlobal("fetch", fetchMock);

		const service = new PlatformBackedActionApprovalService("prompt", {
			approvalsServiceConfig: {
				baseUrl: "https://platform.test",
				circuitFailureThreshold: 1,
				maxAttempts: 1,
				required: true,
				timeoutMs: 500,
				workspaceId: "workspace-1",
			},
		});

		await expect(
			service.requestApproval(approvalRequest),
		).resolves.toMatchObject({
			approved: false,
			reason:
				"Approvals service unavailable: approvals service returned 503: unavailable",
			resolvedAtMs: expect.any(Number),
			resolvedBy: "policy",
		});
		expect(service.getPendingRequests()).toHaveLength(0);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
