// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatContainer } from "../../packages/desktop/src/renderer/components/Chat/ChatContainer";
import { Message } from "../../packages/desktop/src/renderer/components/Chat/Message";
import { Header } from "../../packages/desktop/src/renderer/components/Header/Header";

const useChatMock = vi.fn();

vi.mock("../../packages/desktop/src/renderer/hooks/useChat", () => ({
	useChat: (...args: unknown[]) => useChatMock(...args),
}));

Object.defineProperty(window, "electron", {
	value: { isMac: false },
	configurable: true,
});

describe("desktop chat UI", () => {
	beforeEach(() => {
		useChatMock.mockReturnValue({
			messages: [],
			isLoading: false,
			error: null,
			runtimeStatus: null,
			sendMessage: async () => {},
			clearError: () => {},
			clearMessages: () => {},
		});
	});

	it("renders Maestro branding in the header", () => {
		const html = renderToStaticMarkup(
			<Header
				models={[]}
				currentModel={null}
				onModelChange={() => {}}
				onSettingsClick={() => {}}
				sidebarOpen
				onToggleSidebar={() => {}}
			/>,
		);

		expect(html).toContain("Maestro");
		expect(html).not.toContain("Composer");
	});

	it("renders Maestro branding and tool summary chips for assistant messages", () => {
		const assistantMessageProps = {
			role: "assistant" as const,
			content: "Done.",
			toolCalls: [
				{
					id: "call-1",
					name: "read",
					args: { path: "src/app.ts" },
					status: "success" as const,
				},
			],
		};
		const html = renderToStaticMarkup(<Message {...assistantMessageProps} />);

		expect(html).toContain("Maestro");
		expect(html).toContain("Read app.ts");
		expect(html).not.toContain("Composer");
	});

	it("renders the Maestro empty state copy", () => {
		const html = renderToStaticMarkup(<ChatContainer sessionId={null} />);

		expect(html).toContain("Welcome to Maestro");
		expect(html).not.toContain("Welcome to Composer");
	});

	it("renders project onboarding guidance in the empty state", () => {
		const html = renderToStaticMarkup(
			<ChatContainer
				sessionId={null}
				workspaceStatusPrefetch={{
					cwd: "/repo",
					git: null,
					context: { agentMd: false, claudeMd: false },
					onboarding: {
						shouldShow: true,
						completed: false,
						seenCount: 0,
						steps: [
							{
								key: "workspace",
								text: "Ask Maestro to create a new app or clone a repository.",
								isComplete: true,
								isEnabled: false,
							},
							{
								key: "instructions",
								text: "Run /init to scaffold AGENTS.md instructions for this project.",
								isComplete: false,
								isEnabled: true,
							},
						],
					},
					server: { uptime: 1, version: "v20.0.0" },
				}}
			/>,
		);

		expect(html).toContain("Getting Started");
		expect(html).toContain("/init");
		expect(html).toContain("AGENTS.md");
		expect(html).toContain("Run /init");
	});

	it("renders recent resumable sessions in the empty chat state", () => {
		const html = renderToStaticMarkup(
			<ChatContainer
				sessionId="session-current"
				sessions={[
					{
						id: "session-current",
						title: "Current",
						createdAt: "2026-04-08T00:00:00.000Z",
						updatedAt: "2026-04-08T00:00:00.000Z",
						messageCount: 0,
					},
					{
						id: "session-previous",
						title: "Earlier work",
						createdAt: "2026-04-07T00:00:00.000Z",
						updatedAt: "2026-04-07T00:00:00.000Z",
						messageCount: 8,
						resumeSummary: "Finish tightening the onboarding flow next.",
					},
				]}
				onSessionSelect={() => {}}
			/>,
		);

		expect(html).toContain("Resume a Session");
		expect(html).toContain("Earlier work");
		expect(html).toContain("Finish tightening the onboarding flow next.");
		expect(html).not.toContain(">Current<");
	});

	it("renders runtime status while the agent is working", () => {
		useChatMock.mockReturnValue({
			messages: [],
			isLoading: true,
			error: null,
			runtimeStatus: "Compacting conversation...",
			sendMessage: async () => {},
			clearError: () => {},
			clearMessages: () => {},
		});

		const html = renderToStaticMarkup(<ChatContainer sessionId="session-1" />);

		expect(html).toContain("Compacting conversation...");
		expect(html).toContain("Agent");
	});
});
