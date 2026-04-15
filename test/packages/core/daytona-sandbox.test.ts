/**
 * TDD tests for DaytonaSandbox — exercise it like a real consumer.
 * Tests the wrapper logic by injecting a mock sandbox handle.
 */
import { describe, expect, it, vi } from "vitest";

// Instead of mocking the SDK (which has complex resolution), we test
// the DaytonaSandbox methods directly by constructing one with a mock handle.
// This is more reliable and tests what actually matters: our wrapper logic.

import type { ExecResult } from "../../../src/sandbox/types.js";

// Create mock handle that mimics the Daytona sandbox
function createMockHandle() {
	return {
		id: "sandbox-test-123",
		process: {
			executeCommand: vi.fn().mockResolvedValue({
				result: "output\n",
				exitCode: 0,
			}),
		},
		fs: {
			downloadFile: vi.fn().mockResolvedValue(Buffer.from("file contents")),
			uploadFile: vi.fn().mockResolvedValue(undefined),
			getFileDetails: vi.fn().mockResolvedValue({ name: "test.txt" }),
			listFiles: vi
				.fn()
				.mockResolvedValue([{ name: "foo.ts" }, { name: "bar.js" }]),
			deleteFile: vi.fn().mockResolvedValue(undefined),
		},
		delete: vi.fn().mockResolvedValue(undefined),
	};
}

// Access private constructor via reflection for testing
async function createTestSandbox(handle: ReturnType<typeof createMockHandle>) {
	// DaytonaSandbox has a private constructor, but we can work around it
	// by importing the module and using Object.create
	const { DaytonaSandbox } = await import(
		"../../../packages/core/src/sandbox/daytona-sandbox.js"
	);
	const instance = Object.create(DaytonaSandbox.prototype);
	// Set private field via any cast
	(instance as { handle: unknown }).handle = handle;
	return instance as InstanceType<typeof DaytonaSandbox>;
}

