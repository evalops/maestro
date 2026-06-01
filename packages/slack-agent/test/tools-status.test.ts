import { describe, expect, it, vi } from "vitest";
import type { ExecOptions, Executor } from "../src/sandbox.js";
import { type ContainerHealth, createStatusTool } from "../src/tools/status.js";

vi.mock("node:child_process", () => ({
	exec: vi.fn(
		(
			cmd: string,
			_options: unknown,
			callback: (error: Error | null, stdout: string, stderr: string) => void,
		) => {
			if (cmd.includes("docker inspect")) {
				callback(
					null,
					JSON.stringify([
						{
							Id: "abcdef1234567890",
							Name: "/test-container",
							Config: { Image: "node:20-slim" },
							State: {
								StartedAt: new Date(Date.now() - 1000).toISOString(),
								Status: "running",
							},
						},
					]),
					"",
				);
				return;
			}

			if (cmd.includes("docker stats")) {
				callback(
					null,
					JSON.stringify({
						CPUPerc: "1.23%",
						MemUsage: "12MiB / 1GiB",
						MemPerc: "1.17%",
						NetIO: "1kB / 2kB",
						BlockIO: "0B / 0B",
					}),
					"",
				);
				return;
			}

			callback(new Error(`unexpected command: ${cmd}`), "", "");
		},
	),
}));

// Mock executor factory
function createMockExecutor(
	responses: Record<
		string,
		{ code: number; stdout: string; stderr: string }
	> = {},
): Executor {
	return {
		exec: vi.fn().mockImplementation(async (cmd: string) => {
			for (const [pattern, response] of Object.entries(responses)) {
				if (cmd.includes(pattern)) {
					return response;
				}
			}
			return { code: 0, stdout: "", stderr: "" };
		}),
		getWorkspacePath: vi.fn().mockImplementation((p: string) => p),
	} as unknown as Executor;
}

