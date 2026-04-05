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

describe("composer-chat tool retry queue", () => {
	it("clears a pending retry request after a successful submission", async () => {
		const element = new ComposerChat() as ComposerChat & {
			apiClient: unknown;
			pendingToolRetryQueue: Array<Record<string, unknown>>;
			toolRetrySubmitting: boolean;
			submitToolRetryDecision: (
				action: "retry" | "skip" | "abort",
				requestId?: string,
			) => Promise<void>;
		};

		const apiClient = {
			submitToolRetryDecision: vi.fn().mockResolvedValue({ success: true }),
			getSessions: vi.fn().mockResolvedValue([]),
		};

		element.apiClient = apiClient;
		element.pendingToolRetryQueue = [
			{
				id: "retry-1",
				toolCallId: "call-1",
				toolName: "bash",
				args: { command: "ls" },
				errorMessage: "Command failed",
				attempt: 1,
			},
			{
				id: "retry-2",
				toolCallId: "call-2",
				toolName: "read",
				args: { path: "/tmp/demo.txt" },
				errorMessage: "File missing",
				attempt: 1,
			},
		];

		await element.submitToolRetryDecision("retry", "retry-1");

		expect(apiClient.submitToolRetryDecision).toHaveBeenCalledWith({
			requestId: "retry-1",
			action: "retry",
		});
		expect(element.pendingToolRetryQueue).toEqual([
			{
				id: "retry-2",
				toolCallId: "call-2",
				toolName: "read",
				args: { path: "/tmp/demo.txt" },
				errorMessage: "File missing",
				attempt: 1,
			},
		]);
		expect(element.toolRetrySubmitting).toBe(false);
	});

	it("keeps toolRetrySubmitting true while a retry request is in flight", async () => {
		const streamDone = createDeferred<void>();
		const retryDone = createDeferred<{ success: boolean }>();
		const element = new ComposerChat() as ComposerChat & {
			apiClient: {
				chatWithEvents: ReturnType<typeof vi.fn>;
				submitToolRetryDecision: ReturnType<typeof vi.fn>;
				getSessions: ReturnType<typeof vi.fn>;
			};
			clientOnline: boolean;
			messages: Array<Record<string, unknown>>;
			pendingToolRetryQueue: Array<Record<string, unknown>>;
			toolRetrySubmitting: boolean;
			handleSubmit: (event: CustomEvent<{ text: string }>) => Promise<void>;
			submitToolRetryDecision: (
				action: "retry" | "skip" | "abort",
				requestId?: string,
			) => Promise<void>;
		};

		element.apiClient = {
			chatWithEvents: vi.fn().mockReturnValue(
				(async function* () {
					yield {
						type: "tool_retry_required",
						request: {
							id: "retry-1",
							toolCallId: "call-1",
							toolName: "bash",
							args: { command: "ls" },
							errorMessage: "Command failed",
							attempt: 1,
						},
					};
					await streamDone.promise;
					yield { type: "agent_end" };
				})(),
			),
			submitToolRetryDecision: vi
				.fn()
				.mockImplementation(() => retryDone.promise),
			getSessions: vi.fn().mockResolvedValue([]),
		};
		element.clientOnline = true;
		element.messages = [];
		element.pendingToolRetryQueue = [];

		const submitPromise = element.handleSubmit(
			new CustomEvent("submit", { detail: { text: "Hello" } }),
		);
		await flushAsyncWork();

		expect(element.pendingToolRetryQueue).toHaveLength(1);

		const retryPromise = element.submitToolRetryDecision("retry", "retry-1");
		await flushAsyncWork(1);

		expect(element.toolRetrySubmitting).toBe(true);

		streamDone.resolve();
		await submitPromise;

		expect(element.toolRetrySubmitting).toBe(true);

		retryDone.resolve({ success: true });
		await retryPromise;

		expect(element.toolRetrySubmitting).toBe(false);
		expect(element.pendingToolRetryQueue).toEqual([]);
	});
});
