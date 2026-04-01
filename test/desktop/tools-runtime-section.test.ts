import { describe, expect, it } from "vitest";
import {
	buildComposerProfilesViewModel,
	buildLspViewModel,
	buildMcpServerViewModel,
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
		expect(viewModel.sourceLabel).toBe("Project config");
		expect(viewModel.transportLabel).toBe("stdio");
		expect(viewModel.errorLabel).toBeNull();
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
		expect(viewModel.sourceLabel).toBe("User config");
		expect(viewModel.transportLabel).toBe("HTTP");
		expect(viewModel.errorLabel).toBe("Connection refused");
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
		expect(viewModel.sourceLabel).toBeNull();
		expect(viewModel.transportLabel).toBeNull();
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