describe("createStatusTool", () => {
	describe("host environment", () => {
		it("returns host environment status", async () => {
			const executor = createMockExecutor({
				"du -sb": { code: 0, stdout: "1048576 /workspace", stderr: "" },
				find: { code: 0, stdout: "42", stderr: "" },
			});
			const tool = createStatusTool(executor);

			const result = await tool.execute("call1", { label: "check status" });

			expect(result.content[0]!.text).toContain("Environment: host");
			expect(result.content[0]!.text).toContain("Workspace:");
		});

		it("bounds workspace status probes", async () => {
			const execCalls: Array<{ command: string; timeout?: number }> = [];
			const executor = {
				exec: vi
					.fn()
					.mockImplementation(async (cmd: string, options?: ExecOptions) => {
						execCalls.push({ command: cmd, timeout: options?.timeout });
						return { code: 0, stdout: "0 /workspace", stderr: "" };
					}),
				getWorkspacePath: vi.fn().mockImplementation((p: string) => p),
				getContainerName: vi.fn().mockReturnValue(undefined),
				dispose: vi.fn().mockResolvedValue(undefined),
			} satisfies Executor;
			const tool = createStatusTool(executor);

			await tool.execute("call1", { label: "check status" });

			expect(execCalls).toEqual([
				expect.objectContaining({
					command: expect.stringContaining("du -sb"),
					timeout: 5,
				}),
				expect.objectContaining({
					command: expect.stringContaining("find"),
					timeout: 5,
				}),
			]);
		});

		it("formats bytes correctly", async () => {
			const executor = createMockExecutor({
				"du -sb": { code: 0, stdout: "1073741824 /workspace", stderr: "" }, // 1GB
				find: { code: 0, stdout: "100", stderr: "" },
			});
			const tool = createStatusTool(executor);

			const result = await tool.execute("call1", { label: "check" });
			const health = result.details as ContainerHealth;

			expect(health.workspace.usedHuman).toBe("1.00GB");
		});

		it("handles KB range", async () => {
			const executor = createMockExecutor({
				"du -sb": { code: 0, stdout: "2048 /workspace", stderr: "" },
				find: { code: 0, stdout: "5", stderr: "" },
			});
			const tool = createStatusTool(executor);

			const result = await tool.execute("call1", { label: "check" });
			const health = result.details as ContainerHealth;

			expect(health.workspace.usedHuman).toBe("2.0KB");
		});

		it("handles MB range", async () => {
			const executor = createMockExecutor({
				"du -sb": { code: 0, stdout: "5242880 /workspace", stderr: "" }, // 5MB
				find: { code: 0, stdout: "50", stderr: "" },
			});
			const tool = createStatusTool(executor);

			const result = await tool.execute("call1", { label: "check" });
			const health = result.details as ContainerHealth;

			expect(health.workspace.usedHuman).toBe("5.0MB");
		});

		it("handles bytes range", async () => {
			const executor = createMockExecutor({
				"du -sb": { code: 0, stdout: "500 /workspace", stderr: "" },
				find: { code: 0, stdout: "2", stderr: "" },
			});
			const tool = createStatusTool(executor);

			const result = await tool.execute("call1", { label: "check" });
			const health = result.details as ContainerHealth;

			expect(health.workspace.usedHuman).toBe("500B");
		});

		it("handles du command failure gracefully", async () => {
			const executor = createMockExecutor({
				"du -sb": { code: 1, stdout: "", stderr: "error" },
				find: { code: 0, stdout: "10", stderr: "" },
			});
			const tool = createStatusTool(executor);

			const result = await tool.execute("call1", { label: "check" });
			const health = result.details as ContainerHealth;

			expect(health.workspace.usedBytes).toBe(0);
		});

		it("handles find command failure gracefully", async () => {
			const executor = createMockExecutor({
				"du -sb": { code: 0, stdout: "1024 /workspace", stderr: "" },
				find: { code: 1, stdout: "", stderr: "error" },
			});
			const tool = createStatusTool(executor);

			const result = await tool.execute("call1", { label: "check" });
			const health = result.details as ContainerHealth;

			expect(health.workspace.fileCount).toBe(0);
		});
	});

	describe("docker environment", () => {
		it("returns docker environment status", async () => {
			const executor = createMockExecutor({
				"du -sb": { code: 0, stdout: "1024 /workspace", stderr: "" },
				find: { code: 0, stdout: "5", stderr: "" },
			});

			// Note: Docker stats require host access which we can't easily mock
			const tool = createStatusTool(executor, "test-container");

			const result = await tool.execute("call1", { label: "check" });
			const health = result.details as ContainerHealth;

			expect(health.environment).toBe("docker");
		}, 15_000);
	});

	describe("output formatting", () => {
		it("includes workspace section", async () => {
			const executor = createMockExecutor({
				"du -sb": { code: 0, stdout: "2048 /workspace", stderr: "" },
				find: { code: 0, stdout: "25", stderr: "" },
			});
			const tool = createStatusTool(executor);

			const result = await tool.execute("call1", { label: "check" });

			expect(result.content[0]!.text).toContain("Workspace:");
			expect(result.content[0]!.text).toContain("Path:");
			expect(result.content[0]!.text).toContain("Disk Usage:");
			expect(result.content[0]!.text).toContain("Files:");
		});

		it("returns details object with health info", async () => {
			const executor = createMockExecutor({
				"du -sb": { code: 0, stdout: "4096 /workspace", stderr: "" },
				find: { code: 0, stdout: "10", stderr: "" },
			});
			const tool = createStatusTool(executor);

			const result = await tool.execute("call1", { label: "check" });
			const health = result.details as ContainerHealth;

			expect(health).toMatchObject({
				container: null,
				resources: null,
				environment: "host",
				workspace: {
					usedBytes: 4096,
					fileCount: 10,
				},
			});
		});
	});
});
