import { describe, expect, it, vi } from "vitest";
import type { Agent } from "../src/agent/agent.js";
import type { AssistantMessage } from "../src/agent/types.js";
import type { SessionManager } from "../src/session-manager.js";
import type { Container, TUI } from "../src/tui-lib/index.js";
import type {
	SessionDataProvider,
	SessionItem,
} from "../src/tui/session-data-provider.js";
import { SessionView } from "../src/tui/session-view.js";

const baseModel = {
	id: "gpt-4o-mini",
	name: "GPT-4o Mini",
	api: "openai-responses" as const,
	provider: "openai" as const,
	baseUrl: "https://api.openai.com/v1/chat/completions",
	reasoning: false,
	input: ["text" as const],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 4096,
};

function createAssistant(
	overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
	const base: Partial<AssistantMessage> = {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		stopReason: "stop",
		timestamp: Date.now(),
		usage: overrides.usage,
	};
	return { ...base, ...overrides } as AssistantMessage;
}

function createSessionView(messages: AssistantMessage[]): SessionView {
	const agent = {
		state: {
			systemPrompt: "",
			model: baseModel,
			thinkingLevel: "off",
			tools: [],
			messages,
			isStreaming: false,
			streamMessage: null,
			pendingToolCalls: new Set(),
		},
	} as unknown as Agent;

	const sessionManager = {
		getSessionFile: () => null,
		getSessionId: () => "test-session",
	} as unknown as SessionManager;

	const sessionDataProvider = {
		loadSessions: () => [] as SessionItem[],
	} as unknown as SessionDataProvider;

	const chatContainer = {
		addChild: vi.fn(),
	} as unknown as Container;

	const ui = {
		requestRender: vi.fn(),
	} as unknown as TUI;

	return new SessionView({
		agent,
		sessionManager,
		sessionDataProvider,
		chatContainer,
		ui,
		openSessionSwitcher: vi.fn(),
		summarizeSession: vi.fn(),
		applyLoadedSessionContext: vi.fn(),
		showInfoMessage: vi.fn(),
		onSessionLoaded: vi.fn(),
	});
}

describe("SessionView showSessionInfo", () => {
	it("does not throw when assistant usage is missing", () => {
		const view = createSessionView([createAssistant({ usage: undefined })]);
		expect(() => view.showSessionInfo()).not.toThrow();
	});

	it("aggregates usage when present", () => {
		const usageAssistant = createAssistant({
			usage: {
				input: 5,
				output: 3,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		const view = createSessionView([usageAssistant]);
		expect(() => view.showSessionInfo()).not.toThrow();
	});
});
