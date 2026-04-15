import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	AgentEvent,
	AgentState,
	AppMessage,
} from "../../src/agent/types.js";
import { setupEventSubscriptions } from "../../src/bootstrap/event-subscriptions-setup.js";
import { clearRegisteredHooks, registerHook } from "../../src/hooks/index.js";
import type { SessionManager } from "../../src/session/manager.js";

type SubscriptionHandler = (event: AgentEvent) => void | Promise<void>;

class MockAgent {
	public readonly state: AgentState;
	private readonly subscribers: SubscriptionHandler[] = [];

	constructor(messages: AppMessage[]) {
		this.state = {
			systemPrompt: "You are helpful.",
			model: {
				id: "claude-sonnet-4-5-20250929",
				name: "Claude Sonnet 4.5",
				api: "anthropic-messages",
				provider: "anthropic",
				baseUrl: "https://api.anthropic.com/v1/messages",
				reasoning: true,
				toolUse: true,
				input: ["text"],
				cost: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
				},
				contextWindow: 200000,
				maxTokens: 8192,
				providerName: "Anthropic",
				source: "builtin",
			},
			thinkingLevel: "medium",
			tools: [],
			steeringMode: "all",
			followUpMode: "all",
			queueMode: "all",
			messages,
			isStreaming: false,
			streamMessage: null,
			pendingToolCalls: new Map(),
		};
	}

	subscribe(handler: SubscriptionHandler): () => void {
		this.subscribers.push(handler);
		return () => {
			const index = this.subscribers.indexOf(handler);
			if (index >= 0) {
				this.subscribers.splice(index, 1);
			}
		};
	}

	async emit(event: AgentEvent): Promise<void> {
		for (const handler of [...this.subscribers]) {
			await handler(event);
		}
	}
}

function createSessionManagerMock(): SessionManager {
	return {
		getSessionId: vi.fn(() => "session-123"),
		getSessionFile: vi.fn(() => "/tmp/session-123.jsonl"),
		saveSessionSummary: vi.fn(),
		saveMessage: vi.fn(),
		shouldInitializeSession: vi.fn(() => false),
		loadAllSessions: vi.fn(() => []),
		startSession: vi.fn(),
		updateSnapshot: vi.fn(),
	} as unknown as SessionManager;
}

describe("setupEventSubscriptions", () => {
	afterEach(() => {
		clearRegisteredHooks();
		process.env.MAESTRO_NOTIFY_PROGRAM = "";
		process.env.MAESTRO_NOTIFY_EVENTS = "";
		process.env.MAESTRO_NOTIFY_TERMINAL = "";
	});

	it("runs Notification hooks even when desktop notifications are disabled", async () => {
		const captured: Array<{ notification_type: string; message: string }> = [];
		registerHook("Notification", {
			type: "callback",
			callback: async (input) => {
				captured.push({
					notification_type: (
						input as { notification_type: string; message: string }
					).notification_type,
					message: (input as { notification_type: string; message: string })
						.message,
				});
				return {};
			},
		});

		const agent = new MockAgent([
			{
				role: "user",
				content: "Summarize the repo status",
				timestamp: Date.now(),
			},
		]);
		const sessionManager = createSessionManagerMock();

		setupEventSubscriptions({
			agent: agent as unknown as never,
			sessionManager,
			approvalMode: "prompt",
			sandboxMode: undefined,
			tsHookCount: 0,
			cwd: "/tmp/project",
			enterpriseContext: {
				isEnterprise: () => false,
				startSession: () => {},
				getSession: () => null,
			},
		});

		await agent.emit({
			type: "turn_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Done" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5-20250929",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						total: 0,
					},
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
			toolResults: [],
		});

		expect(captured).toEqual([
			{
				notification_type: "turn-complete",
				message: "Done",
			},
		]);
		expect(sessionManager.updateSnapshot).toHaveBeenCalled();
	});

	it("schedules automatic durable memory extraction after assistant messages", async () => {
		const agent = new MockAgent([]);
		const sessionManager = createSessionManagerMock();
		const automaticMemoryExtraction = {
			schedule: vi.fn(),
			flush: vi.fn(),
		};

		setupEventSubscriptions({
			agent: agent as unknown as never,
			sessionManager,
			approvalMode: "prompt",
			sandboxMode: undefined,
			tsHookCount: 0,
			cwd: "/tmp/project",
			enterpriseContext: {
				isEnterprise: () => false,
				startSession: () => {},
				getSession: () => null,
			},
			automaticMemoryExtraction,
		});

		await agent.emit({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Done" }],
				timestamp: Date.now(),
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5-20250929",
				stopReason: "stop",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						total: 0,
					},
				},
			},
		});

		expect(automaticMemoryExtraction.schedule).toHaveBeenCalledWith(
			"/tmp/session-123.jsonl",
		);
	});
});
