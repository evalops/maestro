import { describe, expect, it, vi } from "vitest";
import {
	type WebSlashCommandContext,
	executeWebSlashCommand,
} from "./composer-chat-slash-commands.js";
import { WEB_SLASH_COMMANDS } from "./slash-commands.js";

type CommandOutput = {
	output: string;
	isError: boolean;
};

function createContext(overrides: Partial<WebSlashCommandContext> = {}) {
	const outputs: CommandOutput[] = [];
	const apiClient = {
		addMcpAuthPreset: vi.fn(),
		addMcpServer: vi.fn(),
		cancelQueuedPrompt: vi.fn(),
		createBranch: vi.fn(),
		enterPlanMode: vi.fn(),
		exitPlanMode: vi.fn(),
		getApprovalMode: vi.fn(),
		getConfig: vi.fn(),
		getDiagnostics: vi.fn(),
		getFiles: vi.fn(),
		getMcpStatus: vi.fn(),
		getMcpPrompt: vi.fn(),
		getPlan: vi.fn(),
		getPreview: vi.fn(),
		getQueueStatus: vi.fn(),
		getReview: vi.fn(),
		getRunScripts: vi.fn(),
		importMcpRegistry: vi.fn(),
		getStats: vi.fn(),
		getStatus: vi.fn(),
		getTelemetryStatus: vi.fn(),
		getUsage: vi.fn(),
		listBranchOptions: vi.fn(),
		listQueue: vi.fn(),
		readMcpResource: vi.fn(),
		removeMcpAuthPreset: vi.fn(),
		removeMcpServer: vi.fn(),
		runScript: vi.fn(),
		saveConfig: vi.fn(),
		searchMcpRegistry: vi.fn(),
		setApprovalMode: vi.fn(),
		setCleanMode: vi.fn(),
		setFooterMode: vi.fn(),
		setModel: vi.fn(),
		setQueueMode: vi.fn(),
		setTelemetry: vi.fn(),
		setZenMode: vi.fn(),
		updateMcpAuthPreset: vi.fn(),
		updateMcpServer: vi.fn(),
		updatePlan: vi.fn(),
	};

	const context: WebSlashCommandContext = {
		apiClient: apiClient as unknown as WebSlashCommandContext["apiClient"],
		appendCommandOutput: (output, isError = false) => {
			outputs.push({ output, isError });
		},
		applyTheme: vi.fn(),
		applyZenMode: vi.fn(),
		commands: WEB_SLASH_COMMANDS,
		createNewSession: vi.fn().mockResolvedValue(undefined),
		currentSessionId: "session-1",
		isSharedSession: false,
		openCommandDrawer: vi.fn(),
		openModelSelector: vi.fn(),
		selectSession: vi.fn().mockResolvedValue(undefined),
		setCleanMode: vi.fn(),
		setCurrentModel: vi.fn(),
		setFooterMode: vi.fn(),
		setInputValue: vi.fn(),
		setQueueMode: vi.fn(),
		setTransportPreference: vi.fn(),
		theme: "dark",
		updateModelMeta: vi.fn().mockResolvedValue(undefined),
		zenMode: false,
		...overrides,
	};

	return { context, outputs, apiClient };
}

