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
		addPackage: vi.fn(),
		cancelQueuedPrompt: vi.fn(),
		clearMemory: vi.fn(),
		createBranch: vi.fn(),
		deleteMemory: vi.fn(),
		enterPlanMode: vi.fn(),
		exitPlanMode: vi.fn(),
		exportMemory: vi.fn(),
		getApprovalMode: vi.fn(),
		getConfig: vi.fn(),
		getDiagnostics: vi.fn(),
		getFiles: vi.fn(),
		getMemoryStats: vi.fn(),
		getMcpStatus: vi.fn(),
		getMcpPrompt: vi.fn(),
		getPackageStatus: vi.fn(),
		getPlan: vi.fn(),
		getPreview: vi.fn(),
		getQueueStatus: vi.fn(),
		getRecentMemories: vi.fn(),
		getReview: vi.fn(),
		getRunScripts: vi.fn(),
		importMcpRegistry: vi.fn(),
		importMemory: vi.fn(),
		getStats: vi.fn(),
		getStatus: vi.fn(),
		getTelemetryStatus: vi.fn(),
		getUsage: vi.fn(),
		inspectPackage: vi.fn(),
		listBranchOptions: vi.fn(),
		listMemoryTopic: vi.fn(),
		listMemoryTopics: vi.fn(),
		listQueue: vi.fn(),
		readMcpResource: vi.fn(),
		refreshAllPackages: vi.fn(),
		refreshPackage: vi.fn(),
		removeMcpAuthPreset: vi.fn(),
		removeMcpServer: vi.fn(),
		removePackage: vi.fn(),
		runScript: vi.fn(),
		saveMemory: vi.fn(),
		saveConfig: vi.fn(),
		searchMemory: vi.fn(),
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
		validatePackage: vi.fn(),
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

	it("lists memory topics from the web slash command", async () => {
		const { context, outputs, apiClient } = createContext();
		apiClient.listMemoryTopics.mockResolvedValue({
			topics: [
				{
					name: "api-design",
					entryCount: 2,
					lastUpdated: Date.now(),
				},
			],
		});

		await executeWebSlashCommand("memory", "list", context);

		expect(apiClient.listMemoryTopics).toHaveBeenCalledWith(undefined);
		expect(outputs).toEqual([
			expect.objectContaining({
				isError: false,
				output: expect.stringContaining("Memory Topics (1)"),
			}),
		]);
		expect(outputs[0]?.output).toContain("api-design");
	});

	it("saves memory from the web slash command", async () => {
		const { context, outputs, apiClient } = createContext();
		apiClient.saveMemory.mockResolvedValue({
			message: 'Memory saved to topic "api design"',
			entry: {
				id: "mem_123",
				topic: "api design",
				content: "Use REST conventions #rest",
				updatedAt: Date.now(),
				tags: ["rest"],
			},
		});

		await executeWebSlashCommand(
			"memory",
			'save "api design" Use REST conventions #rest',
			context,
		);

		expect(apiClient.saveMemory).toHaveBeenCalledWith(
			"api design",
			"Use REST conventions #rest",
			["rest"],
			"session-1",
		);
		expect(outputs).toEqual([
			{
				output: 'Memory saved to topic "api design"',
				isError: false,
			},
		]);
	});

	it("deduplicates repeated memory tags in the web slash command", async () => {
		const { context, apiClient } = createContext();

		await executeWebSlashCommand(
			"memory",
			'save "api design" Use REST conventions #rest #rest #api',
			context,
		);

		expect(apiClient.saveMemory).toHaveBeenCalledWith(
			"api design",
			"Use REST conventions #rest #rest #api",
			["rest", "api"],
			"session-1",
		);
	});

	it("lists configured packages from the web slash command", async () => {
		const { context, outputs, apiClient } = createContext();
		apiClient.getPackageStatus.mockResolvedValue({
			packages: [
				{
					scope: "local",
					configPath: "/repo/.maestro/config.local.toml",
					sourceSpec: "../vendor/pack",
					filters: null,
					error: null,
					inspection: {
						sourceSpec: "../vendor/pack",
						resolvedSource: "local:/repo/vendor/pack",
						sourceType: "local",
						resolvedPath: "/repo/vendor/pack",
						discovered: {
							name: "@test/package",
							version: "1.0.0",
							isMaestroPackage: true,
							hasManifest: true,
							manifestPaths: { skills: ["./skills"] },
							errors: [],
						},
						resources: {
							extensions: [],
							skills: ["/repo/vendor/pack/skills/pkg-skill"],
							prompts: [],
							themes: [],
						},
					},
				},
			],
		});

		await executeWebSlashCommand("package", "list", context);

		expect(apiClient.getPackageStatus).toHaveBeenCalledOnce();
		expect(outputs).toEqual([
			expect.objectContaining({
				isError: false,
				output: expect.stringContaining("Configured Maestro Packages:"),
			}),
		]);
		expect(outputs[0]?.output).toContain("@test/package");
	});

	it("adds a configured package from the web slash command", async () => {
		const { context, outputs, apiClient } = createContext();
		apiClient.addPackage.mockResolvedValue({
			path: "/repo/.maestro/config.local.toml",
			scope: "local",
			spec: "../vendor/pack",
		});

		await executeWebSlashCommand("package", "add ./vendor/pack", context);

		expect(apiClient.addPackage).toHaveBeenCalledWith({
			source: "./vendor/pack",
			scope: undefined,
		});
		expect(outputs).toEqual([
			expect.objectContaining({
				isError: false,
				output: expect.stringContaining(
					'Added configured package "./vendor/pack"',
				),
			}),
		]);
	});

	it("removes a configured package from the web slash command", async () => {
		const { context, outputs, apiClient } = createContext();
		apiClient.removePackage.mockResolvedValue({
			path: "/repo/.maestro/config.local.toml",
			scope: "local",
			removedCount: 1,
			fallback: {
				scope: "project",
				sourceSpec: "../vendor/pack",
			},
		});

		await executeWebSlashCommand("package", "remove ./vendor/pack", context);

		expect(apiClient.removePackage).toHaveBeenCalledWith({
			source: "./vendor/pack",
			scope: undefined,
		});
		expect(outputs).toEqual([
			expect.objectContaining({
				isError: false,
				output: expect.stringContaining(
					"fallback: still configured in project",
				),
			}),
		]);
	});

	it("refreshes a configured package from the web slash command", async () => {
		const { context, outputs, apiClient } = createContext();
		apiClient.refreshPackage.mockResolvedValue({
			inspection: {
				sourceSpec: "git:github.com/acme/pack@main",
				resolvedSource: "git:github.com/acme/pack@main",
				sourceType: "git",
				resolvedPath: "/repo/.maestro/packages/git-1234",
				discovered: {
					name: "@acme/pack",
					version: "1.2.0",
					isMaestroPackage: true,
					hasManifest: true,
					manifestPaths: { skills: ["./skills"] },
					errors: [],
				},
				resources: {
					extensions: [],
					skills: ["/repo/.maestro/packages/git-1234/skills/pkg-skill"],
					prompts: [],
					themes: [],
				},
			},
			issues: [],
		});

		await executeWebSlashCommand(
			"package",
			"refresh git:github.com/acme/pack@main",
			context,
		);

		expect(apiClient.refreshPackage).toHaveBeenCalledWith(
			"git:github.com/acme/pack@main",
		);
		expect(outputs).toEqual([
			expect.objectContaining({
				isError: false,
				output: expect.stringContaining("Package refresh completed."),
			}),
		]);
		expect(outputs[0]?.output).toContain("@acme/pack");
	});

	it("refreshes all configured remote packages from the web slash command", async () => {
		const { context, outputs, apiClient } = createContext();
		apiClient.refreshAllPackages.mockResolvedValue({
			refreshed: [
				{
					source: "git:github.com/acme/pack@main",
					sourceType: "git",
					scopes: ["project"],
					inspection: {
						sourceSpec: "git:github.com/acme/pack@main",
						resolvedSource: "git:github.com/acme/pack@main",
						sourceType: "git",
						resolvedPath: "/repo/.maestro/packages/git-1234",
						discovered: {
							name: "@acme/pack",
							version: "1.2.1",
							isMaestroPackage: true,
							hasManifest: true,
							manifestPaths: { skills: ["./skills"] },
							errors: [],
						},
						resources: {
							extensions: [],
							skills: ["/repo/.maestro/packages/git-1234/skills/pkg-skill"],
							prompts: [],
							themes: [],
						},
					},
					issues: [],
					error: null,
				},
			],
			localCount: 1,
			remoteCount: 1,
		});

		await executeWebSlashCommand("package", "refresh --all", context);

		expect(apiClient.refreshAllPackages).toHaveBeenCalledTimes(1);
		expect(outputs).toEqual([
			expect.objectContaining({
				isError: false,
				output: expect.stringContaining(
					"Configured package refresh completed.",
				),
			}),
		]);
		expect(outputs[0]?.output).toContain("Remote packages: 1");
		expect(outputs[0]?.output).toContain("@acme/pack");
	});

	it("requires force before clearing memory from the web slash command", async () => {
		const { context, outputs, apiClient } = createContext();

		await executeWebSlashCommand("memory", "clear", context);

		expect(apiClient.clearMemory).not.toHaveBeenCalled();
		expect(outputs).toEqual([
			{
				output:
					"This will delete ALL memories. Use /memory clear --force to confirm.",
				isError: true,
			},
		]);
	});

	it("blocks memory export in shared sessions", async () => {
		const { context, outputs, apiClient } = createContext({
			isSharedSession: true,
		});

		await executeWebSlashCommand("memory", "export", context);

		expect(apiClient.exportMemory).not.toHaveBeenCalled();
		expect(outputs).toEqual([
			{
				output: "Memory export is disabled in shared sessions.",
				isError: true,
			},
		]);
	});

	it("searches memory from the web slash command", async () => {
		const { context, outputs, apiClient } = createContext();
		apiClient.searchMemory.mockResolvedValue({
			query: "REST",
			results: [
				{
					entry: {
						id: "mem_123",
						topic: "api-design",
						content: "Use REST conventions",
						updatedAt: Date.now(),
						tags: ["rest"],
					},
					score: 4.2,
					matchedOn: "content",
				},
			],
		});

		await executeWebSlashCommand("memory", "search REST", context);

		expect(apiClient.searchMemory).toHaveBeenCalledWith("REST", 10, undefined);
		expect(outputs).toEqual([
			expect.objectContaining({
				isError: false,
				output: expect.stringContaining('Search Results for "REST"'),
			}),
		]);
		expect(outputs[0]?.output).toContain("api-design");
		expect(outputs[0]?.output).toContain("Use REST conventions");
	});

	it("filters memory reads to the current session when requested", async () => {
		const { context, apiClient } = createContext();

		await executeWebSlashCommand("memory", "list --session", context);
		expect(apiClient.listMemoryTopics).toHaveBeenCalledWith("session-1");

		await executeWebSlashCommand("memory", "search REST --session", context);
		expect(apiClient.searchMemory).toHaveBeenCalledWith(
			"REST",
			10,
			"session-1",
		);

		await executeWebSlashCommand("memory", "recent 5 --session", context);
		expect(apiClient.getRecentMemories).toHaveBeenCalledWith(5, "session-1");
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
					promptDetails: [
						{
							name: "summarize",
							title: "Summarize docs",
							description: "Summarize the selected documentation",
							arguments: [
								{
									name: "topic",
									description: "Topic to summarize",
									required: true,
								},
							],
						},
					],
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
		expect(outputs[0]?.output).toContain("title: Summarize docs");
		expect(outputs[0]?.output).toContain(
			"args: topic (required): Topic to summarize",
		);
	});

	it("filters MCP prompts to a single server in the web slash command", async () => {
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
					promptDetails: [
						{
							name: "summarize",
							title: "Summarize docs",
							description: "Summarize the selected documentation",
							arguments: [],
						},
					],
				},
				{
					name: "notes",
					connected: true,
					transport: "http",
					resources: [],
					prompts: ["recap"],
					promptDetails: [
						{
							name: "recap",
							title: "Recap notes",
							description: "Recap the latest notes",
							arguments: [],
						},
					],
				},
			],
		});

		await executeWebSlashCommand("mcp", "prompts docs", context);

		expect(apiClient.getMcpStatus).toHaveBeenCalledOnce();
		expect(outputs).toEqual([
			expect.objectContaining({
				isError: false,
				output: expect.stringContaining("docs:"),
			}),
		]);
		expect(outputs[0]?.output).toContain("summarize");
		expect(outputs[0]?.output).not.toContain("notes:");
		expect(outputs[0]?.output).not.toContain("recap");
	});

	it("shows MCP prompt listing errors as plain text", async () => {
		const { context, outputs, apiClient } = createContext();
		apiClient.getMcpStatus.mockResolvedValue({
			authPresets: [],
			servers: [
				{
					name: "docs",
					connected: false,
					transport: "http",
					resources: [],
					prompts: [],
					promptDetails: [],
				},
			],
		});

		await executeWebSlashCommand("mcp", "prompts docs", context);

		expect(outputs).toEqual([
			{
				output: "MCP server 'docs' is not connected.",
				isError: true,
			},
		]);
		expect(outputs[0]?.output).not.toContain("```");
	});

	it("gets an MCP prompt from the web slash command", async () => {
		const { context, outputs, apiClient } = createContext();
		apiClient.getMcpPrompt.mockResolvedValue({
			description: "Summarize docs",
			messages: [{ role: "user", content: "Summarize MCP" }],
		});

		await executeWebSlashCommand("mcp", "prompts docs summarize", context);

		expect(apiClient.getMcpPrompt).toHaveBeenCalledWith(
			"docs",
			"summarize",
			undefined,
		);
		expect(outputs).toEqual([
			expect.objectContaining({
				isError: false,
				output: expect.stringContaining("Summarize MCP"),
			}),
		]);
	});

	it("passes KEY=value prompt args through the web slash command", async () => {
		const { context, apiClient } = createContext();
		apiClient.getMcpPrompt.mockResolvedValue({
			description: "Summarize docs",
			messages: [{ role: "user", content: "Summarize MCP auth flow" }],
		});

		await executeWebSlashCommand(
			"mcp",
			'prompts docs summarize topic="MCP auth flow" format=brief',
			context,
		);

		expect(apiClient.getMcpPrompt).toHaveBeenCalledWith("docs", "summarize", {
			topic: "MCP auth flow",
			format: "brief",
		});
	});

	it("shows an error for invalid MCP prompt args in the web slash command", async () => {
		const { context, outputs, apiClient } = createContext();

		await executeWebSlashCommand(
			"mcp",
			"prompts docs summarize invalid-arg",
			context,
		);

		expect(apiClient.getMcpPrompt).not.toHaveBeenCalled();
		expect(outputs).toEqual([
			{
				output:
					"Invalid MCP prompt argument. Use KEY=value after the prompt name.",
				isError: true,
			},
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
		expect(outputs[0]?.output).toContain(
			"/mcp prompts [server [name KEY=value...]]",
		);
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
