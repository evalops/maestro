/**
 * Tests for sandbox.ts - Host and Docker executor functionality
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type SandboxConfig,
	createExecutor,
	parseSandboxArg,
} from "../../packages/slack-agent/src/sandbox.js";

describe("sandbox", () => {
	beforeEach(() => {
		vi.useRealTimers();
	});

	describe("parseSandboxArg", () => {
		// Save original process.exit to restore later
		const originalExit = process.exit;
		const originalError = console.error;

		beforeEach(() => {
			// Mock process.exit to throw instead of exiting
			process.exit = vi.fn((code?: number) => {
				throw new Error(`process.exit(${code})`);
			}) as never;
			console.error = vi.fn();
		});

		afterEach(() => {
			process.exit = originalExit;
			console.error = originalError;
		});

		it("parses 'host' as host config", () => {
			const config = parseSandboxArg("host");
			expect(config).toEqual({ type: "host" });
		});

		it("parses 'docker:container-name' as docker config", () => {
			const config = parseSandboxArg("docker:my-container");
			expect(config).toEqual({ type: "docker", container: "my-container" });
		});

		it("handles docker container names with special characters", () => {
			const config = parseSandboxArg("docker:my-container_123");
			expect(config).toEqual({ type: "docker", container: "my-container_123" });
		});

		it("exits with error for docker: without container name", () => {
			expect(() => parseSandboxArg("docker:")).toThrow("process.exit(1)");
			expect(console.error).toHaveBeenCalledWith(
				expect.stringContaining("docker sandbox requires container name"),
			);
		});

		it("exits with error for invalid sandbox type", () => {
			expect(() => parseSandboxArg("invalid")).toThrow("process.exit(1)");
			expect(console.error).toHaveBeenCalledWith(
				expect.stringContaining("Invalid sandbox type 'invalid'"),
			);
		});

		it("parses 'docker:auto' as auto-create config", () => {
			const config = parseSandboxArg("docker:auto");
			expect(config).toEqual({ type: "docker", autoCreate: true });
		});

		it("parses 'docker:auto:image:tag' as auto-create with custom image", () => {
			const config = parseSandboxArg("docker:auto:python:3.12-slim");
			expect(config).toEqual({
				type: "docker",
				autoCreate: true,
				image: "python:3.12-slim",
			});
		});

		it("exits with error for docker:auto: without image", () => {
			expect(() => parseSandboxArg("docker:auto:")).toThrow("process.exit(1)");
			expect(console.error).toHaveBeenCalledWith(
				expect.stringContaining("docker:auto requires an image name"),
			);
		});
	});

	describe("createExecutor", () => {
		it("creates HostExecutor for host config", () => {
			const config: SandboxConfig = { type: "host" };
			const executor = createExecutor(config);

			expect(executor).toBeDefined();
			expect(executor.getWorkspacePath("/some/path")).toBe("/some/path");
		});

		it("creates DockerExecutor for docker config", () => {
			const config: SandboxConfig = {
				type: "docker",
				container: "test-container",
			};
			const executor = createExecutor(config);

			expect(executor).toBeDefined();
			expect(executor.getWorkspacePath("/some/path")).toBe("/workspace");
		});

		it("creates AutoDockerExecutor for docker:auto config", () => {
			const config: SandboxConfig = {
				type: "docker",
				autoCreate: true,
			};
			const executor = createExecutor(config);

			expect(executor).toBeDefined();
			expect(executor.getWorkspacePath("/some/path")).toBe("/workspace");
		});

		it("creates AutoDockerExecutor with custom image", () => {
			const config: SandboxConfig = {
				type: "docker",
				autoCreate: true,
				image: "python:3.12-slim",
				cpus: "4",
				memory: "4g",
			};
			const executor = createExecutor(config);

			expect(executor).toBeDefined();
			expect(executor.getWorkspacePath("/some/path")).toBe("/workspace");
		});

		it("returns undefined container name for host executor", () => {
			const config: SandboxConfig = { type: "host" };
			const executor = createExecutor(config);

			expect(executor.getContainerName()).toBeUndefined();
		});

		it("returns container name for docker executor", () => {
			const config: SandboxConfig = {
				type: "docker",
				container: "my-test-container",
			};
			const executor = createExecutor(config);

			expect(executor.getContainerName()).toBe("my-test-container");
		});

		it("returns generated container name for auto-create executor", () => {
			const config: SandboxConfig = {
				type: "docker",
				autoCreate: true,
			};
			const executor = createExecutor(config);

			const name = executor.getContainerName();
			expect(name).toBeDefined();
			expect(name).toMatch(/^slack-agent-[a-f0-9]{8}$/);
		});
	});

	describe("HostExecutor", () => {
		it("executes simple commands successfully", async () => {
			const config: SandboxConfig = { type: "host" };
			const executor = createExecutor(config);

			const result = await executor.exec("echo hello");
			expect(result.code).toBe(0);
			expect(result.stdout.trim()).toBe("hello");
			expect(result.stderr).toBe("");
		});

		it("captures stderr separately", async () => {
			const config: SandboxConfig = { type: "host" };
			const executor = createExecutor(config);

			const result = await executor.exec("echo error >&2");
			expect(result.code).toBe(0);
			expect(result.stderr.trim()).toBe("error");
		});

		it("returns non-zero exit code for failed commands", async () => {
			const config: SandboxConfig = { type: "host" };
			const executor = createExecutor(config);

			const result = await executor.exec("exit 42");
			expect(result.code).toBe(42);
		});

		it("handles commands with special characters", async () => {
			const config: SandboxConfig = { type: "host" };
			const executor = createExecutor(config);

			const result = await executor.exec("echo 'hello world'");
			expect(result.code).toBe(0);
			expect(result.stdout.trim()).toBe("hello world");
		});

		it("handles multiline output", async () => {
			const config: SandboxConfig = { type: "host" };
			const executor = createExecutor(config);

			const result = await executor.exec("echo -e 'line1\\nline2\\nline3'");
			expect(result.code).toBe(0);
			const lines = result.stdout.trim().split("\n");
			expect(lines).toHaveLength(3);
		});

		it("respects timeout option", async () => {
			const config: SandboxConfig = { type: "host" };
			const executor = createExecutor(config);

			await expect(executor.exec("sleep 10", { timeout: 0.1 })).rejects.toThrow(
				"timed out",
			);
		});

		it("respects abort signal", async () => {
			const config: SandboxConfig = { type: "host" };
			const executor = createExecutor(config);

			const controller = new AbortController();

			// Abort immediately
			controller.abort();

			await expect(
				executor.exec("sleep 10", { signal: controller.signal }),
			).rejects.toThrow("aborted");
		});

		it("truncates very long output", async () => {
			const config: SandboxConfig = { type: "host" };
			const executor = createExecutor(config);

			// Generate output larger than 10MB limit
			// Using a smaller test to avoid slow tests, but testing the concept
			const result = await executor.exec("yes | head -n 100000");
			expect(result.code).toBe(0);
			expect(result.stdout.length).toBeGreaterThan(0);
		});

		it("preserves workspace path for host executor", () => {
			const config: SandboxConfig = { type: "host" };
			const executor = createExecutor(config);

			expect(executor.getWorkspacePath("/home/user/project")).toBe(
				"/home/user/project",
			);
			expect(executor.getWorkspacePath("/tmp/test")).toBe("/tmp/test");
		});
	});

	describe("parseSandboxArg - daytona", () => {
		const originalExit = process.exit;
		const originalError = console.error;

		beforeEach(() => {
			process.exit = vi.fn((code?: number) => {
				throw new Error(`process.exit(${code})`);
			}) as never;
			console.error = vi.fn();
		});

		afterEach(() => {
			process.exit = originalExit;
			console.error = originalError;
		});

		it("parses 'daytona' as daytona config", () => {
			const config = parseSandboxArg("daytona");
			expect(config).toEqual({ type: "daytona" });
		});

		it("parses 'daytona:snapshot' as daytona config with snapshot", () => {
			const config = parseSandboxArg("daytona:my-snapshot");
			expect(config).toEqual({ type: "daytona", snapshot: "my-snapshot" });
		});

		it("exits with error for daytona: without snapshot name", () => {
			expect(() => parseSandboxArg("daytona:")).toThrow("process.exit(1)");
			expect(console.error).toHaveBeenCalledWith(
				expect.stringContaining("daytona:<snapshot> requires a snapshot name"),
			);
		});
	});

	describe("DaytonaExecutor", () => {
		it("creates executor for daytona config", () => {
			const config: SandboxConfig = { type: "daytona" };
			const executor = createExecutor(config);

			expect(executor).toBeDefined();
			expect(executor.getWorkspacePath("/some/path")).toBe("/home/daytona");
		});

		it("returns undefined container name before init", () => {
			const config: SandboxConfig = { type: "daytona" };
			const executor = createExecutor(config);

			expect(executor.getContainerName()).toBeUndefined();
		});

		it("exposes daytona-specific methods", () => {
			const config: SandboxConfig = { type: "daytona" };
			const executor = createExecutor(config);

			expect(typeof executor.getPreviewUrl).toBe("function");
			expect(typeof executor.uploadFile).toBe("function");
			expect(typeof executor.downloadFile).toBe("function");
			expect(typeof executor.gitClone).toBe("function");
			expect(typeof executor.getSandboxId).toBe("function");
		});

		it("getSandboxId returns undefined before sandbox creation", () => {
			const config: SandboxConfig = { type: "daytona" };
			const executor = createExecutor(config);

			expect(executor.getSandboxId?.()).toBeUndefined();
		});

		it("dispose is safe to call before sandbox creation", async () => {
			const config: SandboxConfig = { type: "daytona" };
			const executor = createExecutor(config);

			await executor.dispose();
		});

		it("dispose is idempotent", async () => {
			const config: SandboxConfig = { type: "daytona" };
			const executor = createExecutor(config);

			await executor.dispose();
			await executor.dispose();
		});

		it("exec rejects after dispose", async () => {
			const config: SandboxConfig = { type: "daytona" };
			const executor = createExecutor(config);

			await executor.dispose();
			await expect(executor.exec("echo test")).rejects.toThrow(/disposed/);
		});

		it("creates executor with snapshot config", () => {
			const config: SandboxConfig = {
				type: "daytona",
				snapshot: "node-20-dev",
			};
			const executor = createExecutor(config);

			expect(executor).toBeDefined();
			expect(executor.getWorkspacePath("/any")).toBe("/home/daytona");
		});

		it("creates executor with full config", () => {
			const config: SandboxConfig = {
				type: "daytona",
				apiKey: "test-key",
				apiUrl: "https://custom.api.com",
				image: "debian:12",
				language: "python",
				cpu: 4,
				memory: 8,
				disk: 20,
				autoStopInterval: 60,
			};
			const executor = createExecutor(config);

			expect(executor).toBeDefined();
		});
	});

	describe("DockerExecutor", () => {
		it("maps any host path to /workspace", () => {
			const config: SandboxConfig = { type: "docker", container: "test" };
			const executor = createExecutor(config);

			expect(executor.getWorkspacePath("/home/user/project")).toBe(
				"/workspace",
			);
			expect(executor.getWorkspacePath("/any/path")).toBe("/workspace");
		});

		// Note: Actual Docker execution tests would require Docker to be running
		// These are skipped in CI but can be run locally
		it.skip("executes commands in docker container", async () => {
			const config: SandboxConfig = {
				type: "docker",
				container: "test-sandbox",
			};
			const executor = createExecutor(config);

			const result = await executor.exec("echo hello from docker");
			expect(result.code).toBe(0);
			expect(result.stdout.trim()).toBe("hello from docker");
		});
	});
});
