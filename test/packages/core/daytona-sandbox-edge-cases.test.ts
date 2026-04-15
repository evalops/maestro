/**
 * TDD edge case tests for DaytonaSandbox — stress test the wrapper
 * with adversarial inputs, concurrency, and failure modes.
 */
import { describe, expect, it, vi } from "vitest";

import type { ExecResult } from "../../../src/sandbox/types.js";

function createMockHandle() {
	return {
		id: "sandbox-edge-123",
		process: {
			executeCommand: vi.fn().mockResolvedValue({ result: "", exitCode: 0 }),
		},
		fs: {
			downloadFile: vi.fn().mockResolvedValue(Buffer.from("")),
			uploadFile: vi.fn().mockResolvedValue(undefined),
			getFileDetails: vi.fn().mockResolvedValue({ name: "f" }),
			listFiles: vi.fn().mockResolvedValue([]),
			deleteFile: vi.fn().mockResolvedValue(undefined),
		},
		delete: vi.fn().mockResolvedValue(undefined),
	};
}

async function createTestSandbox(handle: ReturnType<typeof createMockHandle>) {
	const { DaytonaSandbox } = await import(
		"../../../packages/core/src/sandbox/daytona-sandbox.js"
	);
	const instance = Object.create(DaytonaSandbox.prototype);
	(instance as { handle: unknown }).handle = handle;
	return instance as InstanceType<typeof DaytonaSandbox>;
}

