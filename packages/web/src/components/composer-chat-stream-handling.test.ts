import type { ComposerActionApprovalRequest } from "@evalops/contracts";
import { describe, expect, it, vi } from "vitest";
import { ComposerChat } from "./composer-chat.js";

type ChatInternals = {
	apiClient: {
		chatWithEvents: ReturnType<typeof vi.fn>;
		createSession: ReturnType<typeof vi.fn>;
		getSessions: ReturnType<typeof vi.fn>;
	};
	clientOnline: boolean;
	messages: Array<{ role: string; content: string }>;
	error: string | null;
	lastApiError: string | null;
	lastSendFailed: string | null;
	pendingApprovalQueue: ComposerActionApprovalRequest[];
	handleSubmit: (event: CustomEvent<{ text: string }>) => Promise<void>;
};

function createChatWithStream(
	stream: AsyncGenerator<unknown, void, unknown>,
): ChatInternals {
	const element = new ComposerChat() as unknown as ChatInternals;
	element.apiClient = {
		chatWithEvents: vi.fn().mockReturnValue(stream),
		createSession: vi.fn().mockResolvedValue({
			id: "session-stream",
			messages: [],
		}),
		getSessions: vi.fn().mockResolvedValue([]),
	};
	element.clientOnline = true;
	element.messages = [];
	element.pendingApprovalQueue = [];
	return element;
}

describe("ComposerChat stream handling", () => {
	it("preserves partial assistant output when the stream emits an error event", async () => {
		const stream = async function* () {
			yield {
				type: "message_update",
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 0,
					delta: "Partial answer",
				},
			};
			yield { type: "error", message: "Stream failed" };
		};

		const element = createChatWithStream(stream());
		await element.handleSubmit(
			new CustomEvent("submit", { detail: { text: "Hello" } }),
		);

		expect(element.error).toBe("Stream failed");
		expect(element.lastApiError).toBe("Stream failed");
		expect(element.lastSendFailed).toBe("Hello");
		expect(element.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: "Partial answer",
		});
	});

	it("preserves partial assistant output when the stream is aborted", async () => {
		const stream = async function* () {
			yield {
				type: "message_update",
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 0,
					delta: "Partial answer",
				},
			};
			yield { type: "aborted" };
		};

		const element = createChatWithStream(stream());
		await element.handleSubmit(
			new CustomEvent("submit", { detail: { text: "Hello" } }),
		);

		expect(element.error).toBe("Request aborted");
		expect(element.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: "Partial answer",
		});
	});

	it("keeps pending approvals when chat submission fails", async () => {
		const stream = async function* () {
			yield { type: "status", status: "Starting", details: {} };
			throw new Error("connection lost");
		};
		const request: ComposerActionApprovalRequest = {
			id: "approval-1",
			toolName: "read",
			args: { path: "/tmp/file" },
			reason: "Need approval",
		};

		const element = createChatWithStream(stream());
		element.pendingApprovalQueue = [request];

		await element.handleSubmit(
			new CustomEvent("submit", { detail: { text: "Hello" } }),
		);

		expect(element.error).toBe("connection lost");
		expect(element.pendingApprovalQueue).toEqual([request]);
		expect(element.messages.at(-1)?.role).toBe("user");
	});
});