describe("executeWebSlashCommand", () => {
	it("renders the help command list as a code block", async () => {
		const { context, outputs } = createContext();

		await executeWebSlashCommand("help", "", context);

		expect(outputs).toEqual([
			expect.objectContaining({
				isError: false,
				output: expect.stringContaining(
					"/stats — Show status and usage summary",
				),
			}),
		]);
		expect(outputs[0]?.output).toContain("```text");
	});

	it("blocks branch creation in shared sessions", async () => {
		const { context, outputs, apiClient } = createContext({
			isSharedSession: true,
		});

		await executeWebSlashCommand("branch", "7", context);

		expect(apiClient.createBranch).not.toHaveBeenCalled();
		expect(outputs).toEqual([
			{
				output: "Branching is disabled in shared sessions.",
				isError: true,
			},
		]);
	});

	it("opens the command drawer without appending output", async () => {
		const { context, outputs } = createContext();

		await executeWebSlashCommand("commands", "", context);

		expect(context.openCommandDrawer).toHaveBeenCalledOnce();
		expect(outputs).toEqual([]);
	});

	it("updates model state when a model is provided", async () => {
		const { context, outputs, apiClient } = createContext();

		await executeWebSlashCommand("model", "anthropic/claude-opus", context);

		expect(apiClient.setModel).toHaveBeenCalledWith("anthropic/claude-opus");
		expect(context.setCurrentModel).toHaveBeenCalledWith(
			"anthropic/claude-opus",
		);
		expect(context.updateModelMeta).toHaveBeenCalledOnce();
		expect(outputs).toEqual([
			{
				output: "Model set to anthropic/claude-opus",
				isError: false,
			},
		]);
	});

	it("searches the MCP registry from the web slash command", async () => {
		const { context, outputs, apiClient } = createContext();
		apiClient.searchMcpRegistry.mockResolvedValue({
			query: "linear",
			entries: [
				{
					displayName: "Linear",
					slug: "linear",
					transport: "http",
					url: "https://mcp.linear.app/mcp",
				},
			],
		});

		await executeWebSlashCommand("mcp", "search linear", context);

		expect(apiClient.searchMcpRegistry).toHaveBeenCalledWith("linear");
		expect(outputs).toEqual([
			expect.objectContaining({
				isError: false,
				output: expect.stringContaining(
					'Official MCP registry matches for "linear"',
				),
			}),
		]);
		expect(outputs[0]?.output).toContain("Linear");
	});

	it("lists MCP resources from the web slash command", async () => {
		const { context, outputs, apiClient } = createContext();
		apiClient.getMcpStatus.mockResolvedValue({
			authPresets: [],
			servers: [
				{
					name: "docs",
					connected: true,
					transport: "http",
					resources: ["memo://guide"],
					prompts: [],
				},
			],
		});

		await executeWebSlashCommand("mcp", "resources", context);

		expect(apiClient.getMcpStatus).toHaveBeenCalledOnce();
		expect(outputs).toEqual([
			expect.objectContaining({
				isError: false,
				output: expect.stringContaining("MCP Resources"),
			}),
		]);
		expect(outputs[0]?.output).toContain("memo://guide");
	});

	it("reads an MCP resource from the web slash command", async () => {
		const { context, outputs, apiClient } = createContext();
		apiClient.readMcpResource.mockResolvedValue({
			contents: [{ text: "Guide body", mimeType: "text/plain" }],
		});

		await executeWebSlashCommand("mcp", "resources docs memo://guide", context);

		expect(apiClient.readMcpResource).toHaveBeenCalledWith(
			"docs",
			"memo://guide",
		);
		expect(outputs).toEqual([
			expect.objectContaining({
				isError: false,
				output: expect.stringContaining("Guide body"),
			}),
		]);
	});

	it("lists MCP prompts from the web slash command", async () => {
		const { context, outputs, apiClient } = createContext();
		apiClient.getMcpStatus.mockResolvedValue({
			authPresets: [],
			servers: [
				{
					name: "docs",
					connected: true,
					transport: "http",
					resources: [],
					prompts: ["summarize"],
				},
			],
		});

		await executeWebSlashCommand("mcp", "prompts", context);

		expect(apiClient.getMcpStatus).toHaveBeenCalledOnce();
		expect(outputs).toEqual([
			expect.objectContaining({
				isError: false,
				output: expect.stringContaining("MCP Prompts"),
			}),
		]);
		expect(outputs[0]?.output).toContain("summarize");
	});

	it("gets an MCP prompt from the web slash command", async () => {
		const { context, outputs, apiClient } = createContext();
		apiClient.getMcpPrompt.mockResolvedValue({
			description: "Summarize docs",
			messages: [{ role: "user", content: "Summarize MCP" }],
		});

		await executeWebSlashCommand("mcp", "prompts docs summarize", context);

		expect(apiClient.getMcpPrompt).toHaveBeenCalledWith("docs", "summarize");
		expect(outputs).toEqual([
			expect.objectContaining({
				isError: false,
				output: expect.stringContaining("Summarize MCP"),
			}),
		]);
	});

	it("shows MCP auth presets in status output", async () => {
		const { context, outputs, apiClient } = createContext();
		apiClient.getMcpStatus.mockResolvedValue({
			authPresets: [
				{
					name: "linear-auth",
					scope: "local",
					headerKeys: ["Authorization"],
					headersHelper: "bun run scripts/mcp-headers.ts",
				},
			],
			servers: [
				{
					name: "linear",
					connected: true,
					transport: "http",
					scope: "project",
					remoteUrl: "https://mcp.linear.app/mcp",
					authPreset: "linear-auth",
					headerKeys: ["Authorization"],
					headersHelper: "bun run scripts/mcp-headers.ts",
				},
			],
		});

		await executeWebSlashCommand("mcp", "status", context);

		expect(outputs).toEqual([
			expect.objectContaining({
				isError: false,
				output: expect.stringContaining("MCP Auth Presets"),
			}),
		]);
		expect(outputs[0]?.output).toContain("auth preset: linear-auth");
	});

	it("imports an official MCP server from the web slash command", async () => {
		const { context, outputs, apiClient } = createContext();
		apiClient.importMcpRegistry.mockResolvedValue({
			name: "linear",
			scope: "local",
			path: "/tmp/project/.maestro/mcp.local.json",
			entry: {
				displayName: "Linear",
				slug: "linear",
				transport: "http",
				url: "https://mcp.linear.app/mcp",
			},
			server: {
				transport: "http",
				url: "https://mcp.linear.app/mcp",
				authPreset: "linear-auth",
			},
		});

		await executeWebSlashCommand(
			"mcp",
			"import linear --auth-preset linear-auth",
			context,
		);

		expect(apiClient.importMcpRegistry).toHaveBeenCalledWith({
			query: "linear",
			name: undefined,
			scope: undefined,
			url: undefined,
			headers: undefined,
			headersHelper: undefined,
			authPreset: "linear-auth",
			transport: undefined,
		});
		expect(outputs).toEqual([
			expect.objectContaining({
				isError: false,
				output: expect.stringContaining(
					'Imported official MCP server "linear"',
				),
			}),
		]);
	});

	it("adds a remote MCP server from the web slash command", async () => {
		const { context, outputs, apiClient } = createContext();
		apiClient.addMcpServer.mockResolvedValue({
			name: "custom-docs",
			scope: "project",
			path: "/repo/.maestro/mcp.json",
			server: {
				name: "custom-docs",
				transport: "http",
				url: "https://docs.example.com/mcp",
				headersHelper: "bun run scripts/mcp-headers.ts",
				authPreset: "linear-auth",
			},
		});

		await executeWebSlashCommand(
			"mcp",
			"add custom-docs https://docs.example.com/mcp --scope project --headers-helper 'bun run scripts/mcp-headers.ts' --auth-preset linear-auth",
			context,
		);

		expect(apiClient.addMcpServer).toHaveBeenCalledWith({
			scope: "project",
			server: expect.objectContaining({
				name: "custom-docs",
				transport: "http",
				url: "https://docs.example.com/mcp",
				headersHelper: "bun run scripts/mcp-headers.ts",
				authPreset: "linear-auth",
			}),
		});
		expect(outputs).toEqual([
			expect.objectContaining({
				isError: false,
				output: expect.stringContaining('Added MCP server "custom-docs"'),
			}),
		]);
	});

	it("rejects unknown MCP add flags instead of treating them as command args", async () => {
		const { context, outputs, apiClient } = createContext();

		await executeWebSlashCommand(
			"mcp",
			"add custom-docs https://docs.example.com/mcp --bogus",
			context,
		);

		expect(apiClient.addMcpServer).not.toHaveBeenCalled();
		expect(outputs).toEqual([
			{
				output: expect.stringContaining("Unknown MCP option: --bogus"),
				isError: true,
			},
		]);
	});

	it("edits a stdio MCP server from the web slash command", async () => {
		const { context, outputs, apiClient } = createContext();
		apiClient.updateMcpServer.mockResolvedValue({
			name: "filesystem",
			scope: "local",
			path: "/repo/.maestro/mcp.local.json",
			server: {
				name: "filesystem",
				transport: "stdio",
				command: "npx",
				args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
				cwd: "/repo",
				env: { DEBUG: "1" },
			},
		});

		await executeWebSlashCommand(
			"mcp",
			"edit filesystem --scope local --cwd /repo --env DEBUG=1 -- npx -y @modelcontextprotocol/server-filesystem /tmp",
			context,
		);

		expect(apiClient.updateMcpServer).toHaveBeenCalledWith({
			name: "filesystem",
			scope: "local",
			server: expect.objectContaining({
				name: "filesystem",
				transport: "stdio",
				command: "npx",
				args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
				cwd: "/repo",
				env: { DEBUG: "1" },
			}),
		});
		expect(outputs).toEqual([
			expect.objectContaining({
				isError: false,
				output: expect.stringContaining('Updated MCP server "filesystem"'),
			}),
		]);
	});

	it("removes an MCP server from the web slash command", async () => {
		const { context, outputs, apiClient } = createContext();
		apiClient.removeMcpServer.mockResolvedValue({
			name: "linear",
			scope: "project",
			path: "/repo/.maestro/mcp.json",
			fallback: {
				name: "linear",
				scope: "user",
			},
		});

		await executeWebSlashCommand(
			"mcp",
			"remove linear --scope project",
			context,
		);

		expect(apiClient.removeMcpServer).toHaveBeenCalledWith({
			name: "linear",
			scope: "project",
		});
		expect(outputs).toEqual([
			expect.objectContaining({
				isError: false,
				output: expect.stringContaining("fallback: linear (user)"),
			}),
		]);
	});

	it("lists MCP auth presets from the web slash command", async () => {
		const { context, outputs, apiClient } = createContext();
		apiClient.getMcpStatus.mockResolvedValue({
			authPresets: [
				{
					name: "linear-auth",
					scope: "local",
					headerKeys: ["Authorization"],
					headersHelper: "bun run scripts/mcp-headers.ts",
				},
			],
			servers: [],
		});

		await executeWebSlashCommand("mcp", "auth", context);

		expect(outputs).toEqual([
			expect.objectContaining({
				isError: false,
				output: expect.stringContaining("MCP Auth Presets"),
			}),
		]);
	});

	it("adds an MCP auth preset from the web slash command", async () => {
		const { context, outputs, apiClient } = createContext();
		apiClient.addMcpAuthPreset.mockResolvedValue({
			name: "linear-auth",
			scope: "project",
			path: "/repo/.maestro/mcp.json",
			preset: {
				name: "linear-auth",
				headers: { Authorization: "Bearer test" },
				headersHelper: "bun run scripts/mcp-headers.ts",
			},
		});

		await executeWebSlashCommand(
			"mcp",
			"auth add linear-auth --scope project --header 'Authorization: Bearer test' --headers-helper 'bun run scripts/mcp-headers.ts'",
			context,
		);

		expect(apiClient.addMcpAuthPreset).toHaveBeenCalledWith({
			scope: "project",
			preset: {
				name: "linear-auth",
				headers: { Authorization: "Bearer test" },
				headersHelper: "bun run scripts/mcp-headers.ts",
			},
		});
		expect(outputs).toEqual([
			expect.objectContaining({
				isError: false,
				output: expect.stringContaining('Added MCP auth preset "linear-auth"'),
			}),
		]);
	});

	it("removes an MCP auth preset from the web slash command", async () => {
		const { context, outputs, apiClient } = createContext();
		apiClient.removeMcpAuthPreset.mockResolvedValue({
			name: "linear-auth",
			scope: "project",
			path: "/repo/.maestro/mcp.json",
			fallback: {
				name: "linear-auth",
				scope: "user",
			},
		});

		await executeWebSlashCommand(
			"mcp",
			"auth remove linear-auth --scope project",
			context,
		);

		expect(apiClient.removeMcpAuthPreset).toHaveBeenCalledWith({
			name: "linear-auth",
			scope: "project",
		});
		expect(outputs).toEqual([
			expect.objectContaining({
				isError: false,
				output: expect.stringContaining("fallback: linear-auth (user)"),
			}),
		]);
	});

	it("shows the full MCP import usage in help output", async () => {
		const { context, outputs } = createContext();

		await executeWebSlashCommand("mcp", "help", context);

		expect(outputs).toEqual([
			expect.objectContaining({
				isError: false,
				output: expect.stringContaining("/mcp resources [server uri]"),
			}),
		]);
		expect(outputs[0]?.output).toContain("/mcp prompts [server name]");
	});

	it("inserts custom command prompts by command name", async () => {
		const customCommand = {
			name: "triage",
			description: "Triage an issue",
			usage: "/triage issue=<value>",
			source: "custom" as const,
			prompt: "Triage issue {{issue}}",
			args: [{ name: "issue", required: true }],
		};
		const setInputValue = vi.fn();
		const { context, outputs } = createContext({
			commands: [...WEB_SLASH_COMMANDS, customCommand],
			setInputValue,
		});

		await executeWebSlashCommand("triage", "issue=42", context);

		expect(setInputValue).toHaveBeenCalledWith("Triage issue 42");
		expect(outputs).toEqual([
			{
				output: 'Inserted command "triage". Edit then submit.',
				isError: false,
			},
		]);
	});

	it("validates custom /commands run invocations", async () => {
		const customCommand = {
			name: "triage",
			description: "Triage an issue",
			usage: "/triage issue=<value>",
			source: "custom" as const,
			prompt: "Triage issue {{issue}}",
			args: [{ name: "issue", required: true }],
		};
		const setInputValue = vi.fn();
		const { context, outputs } = createContext({
			commands: [...WEB_SLASH_COMMANDS, customCommand],
			setInputValue,
		});

		await executeWebSlashCommand("commands", "run triage", context);

		expect(setInputValue).not.toHaveBeenCalled();
		expect(outputs).toEqual([
			{
				output: "Missing required arg: issue\nUsage: /triage issue=<value>",
				isError: true,
			},
		]);
	});
});