describe("DaytonaSandbox", () => {
	describe("exec", () => {
		it("executes a simple command", async () => {
			const handle = createMockHandle();
			const sandbox = await createTestSandbox(handle);

			const result: ExecResult = await sandbox.exec("echo hello");
			expect(result.stdout).toBe("output\n");
			expect(result.exitCode).toBe(0);
			expect(handle.process.executeCommand).toHaveBeenCalledWith("echo hello");
		});

		it("passes env vars as single-quoted shell prefix", async () => {
			const handle = createMockHandle();
			const sandbox = await createTestSandbox(handle);

			await sandbox.exec("printenv", undefined, {
				FOO: "bar",
				BAZ: "qux",
			});

			const cmd = handle.process.executeCommand.mock.calls[0]![0] as string;
			expect(cmd).toContain("FOO='bar'");
			expect(cmd).toContain("BAZ='qux'");
			expect(cmd).toContain("printenv");
		});

		it("escapes single quotes in env var values", async () => {
			const handle = createMockHandle();
			const sandbox = await createTestSandbox(handle);

			await sandbox.exec("echo test", undefined, {
				MSG: "it's alive",
			});

			const cmd = handle.process.executeCommand.mock.calls[0]![0] as string;
			// Single quote escaping: replace ' with '\''
			expect(cmd).toContain("MSG='it'\\''s alive'");
		});

		it("rejects invalid env var keys (injection prevention)", async () => {
			const handle = createMockHandle();
			const sandbox = await createTestSandbox(handle);

			const result = await sandbox.exec("echo", undefined, {
				"invalid-key": "value",
			});
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("Invalid environment variable name");
			// Should NOT have called executeCommand
			expect(handle.process.executeCommand).not.toHaveBeenCalled();
		});

		it("rejects env var keys with shell metacharacters", async () => {
			const handle = createMockHandle();
			const sandbox = await createTestSandbox(handle);

			for (const badKey of [
				"FOO;rm -rf /",
				"$(whoami)",
				"KEY`id`",
				"A=B",
				"123START",
			]) {
				const result = await sandbox.exec("echo", undefined, {
					[badKey]: "value",
				});
				expect(result.exitCode).toBe(1);
			}
		});

		it("allows valid env var keys", async () => {
			const handle = createMockHandle();
			const sandbox = await createTestSandbox(handle);

			for (const goodKey of ["FOO", "_BAR", "MY_VAR_123", "PATH", "_", "a"]) {
				handle.process.executeCommand.mockClear();
				await sandbox.exec("echo", undefined, { [goodKey]: "v" });
				expect(handle.process.executeCommand).toHaveBeenCalled();
			}
		});

		it("prepends cd for cwd", async () => {
			const handle = createMockHandle();
			const sandbox = await createTestSandbox(handle);

			await sandbox.exec("ls", "/tmp/workdir");

			const cmd = handle.process.executeCommand.mock.calls[0]![0] as string;
			expect(cmd).toContain("cd '/tmp/workdir'");
			expect(cmd).toContain("&& ls");
		});

		it("escapes single quotes in cwd", async () => {
			const handle = createMockHandle();
			const sandbox = await createTestSandbox(handle);

			await sandbox.exec("ls", "/tmp/it's a dir");

			const cmd = handle.process.executeCommand.mock.calls[0]![0] as string;
			expect(cmd).toContain("cd '/tmp/it'\\''s a dir'");
		});

		it("combines env + cwd correctly", async () => {
			const handle = createMockHandle();
			const sandbox = await createTestSandbox(handle);

			await sandbox.exec("make build", "/app", { CC: "gcc" });

			const cmd = handle.process.executeCommand.mock.calls[0]![0] as string;
			expect(cmd).toContain("CC='gcc'");
			expect(cmd).toContain("cd '/app'");
			expect(cmd).toContain("make build");
			// cd comes first, then env vars prefix the actual command
			expect(cmd.indexOf("cd")).toBeLessThan(cmd.indexOf("CC="));
		});

		it("returns error ExecResult on SDK failure", async () => {
			const handle = createMockHandle();
			handle.process.executeCommand.mockRejectedValue(
				new Error("sandbox unreachable"),
			);
			const sandbox = await createTestSandbox(handle);

			const result = await sandbox.exec("echo hello");
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("sandbox unreachable");
			expect(result.stdout).toBe("");
		});
	});

	describe("readFile", () => {
		it("reads Buffer and returns string", async () => {
			const handle = createMockHandle();
			const sandbox = await createTestSandbox(handle);

			const content = await sandbox.readFile("/app/test.txt");
			expect(content).toBe("file contents");
		});

		it("handles string return from SDK", async () => {
			const handle = createMockHandle();
			handle.fs.downloadFile.mockResolvedValue("already a string");
			const sandbox = await createTestSandbox(handle);

			const content = await sandbox.readFile("/app/test.txt");
			expect(content).toBe("already a string");
		});
	});

	describe("writeFile", () => {
		it("passes Buffer as first arg, path as second", async () => {
			const handle = createMockHandle();
			const sandbox = await createTestSandbox(handle);

			await sandbox.writeFile("/app/out.txt", "hello world");

			expect(handle.fs.uploadFile).toHaveBeenCalledTimes(1);
			const args = handle.fs.uploadFile.mock.calls[0]!;
			expect(Buffer.isBuffer(args[0])).toBe(true);
			expect(args[0].toString()).toBe("hello world");
			expect(args[1]).toBe("/app/out.txt");
		});
	});

	describe("exists", () => {
		it("returns true when file exists", async () => {
			const handle = createMockHandle();
			const sandbox = await createTestSandbox(handle);
			expect(await sandbox.exists("/app/test.txt")).toBe(true);
		});

		it("returns false on error", async () => {
			const handle = createMockHandle();
			handle.fs.getFileDetails.mockRejectedValue(new Error("not found"));
			const sandbox = await createTestSandbox(handle);
			expect(await sandbox.exists("/app/missing.txt")).toBe(false);
		});
	});

	describe("list", () => {
		it("returns file names", async () => {
			const handle = createMockHandle();
			const sandbox = await createTestSandbox(handle);
			expect(await sandbox.list("/app")).toEqual(["foo.ts", "bar.js"]);
		});
	});

	describe("delete", () => {
		it("passes recursive flag", async () => {
			const handle = createMockHandle();
			const sandbox = await createTestSandbox(handle);
			await sandbox.delete("/app/dir", true);
			expect(handle.fs.deleteFile).toHaveBeenCalledWith("/app/dir", true);
		});

		it("works without recursive", async () => {
			const handle = createMockHandle();
			const sandbox = await createTestSandbox(handle);
			await sandbox.delete("/app/file.txt");
			expect(handle.fs.deleteFile).toHaveBeenCalledWith(
				"/app/file.txt",
				undefined,
			);
		});
	});

	describe("dispose", () => {
		it("deletes the sandbox", async () => {
			const handle = createMockHandle();
			const sandbox = await createTestSandbox(handle);
			await sandbox.dispose();
			expect(handle.delete).toHaveBeenCalled();
		});

		it("swallows errors", async () => {
			const handle = createMockHandle();
			handle.delete.mockRejectedValue(new Error("already gone"));
			const sandbox = await createTestSandbox(handle);
			await expect(sandbox.dispose()).resolves.toBeUndefined();
		});
	});
});
