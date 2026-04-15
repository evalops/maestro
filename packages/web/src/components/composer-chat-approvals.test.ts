import type { ComposerActionApprovalRequest } from "@evalops/contracts";
import { describe, expect, it, vi } from "vitest";
import { ComposerChatApprovals } from "./composer-chat-approvals.js";

function createDeferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function createApprovalsHarness() {
	const state = {
		pendingApprovalQueue: [] as ComposerActionApprovalRequest[],
		approvalSubmitting: false,
		approvalMode: null as "auto" | "prompt" | "fail" | null,
		approvalModeNotice: null as string | null,
	};
	const context = {
		currentSessionId: "session-1" as string | null,
		shareToken: null as string | null,
	};
	const apiClient = {
		getApprovalMode: vi.fn(),
		submitApprovalDecision: vi.fn(),
	};
	const showToast = vi.fn();

	const approvals = new ComposerChatApprovals(
		() => apiClient,
		() => state,
		(nextState) => {
			Object.assign(state, nextState);
		},
		() => context,
		showToast,
	);

	return {
		approvals,
		apiClient,
		context,
		showToast,
		state,
	};
}

describe("ComposerChatApprovals", () => {
	it("clears a pending approval after a successful submission", async () => {
		const { approvals, apiClient, state, showToast } = createApprovalsHarness();
		apiClient.submitApprovalDecision.mockResolvedValue({ success: true });
		state.pendingApprovalQueue = [
			{
				id: "approval-1",
				toolName: "bash",
				args: { command: "touch test.txt" },
				reason: "Needs approval",
			},
			{
				id: "approval-2",
				toolName: "write",
				args: { path: "/tmp/demo.txt" },
				reason: "Writes a file",
			},
		];

		await approvals.submitDecision("approved", "approval-1");

		expect(apiClient.submitApprovalDecision).toHaveBeenCalledWith({
			requestId: "approval-1",
			decision: "approved",
		});
		expect(state.pendingApprovalQueue).toEqual([
			{
				id: "approval-2",
				toolName: "write",
				args: { path: "/tmp/demo.txt" },
				reason: "Writes a file",
			},
		]);
		expect(state.approvalSubmitting).toBe(false);
		expect(showToast).toHaveBeenCalledWith(
			"Approval submitted",
			"success",
			1500,
		);
	});

	it("stores stricter-server notices when approval mode resolves down", () => {
		const { approvals, showToast, state } = createApprovalsHarness();

		approvals.updateModeStatus({
			mode: "fail",
			message:
				"Approval mode resolved to fail because the server default is stricter",
			notify: true,
			sessionId: "session-1",
		});

		expect(state.approvalMode).toBe("fail");
		expect(state.approvalModeNotice).toContain("server default is stricter");
		expect(showToast).toHaveBeenCalledWith(
			"Approval mode resolved to fail because the server default is stricter",
			"info",
			2200,
		);
	});

	it("ignores stale approval mode responses after the active session changes", async () => {
		const { approvals, apiClient, context, state } = createApprovalsHarness();
		const first = createDeferred<{
			mode: "auto" | "prompt" | "fail";
			availableModes: Array<"auto" | "prompt" | "fail">;
		}>();
		const second = createDeferred<{
			mode: "auto" | "prompt" | "fail";
			availableModes: Array<"auto" | "prompt" | "fail">;
		}>();
		apiClient.getApprovalMode
			.mockImplementationOnce(() => first.promise)
			.mockImplementationOnce(() => second.promise);

		const firstLoad = approvals.loadModeStatus("session-1");

		context.currentSessionId = "session-2";
		const secondLoad = approvals.loadModeStatus("session-2");

		second.resolve({
			mode: "fail",
			availableModes: ["auto", "prompt", "fail"],
		});
		await secondLoad;

		first.resolve({
			mode: "auto",
			availableModes: ["auto", "prompt", "fail"],
		});
		await firstLoad;

		expect(state.approvalMode).toBe("fail");
	});
});
