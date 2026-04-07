import type { Container, TUI } from "@evalops/tui";
import { describe, expect, it, vi } from "vitest";
import type { Agent } from "../../src/agent/agent.js";
import type { AssistantMessage } from "../../src/agent/types.js";
import type {
	SessionDataProvider,
	SessionItem,
} from "../../src/cli-tui/session/session-data-provider.js";
import { SessionView } from "../../src/cli-tui/session/session-view.js";
import type { SessionManager } from "../../src/session/manager.js";

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

function createSessionView(messages: AssistantMessage[]): {
	view: SessionView;
	onSessionLoaded: ReturnType<typeof vi.fn>;
} {
	const onSessionLoaded = vi.fn();
	const applyLoadedSessionContext = vi.fn();
	const loadMessages = vi.fn(() => [] as AssistantMessage[]);
	const setSessionFile = vi.fn();
	const agent = {
		replaceMessages: vi.fn(),
		state: {
			systemPrompt: "",
			model: baseModel,
			thinkingLevel: "off",
			tools: [],
			messages,
			isStreaming: false,
			streamMessage: null,
			pendingToolCalls: new Map(),
		},
	} as unknown as Agent;

	const sessionManager = {
		setSessionFile,
		loadMessages,
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

	const sessionContext = {
		getArtifacts: () => ({}),
		getLastUserMessage: () => undefined,
		getLastAssistantMessage: () => undefined,
		getLastRunToolNames: () => [],
	} as unknown as ConstructorParameters<
		typeof SessionView
	>[0]["sessionContext"];

	return {
		view: new SessionView({
			agent,
			sessionManager,
			sessionDataProvider,
			chatContainer,
			ui,
			openSessionSwitcher: vi.fn(),
			summarizeSession: vi.fn(),
			applyLoadedSessionContext,
			showInfoMessage: vi.fn(),
			onSessionLoaded,
			sessionContext,
		}),
		onSessionLoaded,
	};
}

describe("SessionView showSessionInfo", () => {
	it("does not throw when assistant usage is missing", () => {
		const { view } = createSessionView([createAssistant({ usage: undefined })]);
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
		const { view } = createSessionView([usageAssistant]);
		expect(() => view.showSessionInfo()).not.toThrow();
	});

	it("passes resume summaries through session load callbacks", () => {
		const { view, onSessionLoaded } = createSessionView([]);
		const sessionItem = {
			path: "/tmp/session.jsonl",
			id: "session-1",
			created: new Date("2024-01-01T00:00:00.000Z"),
			modified: new Date("2024-01-02T00:00:00.000Z"),
			size: 128,
			messageCount: 4,
			firstMessage: "Review the failing tests",
			summary: "Review session",
			resumeSummary: "Reviewing the failing tests and updating coverage next.",
			favorite: false,
			allMessagesText: "Review the failing tests",
		} satisfies SessionItem;

		expect(view.loadSessionFromItem(sessionItem)).toBe(true);
		expect(onSessionLoaded).toHaveBeenCalledWith({
			id: "session-1",
			messageCount: 4,
			resumeSummary: "Reviewing the failing tests and updating coverage next.",
		});
	});
});