describe("DaytonaSandbox Edge Cases", () => {
	describe("exec — adversarial env vars", () => {
		it("rejects env key starting with number", async () => {
			const handle = createMockHandle();
			const sandbox = await createTestSandbox(handle);
			const r = await sandbox.exec("echo", undefined, { "123": "val" });
			expect(r.exitCode).toBe(1);
			expect(handle.process.executeCommand).not.toHaveBeenCalled();
		});

		it("rejects env key with spaces", async () => {
			const handle = createMockHandle();
			const sandbox = await createTestSandbox(handle);
			const r = await sandbox.exec("echo", undefined, { "MY VAR": "val" });
			expect(r.exitCode).toBe(1);
		});

		it("rejects env key with dots", async () => {
			const handle = createMockHandle();
			const sandbox = await createTestSandbox(handle);
			const r = await sandbox.exec("echo", undefined, { "my.var": "val" });
			expect(r.exitCode).toBe(1);
		});

		it("rejects empty env key", async () => {
			const handle = createMockHandle();
			const sandbox = await createTestSandbox(handle);
			const r = await sandbox.exec("echo", undefined, { "": "val" });
			expect(r.exitCode).toBe(1);
		});

		it("handles env value with newlines", async () => {
			const handle = createMockHandle();
			const sandbox = await createTestSandbox(handle);
			await sandbox.exec("echo", undefined, { MSG: "line1\nline2" });
			const cmd = handle.process.executeCommand.mock.calls[0]![0] as string;
			expect(cmd).toContain("MSG=");
			expect(handle.process.executeCommand).toHaveBeenCalled();
		});

		it("handles env value with backticks", async () => {
			const handle = createMockHandle();
			const sandbox = await createTestSandbox(handle);
			await sandbox.exec("echo", undefined, { CMD: "`whoami`" });
			const cmd = handle.process.executeCommand.mock.calls[0]![0] as string;
			// Single-quoted values prevent backtick expansion
			expect(cmd).toContain("CMD='`whoami`'");
		});

		it("handles env value with dollar signs", async () => {
			const handle = createMockHandle();
			const sandbox = await createTestSandbox(handle);
			await sandbox.exec("echo", undefined, { PRICE: "$100" });
			const cmd = handle.process.executeCommand.mock.calls[0]![0] as string;
			// Single quotes prevent variable expansion
			expect(cmd).toContain("PRICE='$100'");
		});

		it("handles env value with double quotes", async () => {
			const handle = createMockHandle();
			const sandbox = await createTestSandbox(handle);
			await sandbox.exec("echo", undefined, { MSG: 'say "hello"' });
			const cmd = handle.process.executeCommand.mock.calls[0]![0] as string;
			// Double quotes inside single quotes are safe
			expect(cmd).toContain("MSG='say \"hello\"'");
		});

		it("handles empty env object (no-op)", async () => {
			const handle = createMockHandle();
			const sandbox = await createTestSandbox(handle);
			await sandbox.exec("echo hi", undefined, {});
			expect(handle.process.executeCommand).toHaveBeenCalledWith("echo hi");
		});

		it("handles many env vars", async () => {
			const handle = createMockHandle();
			const sandbox = await createTestSandbox(handle);
			const env: Record<string, string> = {};
			for (let i = 0; i < 50; i++) {
				env[`VAR_${i}`] = `value_${i}`;
			}
			await sandbox.exec("env", undefined, env);
			const cmd = handle.process.executeCommand.mock.calls[0]![0] as string;
			expect(cmd).toContain("VAR_0=");
			expect(cmd).toContain("VAR_49=");
		});
	});

	describe("exec — adversarial cwd", () => {
		it("handles cwd with spaces", async () => {
			const handle = createMockHandle();
			const sandbox = await createTestSandbox(handle);
			await sandbox.exec("ls", "/path/with spaces/dir");
			const cmd = handle.process.executeCommand.mock.calls[0]![0] as string;
			expect(cmd).toContain("cd '/path/with spaces/dir'");
		});

		it("handles cwd with semicolons (injection attempt)", async () => {
			const handle = createMockHandle();
			const sandbox = await createTestSandbox(handle);
			await sandbox.exec("ls", "/tmp; rm -rf /");
			const cmd = handle.process.executeCommand.mock.calls[0]![0] as string;
			// The semicolon should be inside single quotes, not interpreted
			expect(cmd).toContain("cd '/tmp; rm -rf /'");
		});

		it("handles cwd with backticks (injection attempt)", async () => {
			const handle = createMockHandle();
			const sandbox = await createTestSandbox(handle);
			await sandbox.exec("ls", "/tmp/`whoami`");
			const cmd = handle.process.executeCommand.mock.calls[0]![0] as string;
			expect(cmd).toContain("cd '/tmp/`whoami`'");
		});

		it("handles empty cwd (no cd prepended)", async () => {
			const handle = createMockHandle();
			const sandbox = await createTestSandbox(handle);
			await sandbox.exec("ls", "");
			// Empty string is falsy, should not prepend cd
			expect(handle.process.executeCommand).toHaveBeenCalledWith("ls");
		});
	});

	describe("exec — SDK error variations", () => {
		it("handles non-Error thrown from SDK", async () => {
			const handle = createMockHandle();
			handle.process.executeCommand.mockRejectedValue("string error");
			const sandbox = await createTestSandbox(handle);
			const r = await sandbox.exec("fail");
			expect(r.exitCode).toBe(1);
			expect(r.stderr).toBe("string error");
		});

		it("handles null thrown from SDK", async () => {
			const handle = createMockHandle();
			handle.process.executeCommand.mockRejectedValue(null);
			const sandbox = await createTestSandbox(handle);
			const r = await sandbox.exec("fail");
			expect(r.exitCode).toBe(1);
		});

		it("handles timeout errors", async () => {
			const handle = createMockHandle();
			handle.process.executeCommand.mockRejectedValue(
				new Error("Request timeout after 30000ms"),
			);
			const sandbox = await createTestSandbox(handle);
			const r = await sandbox.exec("long-running");
			expect(r.exitCode).toBe(1);
			expect(r.stderr).toContain("timeout");
		});
	});

	describe("writeFile — edge cases", () => {
		it("handles empty content", async () => {
			const handle = createMockHandle();
			const sandbox = await createTestSandbox(handle);
			await sandbox.writeFile("/app/empty.txt", "");
			const args = handle.fs.uploadFile.mock.calls[0]!;
			expect(Buffer.isBuffer(args[0])).toBe(true);
			expect(args[0].length).toBe(0);
		});

		it("handles binary-like content", async () => {
			const handle = createMockHandle();
			const sandbox = await createTestSandbox(handle);
			const binaryStr = "\x00\x01\x02\x03";
			await sandbox.writeFile("/app/binary", binaryStr);
			const args = handle.fs.uploadFile.mock.calls[0]!;
			expect(Buffer.isBuffer(args[0])).toBe(true);
			expect(args[0].length).toBe(4);
		});

		it("handles very large content", async () => {
			const handle = createMockHandle();
			const sandbox = await createTestSandbox(handle);
			const large = "x".repeat(10_000_000); // 10MB
			await sandbox.writeFile("/app/large.txt", large);
			const args = handle.fs.uploadFile.mock.calls[0]!;
			expect(args[0].length).toBe(10_000_000);
		});

		it("handles unicode content", async () => {
			const handle = createMockHandle();
			const sandbox = await createTestSandbox(handle);
			await sandbox.writeFile("/app/unicode.txt", "Hello 世界 🌍");
			const args = handle.fs.uploadFile.mock.calls[0]!;
			expect(args[0].toString("utf-8")).toBe("Hello 世界 🌍");
		});
	});

	describe("readFile — edge cases", () => {
		it("handles empty file", async () => {
			const handle = createMockHandle();
			handle.fs.downloadFile.mockResolvedValue(Buffer.from(""));
			const sandbox = await createTestSandbox(handle);
			expect(await sandbox.readFile("/empty")).toBe("");
		});

		it("handles unicode content", async () => {
			const handle = createMockHandle();
			handle.fs.downloadFile.mockResolvedValue(Buffer.from("こんにちは"));
			const sandbox = await createTestSandbox(handle);
			expect(await sandbox.readFile("/jp.txt")).toBe("こんにちは");
		});
	});

	describe("list — edge cases", () => {
		it("handles empty directory", async () => {
			const handle = createMockHandle();
			handle.fs.listFiles.mockResolvedValue([]);
			const sandbox = await createTestSandbox(handle);
			expect(await sandbox.list("/empty")).toEqual([]);
		});

		it("handles directory with many files", async () => {
			const handle = createMockHandle();
			const files = Array.from({ length: 1000 }, (_, i) => ({
				name: `file_${i}.txt`,
			}));
			handle.fs.listFiles.mockResolvedValue(files);
			const sandbox = await createTestSandbox(handle);
			const result = await sandbox.list("/big");
			expect(result.length).toBe(1000);
			expect(result[0]).toBe("file_0.txt");
			expect(result[999]).toBe("file_999.txt");
		});
	});

	describe("concurrent operations", () => {
		it("handles multiple exec calls in parallel", async () => {
			const handle = createMockHandle();
			let callCount = 0;
			handle.process.executeCommand.mockImplementation(async () => {
				callCount++;
				return { result: `result-${callCount}`, exitCode: 0 };
			});
			const sandbox = await createTestSandbox(handle);

			const results = await Promise.all([
				sandbox.exec("cmd1"),
				sandbox.exec("cmd2"),
				sandbox.exec("cmd3"),
			]);

			expect(results.length).toBe(3);
			expect(handle.process.executeCommand).toHaveBeenCalledTimes(3);
			for (const r of results) {
				expect(r.exitCode).toBe(0);
			}
		});

		it("handles mixed read/write in parallel", async () => {
			const handle = createMockHandle();
			const sandbox = await createTestSandbox(handle);

			await Promise.all([
				sandbox.writeFile("/a.txt", "aaa"),
				sandbox.readFile("/b.txt"),
				sandbox.exists("/c.txt"),
				sandbox.list("/"),
				sandbox.exec("echo test"),
			]);

			expect(handle.fs.uploadFile).toHaveBeenCalledTimes(1);
			expect(handle.fs.downloadFile).toHaveBeenCalledTimes(1);
			expect(handle.fs.getFileDetails).toHaveBeenCalledTimes(1);
			expect(handle.fs.listFiles).toHaveBeenCalledTimes(1);
			expect(handle.process.executeCommand).toHaveBeenCalledTimes(1);
		});
	});
});
