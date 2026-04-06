import { describe, expect, it } from "vitest";
import {
	buildComposerProfilesViewModel,
	buildLspViewModel,
	buildMcpRegistryEntryViewModel,
	buildMcpServerViewModel,
	formatMcpArgsText,
	formatMcpKeyValueText,
	formatMcpPromptResult,
	formatMcpRegistryImportMessage,
	formatMcpResourceReadResult,
	formatMcpServerAddMessage,
	formatMcpServerRemoveMessage,
	formatMcpServerUpdateMessage,
	formatMcpTimeoutText,
	getMcpRegistryEntryId,
	parseMcpArgsText,
	parseMcpKeyValueText,
	parseMcpTimeoutText,
	resolveComposerSelection,
} from "../../packages/desktop/src/renderer/components/Settings/ToolsRuntimeSection";

describe("buildLspViewModel", () => {
	it("summarizes active servers and detections", () => {
		const viewModel = buildLspViewModel(
			{
				enabled: true,
				autostart: false,
				servers: [
					{
						id: "typescript",
						root: "/repo",
						initialized: true,
						fileCount: 12,
						diagnosticCount: 3,
					},
					{
						id: "eslint",
						root: "/repo",
						initialized: true,
						fileCount: 4,
						diagnosticCount: 1,
					},
				],
			},
			[
				{ serverId: "typescript", root: "/repo" },
				{ serverId: "eslint", root: "/repo" },
			],
		);

		expect(viewModel.enabledLabel).toBe("Yes");
		expect(viewModel.autostartLabel).toBe("No");
		expect(viewModel.serverCount).toBe(2);
		expect(viewModel.detectionsLabel).toBe("typescript, eslint");
		expect(viewModel.servers).toEqual([
			{ id: "typescript", summary: "12 files · 3 diag" },
			{ id: "eslint", summary: "4 files · 1 diag" },
		]);
	});

	it("falls back to disabled labels when status is missing", () => {
		const viewModel = buildLspViewModel(null, []);

		expect(viewModel.enabledLabel).toBe("No");
		expect(viewModel.autostartLabel).toBe("No");
		expect(viewModel.serverCount).toBe(0);
		expect(viewModel.detectionsLabel).toBe("");
		expect(viewModel.servers).toEqual([]);
	});
});

