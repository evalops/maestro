import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionApprovalService } from "../../src/agent/action-approval.js";

const approvalRequest = {
	id: "approval-1",
	toolName: "bash",
	args: { command: "git push" },
	reason: "Approval required",
	startedAtMs: 1_000,
};

describe("ActionApprovalService approval timing", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("stamps policy decisions with the resolution time", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(1_500));

		const service = new ActionApprovalService("auto");
		await expect(
			service.requestApproval(approvalRequest),
		).resolves.toMatchObject({
			approved: true,
			resolvedBy: "policy",
			resolvedAtMs: 1_500,
		});
	});

	it("stamps user decisions with the resolution time", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2_000));

		const service = new ActionApprovalService("prompt");
		const approval = service.requestApproval(approvalRequest);

		vi.setSystemTime(new Date(2_750));
		expect(service.approve("approval-1", "ship it")).toBe(true);

		await expect(approval).resolves.toMatchObject({
			approved: true,
			reason: "ship it",
			resolvedBy: "user",
			resolvedAtMs: 2_750,
		});
	});

	it("uses the injected clock for resolution timestamps", async () => {
		let now = 3_000;
		const service = new ActionApprovalService("prompt", {
			now: () => now,
			setTimeout,
			clearTimeout,
		});
		const approval = service.requestApproval(approvalRequest);

		now = 3_750;
		expect(service.deny("approval-1", "not yet")).toBe(true);

		await expect(approval).resolves.toMatchObject({
			approved: false,
			reason: "not yet",
			resolvedBy: "user",
			resolvedAtMs: 3_750,
		});
	});
});
