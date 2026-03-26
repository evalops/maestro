/**
 * Tests for the build_dashboard tool.
 */

import { describe, expect, it, vi } from "vitest";
import type {
	ExecResult,
	Executor,
} from "../../packages/slack-agent/src/sandbox.js";
import { createBuildDashboardTool } from "../../packages/slack-agent/src/tools/build-dashboard.js";

function createMockExecutor(
	overrides: Partial<Record<string, ExecResult>> = {},
): Executor {
	return {
		async exec(command: string): Promise<ExecResult> {
			// mkdir
			if (command.includes("mkdir -p")) {
				return overrides.mkdir ?? { stdout: "", stderr: "", code: 0 };
			}
			// Write index.html or dashboard.json
			if (command.includes("printf") && command.includes(">")) {
				return overrides.write ?? { stdout: "", stderr: "", code: 0 };
			}
			// Kill command
			if (command.includes("lsof") && command.includes("xargs kill")) {
				return { stdout: "done\n", stderr: "", code: 0 };
			}
			// Server start command
			if (command.includes("http.server") || command.includes("npx -y serve")) {
				return (
					overrides.server ?? {
						stdout: "12345\n",
						stderr: "",
						code: 0,
					}
				);
			}
			// Sleep
			if (command.includes("sleep")) {
				return { stdout: "", stderr: "", code: 0 };
			}
			return { stdout: "", stderr: "", code: 0 };
		},
		getWorkspacePath(p: string) {
			return p;
		},
		getContainerName() {
			return undefined;
		},
		async dispose() {},
	};
}

describe("build_dashboard tool", () => {
	it("has correct metadata", () => {
		const executor = createMockExecutor();
		const tool = createBuildDashboardTool(executor);
		expect(tool.name).toBe("build_dashboard");
		expect(tool.label).toBe("build_dashboard");
		expect(tool.description).toContain("dashboard");
		expect(tool.description).toContain("stat-group");
		expect(tool.description).toContain("bar-chart");
		expect(tool.description).toContain("line-chart");
		expect(tool.description).toContain("area-chart");
		expect(tool.description).toContain("pie-chart");
		expect(tool.description).toContain("doughnut-chart");
		expect(tool.description).toContain("table");
		expect(tool.description).toContain("activity-feed");
	});

	it("auto-deploys by default and returns localhost URL", async () => {
		const executor = createMockExecutor();
		const tool = createBuildDashboardTool(executor);

		const result = await tool.execute("test-id", {
			label: "Test Dashboard",
			title: "My Dashboard",
			components: [
				{
					type: "stat-group",
					items: [{ label: "Users", value: "1.2k" }],
				},
			],
		});

		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("Dashboard deployed on port 8080");
		expect(text).toContain("/workspace/dashboards/dash-");
		expect(text).toContain("localhost:8080");
	});

	it("skips deploy when auto_deploy is false", async () => {
		const executor = createMockExecutor();
		const tool = createBuildDashboardTool(executor);

		const result = await tool.execute("test-id", {
			label: "Test Dashboard",
			title: "No Deploy",
			auto_deploy: false,
			components: [],
		});

		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("Dashboard files written to");
		expect(text).toContain("index.html");
		expect(text).toContain("dashboard.json");
		expect(text).not.toContain("deployed");
	});

	it("calls onDeploy callback with preview URL", async () => {
		const onDeploy = vi.fn();
		const executor: Executor = {
			...createMockExecutor(),
			async getPreviewUrl(port: number, _expiresIn: number) {
				return { url: `https://preview.example.com:${port}` };
			},
		};
		const tool = createBuildDashboardTool(executor, onDeploy);

		const result = await tool.execute("test-id", {
			label: "My Dashboard",
			title: "Preview Test",
			port: 9090,
			components: [
				{
					type: "stat-group",
					items: [{ label: "MRR", value: "$48k" }],
				},
			],
		});

		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("Dashboard deployed successfully!");
		expect(text).toContain("https://preview.example.com:9090");
		expect(onDeploy).toHaveBeenCalledWith(
			"My Dashboard",
			expect.objectContaining({
				url: "https://preview.example.com:9090",
				port: 9090,
				directory: expect.stringContaining("/workspace/dashboards/dash-"),
			}),
		);
	});

	it("returns error for invalid port", async () => {
		const executor = createMockExecutor();
		const tool = createBuildDashboardTool(executor);

		const result = await tool.execute("test-id", {
			label: "Bad Port",
			title: "Test",
			port: -1,
			components: [],
		});

		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("port must be a number");
	});

	it("returns error when mkdir fails", async () => {
		const executor = createMockExecutor({
			mkdir: { stdout: "", stderr: "Permission denied", code: 1 },
		});
		const tool = createBuildDashboardTool(executor);

		const result = await tool.execute("test-id", {
			label: "Fail",
			title: "Test",
			components: [],
		});

		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("Failed to create dashboard directory");
		expect(text).toContain("Permission denied");
	});

	it("uses custom port and expiresIn", async () => {
		const onDeploy = vi.fn();
		const executor: Executor = {
			...createMockExecutor(),
			async getPreviewUrl(port: number, _expiresIn: number) {
				return { url: `https://example.com:${port}` };
			},
		};
		const tool = createBuildDashboardTool(executor, onDeploy);

		await tool.execute("test-id", {
			label: "Custom",
			title: "Custom Dashboard",
			port: 3000,
			expiresIn: 7200,
			components: [],
		});

		expect(onDeploy).toHaveBeenCalledWith(
			"Custom",
			expect.objectContaining({
				port: 3000,
				expiresIn: 7200,
			}),
		);
	});

	it("defaults to dark theme", async () => {
		const commands: string[] = [];
		const executor: Executor = {
			async exec(command: string): Promise<ExecResult> {
				commands.push(command);
				return { stdout: "", stderr: "", code: 0 };
			},
			getWorkspacePath(p: string) {
				return p;
			},
			getContainerName() {
				return undefined;
			},
			async dispose() {},
		};
		const tool = createBuildDashboardTool(executor);

		await tool.execute("test-id", {
			label: "Theme",
			title: "Theme Test",
			auto_deploy: false,
			components: [],
		});

		// Check that the HTML written contains dark theme
		const writeCmd = commands.find(
			(c) => c.includes("printf") && c.includes("index.html"),
		);
		expect(writeCmd).toBeDefined();
		expect(writeCmd).toContain("dark");
	});
});