describe("buildMcpServerViewModel", () => {
	it("summarizes expanded servers with tool details", () => {
		const viewModel = buildMcpServerViewModel(
			{
				name: "filesystem",
				connected: true,
				scope: "project",
				transport: "stdio",
				tools: [{ name: "read_file", description: "Read a file" }],
				resources: ["repo://root"],
				prompts: ["summarize"],
			},
			"filesystem",
		);

		expect(viewModel.summary).toBe(
			"Connected · Project config · via stdio · 1 tool · 1 resource · 1 prompt",
		);
		expect(viewModel.isExpanded).toBe(true);
		expect(viewModel.transport).toBe("stdio");
		expect(viewModel.writableScope).toBe("project");
		expect(viewModel.sourceLabel).toBe("Project config");
		expect(viewModel.transportLabel).toBe("stdio");
		expect(viewModel.remoteTrustLabel).toBeNull();
		expect(viewModel.errorLabel).toBeNull();
		expect(viewModel.command).toBeNull();
		expect(viewModel.args).toEqual([]);
		expect(viewModel.cwd).toBeNull();
		expect(viewModel.envKeys).toEqual([]);
		expect(viewModel.headerKeys).toEqual([]);
		expect(viewModel.headersHelper).toBeNull();
		expect(viewModel.timeout).toBeNull();
		expect(viewModel.toolCount).toBe(1);
		expect(viewModel.tools).toEqual([
			{ name: "read_file", description: "Read a file" },
		]);
		expect(viewModel.toolDetailsLabel).toBeNull();
	});

	it("preserves numeric tool counts when details are unavailable", () => {
		const viewModel = buildMcpServerViewModel(
			{
				name: "remote",
				connected: false,
				scope: "user",
				transport: "http",
				tools: 3,
				resources: [],
				prompts: [],
				error: "Connection refused",
			},
			null,
		);

		expect(viewModel.summary).toBe(
			"Offline · User config · via HTTP · 3 tools · 0 resources · 0 prompts",
		);
		expect(viewModel.isExpanded).toBe(false);
		expect(viewModel.writableScope).toBe("user");
		expect(viewModel.sourceLabel).toBe("User config");
		expect(viewModel.transportLabel).toBe("HTTP");
		expect(viewModel.remoteTrustLabel).toBeNull();
		expect(viewModel.errorLabel).toBe("Connection refused");
		expect(viewModel.command).toBeNull();
		expect(viewModel.args).toEqual([]);
		expect(viewModel.cwd).toBeNull();
		expect(viewModel.envKeys).toEqual([]);
		expect(viewModel.headerKeys).toEqual([]);
		expect(viewModel.headersHelper).toBeNull();
		expect(viewModel.timeout).toBeNull();
		expect(viewModel.tools).toEqual([]);
		expect(viewModel.toolDetailsLabel).toBe(
			"3 tools reported (details unavailable).",
		);
	});

	it("reports empty tool state when nothing is available", () => {
		const viewModel = buildMcpServerViewModel(
			{
				name: "empty",
				connected: true,
			},
			null,
		);

		expect(viewModel.toolCount).toBe(0);
		expect(viewModel.writableScope).toBeNull();
		expect(viewModel.sourceLabel).toBeNull();
		expect(viewModel.transportLabel).toBeNull();
		expect(viewModel.remoteTrustLabel).toBeNull();
		expect(viewModel.errorLabel).toBeNull();
		expect(viewModel.toolDetailsLabel).toBe("No tools reported.");
		expect(viewModel.resources).toEqual([]);
		expect(viewModel.prompts).toEqual([]);
	});

	it("falls back to a generic error message for blank server errors", () => {
		const viewModel = buildMcpServerViewModel(
			{
				name: "blank-error",
				connected: false,
				error: "   ",
			},
			null,
		);

		expect(viewModel.errorLabel).toBe("Connection failed.");
	});

	it("exposes remote trust and official registry metadata", () => {
		const viewModel = buildMcpServerViewModel(
			{
				name: "linear",
				connected: true,
				transport: "http",
				remoteTrust: "official",
				remoteHost: "mcp.linear.app",
				remoteUrl: "https://mcp.linear.app/mcp",
				officialRegistry: {
					displayName: "Linear",
					directoryUrl:
						"https://registry.modelcontextprotocol.io/servers/linear",
					documentationUrl: "https://linear.app/docs/mcp",
					authorName: "Linear",
					permissions: "Read issues and write comments",
				},
			},
			"linear",
		);

		expect(viewModel.remoteTrustLabel).toBe("Official remote");
		expect(viewModel.remoteHost).toBe("mcp.linear.app");
		expect(viewModel.remoteUrl).toBe("https://mcp.linear.app/mcp");
		expect(viewModel.headerKeys).toEqual([]);
		expect(viewModel.headersHelper).toBeNull();
		expect(viewModel.timeout).toBeNull();
		expect(viewModel.officialRegistryName).toBe("Linear");
		expect(viewModel.officialRegistryDirectoryUrl).toContain(
			"registry.modelcontextprotocol.io",
		);
		expect(viewModel.officialRegistryDocumentationUrl).toContain(
			"linear.app/docs/mcp",
		);
		expect(viewModel.officialRegistryAuthor).toBe("Linear");
		expect(viewModel.officialRegistryPermissions).toBe(
			"Read issues and write comments",
		);
	});

	it("exposes stdio command details", () => {
		const viewModel = buildMcpServerViewModel(
			{
				name: "filesystem",
				connected: true,
				scope: "local",
				transport: "stdio",
				command: "npx",
				args: ["-y", "@modelcontextprotocol/server-filesystem", "/repo"],
				cwd: "/repo",
				envKeys: ["HOME", "TOKEN"],
				timeout: 30_000,
				tools: [],
				resources: [],
				prompts: [],
			},
			null,
		);

		expect(viewModel.command).toBe("npx");
		expect(viewModel.args).toEqual([
			"-y",
			"@modelcontextprotocol/server-filesystem",
			"/repo",
		]);
		expect(viewModel.cwd).toBe("/repo");
		expect(viewModel.envKeys).toEqual(["HOME", "TOKEN"]);
		expect(viewModel.timeout).toBe(30_000);
	});

	it("exposes remote helper and header metadata", () => {
		const viewModel = buildMcpServerViewModel(
			{
				name: "linear",
				connected: true,
				scope: "local",
				transport: "http",
				remoteUrl: "https://mcp.linear.app/mcp",
				headerKeys: ["Authorization", "X-Org"],
				headersHelper: "bun run scripts/mcp-headers.ts",
				timeout: 20_000,
				tools: [],
				resources: [],
				prompts: [],
			},
			null,
		);

		expect(viewModel.headerKeys).toEqual(["Authorization", "X-Org"]);
		expect(viewModel.headersHelper).toBe("bun run scripts/mcp-headers.ts");
		expect(viewModel.timeout).toBe(20_000);
	});
});

