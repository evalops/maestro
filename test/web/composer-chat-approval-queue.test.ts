// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { ComposerChat } from "../../packages/web/src/components/composer-chat.js";

function createDeferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

async function flushAsyncWork(iterations = 4) {
	for (let index = 0; index < iterations; index++) {
		await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

describe("composer-chat approval queue", () => {
	it("clears a pending approval after a successful submission", async () => {
		const element = new ComposerChat() as ComposerChat & {
			apiClient: unknown;
			pendingApprovalQueue: Array<Record<string, unknown>>;
			approvalSubmitting: boolean;
			submitApprovalDecision: (
				decision: "approved" | "denied",
				requestId?: string,
			) => Promise<void>;
		};

		const apiClient = {
			submitApprovalDecision: vi.fn().mockResolvedValue({ success: true }),
			getSessions: vi.fn().mockResolvedValue([]),
		};

		element.apiClient = apiClient;
		element.pendingApprovalQueue = [
			{
				id: "approval-1",
				toolName: "bash",
				args: { command: "touch test.txt" },
				reason: "Needs approval",
			},
		];

		await element.submitApprovalDecision("approved", "approval-1");

		expect(apiClient.submitApprovalDecision).toHaveBeenCalledWith({
			requestId: "approval-1",
			decision: "approved",
		});
		expect(element.pendingApprovalQueue).toEqual([]);
		expect(element.approvalSubmitting).toBe(false);
	});

	it("keeps approvalSubmitting true while an approval request is still in flight", async () => {
		const streamDone = createDeferred<void>();
		const approvalDone = createDeferred<{ success: boolean }>();
		const element = new ComposerChat() as ComposerChat & {
			apiClient: {
				chatWithEvents: ReturnType<typeof vi.fn>;
				submitApprovalDecision: ReturnType<typeof vi.fn>;
				getSessions: ReturnType<typeof vi.fn>;
			};
			clientOnline: boolean;
			messages: Array<Record<string, unknown>>;
			pendingApprovalQueue: Array<Record<string, unknown>>;
			approvalSubmitting: boolean;
			handleSubmit: (event: CustomEvent<{ text: string }>) => Promise<void>;
			submitApprovalDecision: (
				decision: "approved" | "denied",
				requestId?: string,
			) => Promise<void>;
		};

		element.apiClient = {
			chatWithEvents: vi.fn().mockReturnValue(
				(async function* () {
					yield {
						type: "action_approval_required",
						request: {
							id: "approval-1",
							toolName: "bash",
							args: { command: "touch test.txt" },
							reason: "Needs approval",
						},
					};
					await streamDone.promise;
					yield { type: "agent_end" };
				})(),
			),
			submitApprovalDecision: vi
				.fn()
				.mockImplementation(() => approvalDone.promise),
			getSessions: vi.fn().mockResolvedValue([]),
		};
		element.clientOnline = true;
		element.messages = [];
		element.pendingApprovalQueue = [];

		const submitPromise = element.handleSubmit(
			new CustomEvent("submit", { detail: { text: "Hello" } }),
		);
		await flushAsyncWork();

		expect(element.pendingApprovalQueue).toHaveLength(1);

		const approvalPromise = element.submitApprovalDecision(
			"approved",
			"approval-1",
		);
		await flushAsyncWork(1);

		expect(element.approvalSubmitting).toBe(true);

		streamDone.resolve();
		await submitPromise;

		expect(element.approvalSubmitting).toBe(true);

		approvalDone.resolve({ success: true });
		await approvalPromise;

		expect(element.approvalSubmitting).toBe(false);
		expect(element.pendingApprovalQueue).toEqual([]);
	});
});
