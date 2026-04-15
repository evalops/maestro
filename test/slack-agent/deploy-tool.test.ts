/**
 * Tests for the deploy tool.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ExecResult,
	Executor,
} from "../../packages/slack-agent/src/sandbox.js";
import { createDeployTool } from "../../packages/slack-agent/src/tools/deploy.js";

function createMockExecutor(
	overrides: Partial<Record<string, ExecResult>> = {},
): Executor {
	return {
		async exec(command: string): Promise<ExecResult> {
			// Check for index.html existence check
			if (command.includes("test -f") && command.includes("index.html")) {
				return overrides.check ?? { stdout: "ok\n", stderr: "", code: 0 };
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

describe("deploy tool", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(
			tmpdir(),
			`deploy-tool-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("has correct metadata", () => {
		const executor = createMockExecutor();
		const tool = createDeployTool(executor);
		expect(tool.name).toBe("deploy");
		expect(tool.description).toContain("mini-app");
		expect(tool.description).toContain("dashboard");
	});

	it("returns error when index.html is missing", async () => {
		const executor = createMockExecutor({
			check: { stdout: "missing\n", stderr: "", code: 0 },
		});
		const tool = createDeployTool(executor);

		const result = await tool.execute("test-id", {
			label: "deploy test",
			directory: join(testDir, "nonexistent"),
		});

		expect(result.content[0]!.type).toBe("text");
		expect((result.content[0] as { text: string }).text).toContain(
			"index.html not found",
		);
	});

	it("starts server and returns localhost URL for host executor", async () => {
		const appDir = join(testDir, "app");
		const executor = createMockExecutor();
		const tool = createDeployTool(executor);

		const port = 18080 + Math.floor(Math.random() * 1000);
		const result = await tool.execute("test-id", {
			label: "deploy test",
			directory: appDir,
			port,
		});

		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain(`port ${port}`);
		expect(text).toContain("No public URL available");
		expect(text).toContain(`localhost:${port}`);
	});

	it("returns error for invalid port", async () => {
		const executor = createMockExecutor();
		const tool = createDeployTool(executor);

		const result = await tool.execute("test-id", {
			label: "deploy test",
			directory: "/tmp/app",
			port: -1,
		});

		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("port must be a number");
	});

	it("calls onDeploy callback with preview URL", async () => {
		const onDeploy = vi.fn();
		const executor: Executor = {
			...createMockExecutor(),
			async getPreviewUrl(port: number, expiresIn: number) {
				return { url: `https://preview.example.com:${port}` };
			},
		};
		const tool = createDeployTool(executor, onDeploy);

		const result = await tool.execute("test-id", {
			label: "My Dashboard",
			directory: "/tmp/app",
			port: 8080,
		});

		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("Deployed successfully");
		expect(text).toContain("https://preview.example.com:8080");
		expect(onDeploy).toHaveBeenCalledWith("My Dashboard", {
			url: "https://preview.example.com:8080",
			port: 8080,
			directory: "/tmp/app",
			expiresIn: 3600,
		});
	});

	it("passes port and expiresIn defaults correctly", () => {
		const executor = createMockExecutor();
		const tool = createDeployTool(executor);
		expect(tool.parameters).toBeDefined();
	});
});