describe("MCP inspector formatting", () => {
	it("formats MCP resource reads for display", () => {
		expect(
			formatMcpResourceReadResult({
				contents: [
					{
						uri: "linear://workspace",
						mimeType: "text/plain",
						text: "workspace content",
					},
				],
			}),
		).toBe("linear://workspace\nmime: text/plain\n\nworkspace content");
	});

	it("formats MCP prompt results for display", () => {
		expect(
			formatMcpPromptResult({
				description: "Summarize a Linear issue",
				messages: [
					{
						role: "user",
						content: "Summarize issue MAE-1",
					},
				],
			}),
		).toBe("Summarize a Linear issue\n\nuser:\nSummarize issue MAE-1");
	});
});

describe("MCP registry entry view models", () => {
	it("builds an import-friendly registry entry summary", () => {
		const viewModel = buildMcpRegistryEntryViewModel(
			{
				displayName: "Linear",
				slug: "linear",
				oneLiner: "Track issues and projects.",
				authorName: "Linear",
				permissions: "Read issues and write comments",
				transport: "http",
				toolCount: 12,
				promptCount: 2,
				urlOptions: [
					{
						url: "https://mcp.linear.app/mcp",
						label: "Production",
					},
				],
				directoryUrl: "https://registry.modelcontextprotocol.io/servers/linear",
				documentationUrl: "https://linear.app/docs/mcp",
			},
			0,
		);

		expect(viewModel.id).toBe("linear");
		expect(viewModel.importQuery).toBe("linear");
		expect(viewModel.title).toBe("Linear");
		expect(viewModel.description).toBe("Track issues and projects.");
		expect(viewModel.summary).toBe(
			"via HTTP · by Linear · 12 tools · 2 prompts",
		);
		expect(viewModel.transportLabel).toBe("HTTP");
		expect(viewModel.countsLabel).toBe("12 tools · 2 prompts");
		expect(viewModel.authorLabel).toBe("Linear");
		expect(viewModel.permissionsLabel).toBe("Read issues and write comments");
		expect(viewModel.defaultUrl).toBe("https://mcp.linear.app/mcp");
		expect(viewModel.urlOptions).toEqual([
			{
				url: "https://mcp.linear.app/mcp",
				label: "Production",
			},
		]);
	});

	it("derives stable ids when the registry entry lacks a slug", () => {
		const id = getMcpRegistryEntryId(
			{
				displayName: "Acme Docs",
			},
			3,
		);

		expect(id).toBe("acme-docs");
	});

	it("formats the import confirmation message", () => {
		const message = formatMcpRegistryImportMessage({
			name: "linear",
			scope: "project",
			path: "/repo/.maestro/mcp.json",
			entry: {
				displayName: "Linear",
			},
			server: {
				transport: "http",
				url: "https://mcp.linear.app/mcp",
			},
		});

		expect(message).toBe("Imported linear into Project config via HTTP.");
	});

	it("formats the custom add confirmation message", () => {
		const message = formatMcpServerAddMessage({
			name: "custom-docs",
			scope: "local",
			path: "/repo/.maestro/mcp.local.json",
			server: {
				name: "custom-docs",
				transport: "sse",
				url: "https://docs.example.com/sse",
			},
		});

		expect(message).toBe("Added custom-docs to Local config via SSE.");
	});

	it("formats the remove confirmation message with fallback details", () => {
		const message = formatMcpServerRemoveMessage({
			name: "linear",
			scope: "local",
			path: "/repo/.maestro/mcp.local.json",
			fallback: {
				name: "linear",
				scope: "user",
			},
		});

		expect(message).toBe(
			"Removed linear from Local config. Now using linear from User config.",
		);
	});

	it("formats the update confirmation message", () => {
		const message = formatMcpServerUpdateMessage({
			name: "linear",
			scope: "project",
			path: "/repo/.maestro/mcp.json",
			server: {
				name: "linear",
				transport: "http",
				url: "https://mcp.linear.app/v2",
			},
		});

		expect(message).toBe("Updated linear in Project config via HTTP.");
	});

	it("formats and parses MCP argument text", () => {
		expect(
			formatMcpArgsText([
				"-y",
				"@modelcontextprotocol/server-filesystem",
				"/repo",
			]),
		).toBe("-y\n@modelcontextprotocol/server-filesystem\n/repo");
		expect(
			parseMcpArgsText("-y\n@modelcontextprotocol/server-filesystem\n/repo"),
		).toEqual(["-y", "@modelcontextprotocol/server-filesystem", "/repo"]);
		expect(parseMcpArgsText(" \n \n")).toBeUndefined();
	});

	it("formats and parses MCP key-value text and timeout", () => {
		expect(
			formatMcpKeyValueText({
				Authorization: "Bearer token",
				"X-Org": "acme",
			}),
		).toBe("Authorization=Bearer token\nX-Org=acme");
		expect(
			parseMcpKeyValueText("Authorization=Bearer token\nX-Org=acme"),
		).toEqual({
			Authorization: "Bearer token",
			"X-Org": "acme",
		});
		expect(formatMcpTimeoutText(15_000)).toBe("15000");
		expect(parseMcpTimeoutText("15000")).toBe(15_000);
		expect(parseMcpKeyValueText(" \n")).toBeUndefined();
		expect(parseMcpTimeoutText("")).toBeUndefined();
	});
});

