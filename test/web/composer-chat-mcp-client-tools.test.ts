// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerChat } from "../../packages/web/src/components/composer-chat.js";

type ComposerChatMcpInternals = {
	apiClient: {
		chatWithEvents: ReturnType<typeof vi.fn>;
		sendClientToolResult: ReturnType<typeof vi.fn>;
		getMcpStatus: ReturnType<typeof vi.fn>;
		readMcpResource: ReturnType<typeof vi.fn>;
	};
	clientOnline: boolean;
	loadSessions: ReturnType<typeof vi.fn>;
	scrollToBottom: ReturnType<typeof vi.fn>;
	showToast: ReturnType<typeof vi.fn>;
	refreshUiState: ReturnType<typeof vi.fn>;
	requestUpdate: ReturnType<typeof vi.fn>;
	updateComplete: Promise<void>;
	handleSubmit: (event: CustomEvent<{ text: string }>) => Promise<void>;
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("composer-chat MCP client tools", () => {
	it("resolves advertised MCP client tools through the web API client", async () => {
		const stream = async function* () {
			yield {
				type: "client_tool_request",
				toolCallId: "call_servers",
				toolName: "list_mcp_servers",
				args: {},
			};
			yield {
				type: "client_tool_request",
				toolCallId: "call_tools",
				toolName: "list_mcp_tools",
				args: { server: "docs" },
			};
			yield {
				type: "client_tool_request",
				toolCallId: "call_resources",
				toolName: "list_mcp_resources",
				args: { server: "docs" },
			};
			yield {
				type: "client_tool_request",
				toolCallId: "call_read",
				toolName: "read_mcp_resource",
				args: { server: "docs", uri: "memo://guide" },
			};
			yield {
				type: "message_end",
				message: { role: "assistant" },
			};
		};

		const element = new ComposerChat() as unknown as ComposerChatMcpInternals;
		element.apiClient = {
			chatWithEvents: vi.fn().mockReturnValue(stream()),
			sendClientToolResult: vi.fn().mockResolvedValue(undefined),
			getMcpStatus: vi.fn().mockResolvedValue({
				servers: [
					{
						name: "docs",
						connected: true,
						transport: "stdio",
						scope: "project",
						tools: [{ name: "search_docs", description: "Search docs" }],
						resources: ["memo://guide"],
						prompts: ["summarize"],
					},
					{
						name: "broken",
						connected: false,
						transport: "http",
						tools: [],
						resources: [],
						prompts: [],
						error: "offline",
					},
				],
			}),
			readMcpResource: vi.fn().mockResolvedValue({
				contents: [{ uri: "memo://guide", text: "Guide body" }],
			}),
		};
		element.clientOnline = true;
		element.loadSessions = vi.fn().mockResolvedValue(undefined);
		element.scrollToBottom = vi.fn();
		element.showToast = vi.fn();
		element.refreshUiState = vi.fn().mockResolvedValue(undefined);
		element.requestUpdate = vi.fn();
		Object.defineProperty(element, "updateComplete", {
			configurable: true,
			value: Promise.resolve(),
		});

		await element.handleSubmit(
			new CustomEvent("submit", { detail: { text: "Hello" } }),
		);

		expect(element.apiClient.sendClientToolResult).toHaveBeenCalledTimes(4);
		const results = element.apiClient.sendClientToolResult.mock.calls.map(
			([payload]) => payload,
		);

		expect(results[0]).toMatchObject({
			toolCallId: "call_servers",
			isError: false,
		});
		expect(results[0]?.content?.[0]?.text).toContain("# MCP Servers");
		expect(results[0]?.content?.[0]?.text).toContain("docs");
		expect(results[0]?.content?.[0]?.text).toContain("broken");
		expect(results[0]?.content?.[0]?.text).toContain("offline");

		expect(results[1]).toMatchObject({
			toolCallId: "call_tools",
			isError: false,
		});
		expect(results[1]?.content?.[0]?.text).toContain("# Available MCP Tools");
		expect(results[1]?.content?.[0]?.text).toContain("search_docs");

		expect(results[2]).toMatchObject({
			toolCallId: "call_resources",
			isError: false,
		});
		expect(results[2]?.content?.[0]?.text).toContain(
			"# Available MCP Resources",
		);
		expect(results[2]?.content?.[0]?.text).toContain("memo://guide");

		expect(results[3]).toMatchObject({
			toolCallId: "call_read",
			isError: false,
		});
		expect(results[3]?.content?.[0]?.text).toContain("Guide body");
		expect(element.apiClient.readMcpResource).toHaveBeenCalledWith(
			"docs",
			"memo://guide",
		);
	});
});
