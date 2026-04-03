import { afterEach, describe, expect, it } from "vitest";
import { ServerRequestActionApprovalService } from "../../src/server/approval-service.js";
import { serverRequestManager } from "../../src/server/server-request-manager.js";

describe("ServerRequestActionApprovalService", () => {
	afterEach(() => {
		for (const request of serverRequestManager.listPending()) {
			serverRequestManager.cancel(request.id, "test cleanup");
		}
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
});
