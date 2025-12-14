import { describe, expect, it } from "vitest";
import { createExecutor, parseSandboxArg } from "../src/sandbox.js";

describe("parseSandboxArg", () => {
	it("parses host mode", () => {
		const result = parseSandboxArg("host");
		expect(result).toEqual({ type: "host" });
	});

	it("parses docker with container name", () => {
		const result = parseSandboxArg("docker:my-container");
		expect(result).toEqual({ type: "docker", container: "my-container" });
	});

	it("parses docker:auto mode", () => {
		const result = parseSandboxArg("docker:auto");
		expect(result).toEqual({ type: "docker", autoCreate: true });
	});

	it("parses docker:auto with custom image", () => {
		const result = parseSandboxArg("docker:auto:python:3.12-slim");
		expect(result).toEqual({
			type: "docker",
			autoCreate: true,
			image: "python:3.12-slim",
		});
	});

	it("parses docker:auto with multi-part image name", () => {
		const result = parseSandboxArg("docker:auto:ghcr.io/org/image:latest");
		expect(result).toEqual({
			type: "docker",
			autoCreate: true,
			image: "ghcr.io/org/image:latest",
		});
	});
});

describe("createExecutor", () => {
	it("creates host executor", () => {
		const executor = createExecutor({ type: "host" });
		expect(executor.getContainerName()).toBeUndefined();
		expect(executor.getWorkspacePath("/some/path")).toBe("/some/path");
	});

	it("creates docker executor with container name", () => {
		const executor = createExecutor({
			type: "docker",
			container: "test-container",
		});
		expect(executor.getContainerName()).toBe("test-container");
		expect(executor.getWorkspacePath("/some/path")).toBe("/workspace");
	});

	it("creates auto-docker executor", () => {
		const executor = createExecutor({ type: "docker", autoCreate: true });
		// Container name is generated with UUID
		expect(executor.getContainerName()).toMatch(/^slack-agent-[a-f0-9]{8}$/);
		expect(executor.getWorkspacePath("/some/path")).toBe("/workspace");
	});

	it("creates auto-docker executor with custom config", () => {
		const executor = createExecutor({
			type: "docker",
			autoCreate: true,
			image: "python:3.12",
			workspaceMount: "/app",
			cpus: "4",
			memory: "4g",
		});
		expect(executor.getContainerName()).toMatch(/^slack-agent-[a-f0-9]{8}$/);
		expect(executor.getWorkspacePath("/some/path")).toBe("/app");
	});
});

describe("HostExecutor", () => {
	it("executes simple command", async () => {
		const executor = createExecutor({ type: "host" });
		const result = await executor.exec("echo hello");
		expect(result.code).toBe(0);
		expect(result.stdout.trim()).toBe("hello");
		expect(result.stderr).toBe("");
	});

	it("captures stderr", async () => {
		const executor = createExecutor({ type: "host" });
		const result = await executor.exec("echo error >&2");
		expect(result.code).toBe(0);
		expect(result.stderr.trim()).toBe("error");
	});

	it("returns non-zero exit code on failure", async () => {
		const executor = createExecutor({ type: "host" });
		const result = await executor.exec("exit 42");
		expect(result.code).toBe(42);
	});

	it("handles command with special characters", async () => {
		const executor = createExecutor({ type: "host" });
		const result = await executor.exec('echo "hello world"');
		expect(result.code).toBe(0);
		expect(result.stdout.trim()).toBe("hello world");
	});

	it("executes with working directory", async () => {
		const executor = createExecutor({ type: "host" });
		const result = await executor.exec("pwd", { cwd: "/tmp" });
		expect(result.code).toBe(0);
		// macOS: /tmp is symlinked to /private/tmp
		expect(result.stdout.trim()).toMatch(/^(\/tmp|\/private\/tmp)$/);
	});

	it("times out long-running commands", async () => {
		const executor = createExecutor({ type: "host" });

		await expect(executor.exec("sleep 10", { timeout: 0.1 })).rejects.toThrow(
			/timed out/i,
		);
	});

	it("handles abort signal", async () => {
		const executor = createExecutor({ type: "host" });
		const controller = new AbortController();

		// Start a long command and abort it immediately
		const promise = executor.exec("sleep 10", { signal: controller.signal });

		// Abort after a short delay
		setTimeout(() => controller.abort(), 50);

		await expect(promise).rejects.toThrow(/aborted/i);
	});

	it("handles already-aborted signal", async () => {
		const executor = createExecutor({ type: "host" });
		const controller = new AbortController();
		controller.abort();

		await expect(
			executor.exec("echo test", { signal: controller.signal }),
		).rejects.toThrow(/aborted/i);
	});

	it("executes multiple commands in sequence", async () => {
		const executor = createExecutor({ type: "host" });

		const result1 = await executor.exec("echo first");
		const result2 = await executor.exec("echo second");
		const result3 = await executor.exec("echo third");

		expect(result1.stdout.trim()).toBe("first");
		expect(result2.stdout.trim()).toBe("second");
		expect(result3.stdout.trim()).toBe("third");
	});

	it("handles commands with environment variables", async () => {
		const executor = createExecutor({ type: "host" });
		const result = await executor.exec("FOO=bar && echo $FOO");
		expect(result.code).toBe(0);
		expect(result.stdout.trim()).toBe("bar");
	});

	it("handles piped commands", async () => {
		const executor = createExecutor({ type: "host" });
		const result = await executor.exec("echo hello | tr h H");
		expect(result.code).toBe(0);
		expect(result.stdout.trim()).toBe("Hello");
	});

	it("dispose does nothing for host executor", async () => {
		const executor = createExecutor({ type: "host" });
		// Should not throw
		await executor.dispose();
		// Can still execute after dispose (host doesn't have cleanup)
		const result = await executor.exec("echo test");
		expect(result.code).toBe(0);
	});
});

// Note: DockerExecutor and AutoDockerExecutor tests would require Docker
// and are better suited for integration tests
describe("DockerExecutor (unit)", () => {
	it("getWorkspacePath returns /workspace", () => {
		const executor = createExecutor({
			type: "docker",
			container: "test",
		});
		expect(executor.getWorkspacePath("/any/path")).toBe("/workspace");
	});

	it("getContainerName returns container name", () => {
		const executor = createExecutor({
			type: "docker",
			container: "my-test-container",
		});
		expect(executor.getContainerName()).toBe("my-test-container");
	});
});