describe("buildComposerProfilesViewModel", () => {
	it("reports active composer state and activation availability", () => {
		const viewModel = buildComposerProfilesViewModel(
			{
				composers: [{ name: "default" }, { name: "reviewer" }],
				active: { name: "reviewer" },
			},
			"default",
		);

		expect(viewModel.options.map((composer) => composer.name)).toEqual([
			"default",
			"reviewer",
		]);
		expect(viewModel.activeLabel).toBe("reviewer");
		expect(viewModel.canActivate).toBe(true);
	});

	it("handles missing composer status", () => {
		const viewModel = buildComposerProfilesViewModel(null, "");

		expect(viewModel.options).toEqual([]);
		expect(viewModel.activeLabel).toBe("none");
		expect(viewModel.canActivate).toBe(false);
	});
});

describe("resolveComposerSelection", () => {
	it("prefers the active composer", () => {
		const nextSelection = resolveComposerSelection(
			{
				composers: [{ name: "default" }, { name: "reviewer" }],
				active: { name: "reviewer" },
			},
			"default",
		);

		expect(nextSelection).toBe("reviewer");
	});

	it("falls back to the first composer when nothing is selected", () => {
		const nextSelection = resolveComposerSelection(
			{
				composers: [{ name: "default" }, { name: "reviewer" }],
				active: null,
			},
			"",
		);

		expect(nextSelection).toBe("default");
	});

	it("preserves the current selection when no better option exists", () => {
		const nextSelection = resolveComposerSelection(
			{
				composers: [{ name: "default" }, { name: "reviewer" }],
				active: null,
			},
			"reviewer",
		);

		expect(nextSelection).toBe("reviewer");
	});
});
