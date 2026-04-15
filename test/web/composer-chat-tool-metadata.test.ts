// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerChat } from "../../packages/web/src/components/composer-chat.js";

type ToolMetadataInternals = {
	apiClient: {
		createSession: ReturnType<typeof vi.fn>;
		chatWithEvents: ReturnType<typeof vi.fn>;
		getSessions: ReturnType<typeof vi.fn>;
	};
	clientOnline: boolean;
	currentSessionId: string | null;
	handleSubmit: (event: CustomEvent<{ text: string }>) => Promise<void>;
	messages: Array<{ tools?: unknown[] }>;
};

function createChat() {
	const element = new ComposerChat() as unknown as ToolMetadataInternals;
	element.clientOnline = true;
	element.currentSessionId = "session-1";
	return element;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("composer-chat tool metadata", () => {
	it("preserves tool metadata during execution updates", async () => {
		const stream = async function* () {
			yield {
				type: "message_update",
				assistantMessageEvent: {
					type: "toolcall_start",
					contentIndex: 0,
					toolCallId: "call_1",
					toolCallName: "read",
					toolCallArgs: { path: "/tmp/config.json" },
				},
			};
			yield {
				type: "tool_execution_start",
				toolCallId: "call_1",
				toolName: "read",
				displayName: "Read File",
				summaryLabel: "Read config.json",
				args: { path: "/tmp/config.json" },
			};
			yield {
				type: "tool_execution_update",
				toolCallId: "call_1",
				toolName: "read",
				displayName: "Read File",
				summaryLabel: "Read config.json",
				args: { path: "/tmp/config.json" },
				partialResult: { lines: 12 },
			};
			yield {
				type: "message_end",
				message: { role: "assistant" },
			};
		};

		const element = createChat();
		element.apiClient = {
			createSession: vi.fn(),
			chatWithEvents: vi.fn().mockReturnValue(stream()),
			getSessions: vi.fn().mockResolvedValue([]),
		};

		await element.handleSubmit(
			new CustomEvent("submit", { detail: { text: "Hello" } }),
		);

		const assistant = [...element.messages]
			.reverse()
			.find((message) => Array.isArray(message.tools));
		const tools = (assistant?.tools ?? []) as Array<{
			displayName?: string;
			summaryLabel?: string;
			result?: unknown;
		}>;

		expect(tools[0]?.displayName).toBe("Read File");
		expect(tools[0]?.summaryLabel).toBe("Read config.json");
		expect(tools[0]?.result).toEqual({ lines: 12 });
	});
});
