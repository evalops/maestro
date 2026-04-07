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
