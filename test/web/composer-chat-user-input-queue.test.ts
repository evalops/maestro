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

describe("composer-chat user input queue", () => {
	it("queues ask_user requests from live chat events", async () => {
		const streamDone = createDeferred<void>();
		const element = new ComposerChat() as ComposerChat & {
			apiClient: {
				chatWithEvents: ReturnType<typeof vi.fn>;
				sendClientToolResult: ReturnType<typeof vi.fn>;
				getSessions: ReturnType<typeof vi.fn>;
			};
			clientOnline: boolean;
			messages: Array<Record<string, unknown>>;
			pendingUserInputQueue: Array<Record<string, unknown>>;
			handleSubmit: (event: CustomEvent<{ text: string }>) => Promise<void>;
		};

		element.apiClient = {
			chatWithEvents: vi.fn().mockReturnValue(
				(async function* () {
					yield {
						type: "client_tool_request",
						toolCallId: "call-user-input-1",
						toolName: "ask_user",
						args: {
							questions: [
								{
									header: "Stack",
									question: "Which schema library should we use?",
									options: [
										{
											label: "Zod",
											description: "Use Zod schemas",
										},
										{
											label: "Valibot",
											description: "Use Valibot schemas",
										},
									],
								},
							],
						},
					};
					await streamDone.promise;
					yield { type: "agent_end" };
				})(),
			),
			sendClientToolResult: vi.fn().mockResolvedValue(undefined),
			getSessions: vi.fn().mockResolvedValue([]),
		};
		element.clientOnline = true;
		element.messages = [];
		element.pendingUserInputQueue = [];

		const submitPromise = element.handleSubmit(
			new CustomEvent("submit", { detail: { text: "Hello" } }),
		);
		await flushAsyncWork();

		expect(element.pendingUserInputQueue).toEqual([
			{
				toolCallId: "call-user-input-1",
				toolName: "ask_user",
				args: {
					questions: [
						{
							header: "Stack",
							question: "Which schema library should we use?",
							options: [
								{
									label: "Zod",
									description: "Use Zod schemas",
								},
								{
									label: "Valibot",
									description: "Use Valibot schemas",
								},
							],
						},
					],
				},
				kind: "user_input",
			},
		]);
		expect(element.apiClient.sendClientToolResult).not.toHaveBeenCalled();

		streamDone.resolve();
		await submitPromise;
	});

	it("submits a user input response and clears the queue", async () => {
		const element = new ComposerChat() as ComposerChat & {
			apiClient: {
				sendClientToolResult: ReturnType<typeof vi.fn>;
			};
			pendingUserInputQueue: Array<Record<string, unknown>>;
			userInputSubmitting: boolean;
			submitUserInputResponse: (
				responseText?: string,
				toolCallId?: string,
				isError?: boolean,
			) => Promise<void>;
		};

		element.apiClient = {
			sendClientToolResult: vi.fn().mockResolvedValue(undefined),
		};
		element.pendingUserInputQueue = [
			{
				toolCallId: "call-user-input-1",
				toolName: "ask_user",
				args: {
					questions: [
						{
							header: "Stack",
							question: "Which schema library should we use?",
							options: [
								{
									label: "Zod",
									description: "Use Zod schemas",
								},
							],
						},
					],
				},
				kind: "user_input",
			},
		];

		await element.submitUserInputResponse("Use Zod", "call-user-input-1");

		expect(element.apiClient.sendClientToolResult).toHaveBeenCalledWith({
			toolCallId: "call-user-input-1",
			content: [{ type: "text", text: "Use Zod" }],
			isError: false,
		});
		expect(element.pendingUserInputQueue).toEqual([]);
		expect(element.userInputSubmitting).toBe(false);
	});
});
