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
			createSession: vi.fn().mockResolvedValue(undefined),
			deleteSession: vi.fn().mockResolvedValue(undefined),
			executeSessionCommand: vi.fn().mockResolvedValue({
				cmdId: "cmd-123",
			}),
			getSessionCommand: vi.fn().mockResolvedValue({
				exitCode: 0,
			}),
			getSessionCommandLogs: vi.fn().mockResolvedValue({
				stdout: "output\n",
				stderr: "",
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

		it("uses a session so abortable exec can be cancelled", async () => {
			const handle = createMockHandle();
			const sandbox = await createTestSandbox(handle);
			const controller = new AbortController();

			const result = await sandbox.exec(
				"gh pr view 1",
				"/tmp/workdir",
				{ GH_TOKEN: "secret" },
				controller.signal,
			);

			expect(result).toEqual({
				stdout: "output\n",
				stderr: "",
				exitCode: 0,
			});
			expect(handle.process.executeCommand).not.toHaveBeenCalled();
			expect(handle.process.createSession).toHaveBeenCalledTimes(1);
			expect(handle.process.executeSessionCommand).toHaveBeenCalledWith(
				expect.any(String),
				{
					command: "cd '/tmp/workdir' && GH_TOKEN='secret' gh pr view 1",
					runAsync: true,
					suppressInputEcho: true,
				},
			);
			expect(handle.process.deleteSession).toHaveBeenCalledTimes(1);
		});

		// Cursor Bugbot finding on PR #2748 — round 4 (medium): the plain
		// `executeCommand` fallback path inside `exec` returned raw
		// `result.result` with no cap at all, so a sandbox without an
		// abort signal could load unbounded stdout.
		it("caps plain (no-signal) exec output at the bash-sized buffer (#2748 round-4)", async () => {
			const handle = createMockHandle();
			handle.process.executeCommand.mockResolvedValue({
				result: "x".repeat(50 * 1024),
				exitCode: 0,
			});
			const sandbox = await createTestSandbox(handle);

			const result = await sandbox.exec("echo big");

			expect(result.stdout).toBe("x".repeat(40 * 1024));
			expect(result.exitCode).toBe(0);
			// Session path must not be used when no signal is passed.
			expect(handle.process.createSession).not.toHaveBeenCalled();
		});

		// Cursor Bugbot finding on PR #2748 — round 5 (low/medium):
		// `execWithArgs` forwarded `options` to `execWithSession`
		// without defaulting `maxBuffer`, so the signal/session path was
		// uncapped when the caller omitted `maxBuffer`.
		it("caps execWithArgs output even when the caller omits maxBuffer (#2748 round-5)", async () => {
			const handle = createMockHandle();
			handle.process.executeCommand.mockResolvedValue({
				result: "y".repeat(50 * 1024),
				exitCode: 0,
			});
			const sandbox = await createTestSandbox(handle);

			const result = await sandbox.execWithArgs("gh", ["pr", "view", "1"]);

			expect(result.stdout).toBe("y".repeat(40 * 1024));
			expect(result.exitCode).toBe(0);
		});

		// Cursor Bugbot finding on PR #2757 (medium): execWithArgs was
		// calling execWithSession unconditionally when a signal was
		// supplied, but execWithSession throws on Daytona builds without
		// session API support. We now mirror `exec`'s gate — only take
		// the session path if BOTH signal and session APIs are present,
		// otherwise fall back to plain executeCommand (matching `exec`).
		it("falls back to executeCommand when signal is passed but session APIs are unavailable (#2757 round-2)", async () => {
			const handle = createMockHandle();
			handle.process.createSession = undefined as never;
			handle.process.deleteSession = undefined as never;
			handle.process.executeSessionCommand = undefined as never;
			handle.process.getSessionCommand = undefined as never;
			handle.process.getSessionCommandLogs = undefined as never;
			handle.process.executeCommand.mockResolvedValue({
				result: "fallback ok\n",
				exitCode: 0,
			});
			const sandbox = await createTestSandbox(handle);
			const controller = new AbortController();

			// Before this fix: throws "Daytona abortable execution requires
			// session API support". After: falls back gracefully.
			const result = await sandbox.execWithArgs("echo", ["fallback ok"], {
				signal: controller.signal,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("fallback ok\n");
			expect(handle.process.executeCommand).toHaveBeenCalled();
		});

		it("execWithArgs returns cancelled when signal is already aborted on a sessionless sandbox", async () => {
			const handle = createMockHandle();
			handle.process.createSession = undefined as never;
			handle.process.deleteSession = undefined as never;
			handle.process.executeSessionCommand = undefined as never;
			handle.process.getSessionCommand = undefined as never;
			handle.process.getSessionCommandLogs = undefined as never;
			const sandbox = await createTestSandbox(handle);
			const controller = new AbortController();
			controller.abort();

			const result = await sandbox.execWithArgs("echo", ["should not run"], {
				signal: controller.signal,
			});

			expect(result.exitCode).toBe(1);
			expect(handle.process.executeCommand).not.toHaveBeenCalled();
		});

		it("caps execWithArgs+signal output to the default when no maxBuffer is supplied", async () => {
			const handle = createMockHandle();
			handle.process.getSessionCommandLogs.mockResolvedValue({
				stdout: "z".repeat(50 * 1024),
				stderr: "w".repeat(50 * 1024),
			});
			const sandbox = await createTestSandbox(handle);
			const controller = new AbortController();

			const result = await sandbox.execWithArgs("gh", ["pr", "view", "1"], {
				signal: controller.signal,
				// Intentionally omit `maxBuffer` — the default cap must apply.
			});

			expect(result.stdout).toBe("z".repeat(40 * 1024));
			expect(result.stderr).toBe("w".repeat(40 * 1024));
		});

		it("respects an explicit caller-supplied maxBuffer that's tighter than the default", async () => {
			const handle = createMockHandle();
			handle.process.executeCommand.mockResolvedValue({
				result: "q".repeat(10 * 1024),
				exitCode: 0,
			});
			const sandbox = await createTestSandbox(handle);

			const result = await sandbox.execWithArgs("gh", ["pr", "view", "1"], {
				maxBuffer: 1024,
			});

			expect(result.stdout).toBe("q".repeat(1024));
		});

		it("truncates abortable session output to the bash-sized buffer", async () => {
			const handle = createMockHandle();
			handle.process.getSessionCommandLogs.mockResolvedValue({
				stdout: "a".repeat(50 * 1024),
				stderr: "b".repeat(50 * 1024),
			});
			const sandbox = await createTestSandbox(handle);
			const controller = new AbortController();

			const result = await sandbox.exec(
				"gh pr view 1",
				undefined,
				undefined,
				controller.signal,
			);

			expect(result).toEqual({
				stdout: "a".repeat(40 * 1024),
				stderr: "b".repeat(40 * 1024),
				exitCode: 0,
			});
			expect(handle.process.executeCommand).not.toHaveBeenCalled();
		});

		it("does not emit U+FFFD when the buffer cap falls inside a multi-byte UTF-8 character", async () => {
			// 40 KiB of ASCII followed by `😀` (4 bytes: F0 9F 98 80). The
			// bash-sized buffer is 40 * 1024 bytes, so the cut lands at
			// the very start of the emoji. The buggy implementation
			// (`Buffer#subarray(...).toString("utf-8")`) would emit a U+FFFD
			// at that boundary; the fixed StringDecoder path drops the
			// partial multi-byte sequence silently.
			const handle = createMockHandle();
			const filler = "a".repeat(40 * 1024);
			handle.process.getSessionCommandLogs.mockResolvedValue({
				stdout: `${filler}😀😀😀`,
				stderr: `${filler}😀😀😀`,
			});
			const sandbox = await createTestSandbox(handle);
			const controller = new AbortController();

			const result = await sandbox.exec(
				"gh pr view 1",
				undefined,
				undefined,
				controller.signal,
			);

			expect(result.stdout).toBe(filler);
			expect(result.stdout).not.toContain("�");
			expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(
				40 * 1024,
			);
			expect(result.stderr).toBe(filler);
			expect(result.stderr).not.toContain("�");
			expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThanOrEqual(
				40 * 1024,
			);
		});

		it("falls back to executeCommand when signals are present but session APIs are unavailable", async () => {
			const handle = createMockHandle();
			handle.process.createSession = undefined as never;
			handle.process.deleteSession = undefined as never;
			handle.process.executeSessionCommand = undefined as never;
			handle.process.getSessionCommand = undefined as never;
			handle.process.getSessionCommandLogs = undefined as never;
			const sandbox = await createTestSandbox(handle);
			const controller = new AbortController();

			const result = await sandbox.exec(
				"echo hello",
				undefined,
				undefined,
				controller.signal,
			);

			expect(result).toEqual({
				stdout: "output\n",
				stderr: "",
				exitCode: 0,
			});
			expect(handle.process.executeCommand).toHaveBeenCalledWith("echo hello");
		});
	});

	describe("execWithArgs", () => {
		it("does not start fallback executeCommand when already aborted", async () => {
			const handle = createMockHandle();
			handle.process.createSession = undefined as never;
			handle.process.deleteSession = undefined as never;
			handle.process.executeSessionCommand = undefined as never;
			handle.process.getSessionCommand = undefined as never;
			handle.process.getSessionCommandLogs = undefined as never;
			const controller = new AbortController();
			controller.abort();
			const sandbox = await createTestSandbox(handle);

			const result = await sandbox.execWithArgs("gh", ["pr", "view", "1"], {
				signal: controller.signal,
			});

			expect(result.exitCode).toBe(1);
			expect(handle.process.executeCommand).not.toHaveBeenCalled();
		});

		// Round-2 finding on PR #2757: this used to assert that abortable
		// execWithArgs threw on session-less Daytona builds. The bot
		// flagged that as a behavioral inconsistency with `exec`, which
		// silently falls back. `execWithArgs` now matches `exec` — see
		// the `falls back to executeCommand when signal is passed but
		// session APIs are unavailable` regression earlier in this
		// suite for the positive assertion.
		it("does NOT throw when abortable sessions are unavailable; falls back instead", async () => {
			const handle = createMockHandle();
			handle.process.createSession = undefined as never;
			handle.process.deleteSession = undefined as never;
			handle.process.executeSessionCommand = undefined as never;
			handle.process.getSessionCommand = undefined as never;
			handle.process.getSessionCommandLogs = undefined as never;
			const controller = new AbortController();
			const sandbox = await createTestSandbox(handle);

			const result = await sandbox.execWithArgs("gh", ["pr", "view", "1"], {
				signal: controller.signal,
			});

			// No throw; plain executeCommand was invoked.
			expect(result.exitCode).toBe(0);
			expect(result.stderr).not.toContain(
				"Daytona abortable execution requires session API support",
			);
			expect(handle.process.executeCommand).toHaveBeenCalled();
		});

		it("deletes the remote session when the abort signal fires", async () => {
			const handle = createMockHandle();
			const controller = new AbortController();
			handle.process.getSessionCommand.mockImplementation(
				() =>
					new Promise((_, reject) => {
						controller.signal.addEventListener(
							"abort",
							() => reject(new Error("aborted")),
							{ once: true },
						);
					}),
			);
			const sandbox = await createTestSandbox(handle);

			const promise = sandbox.execWithArgs("gh", ["pr", "view", "1"], {
				signal: controller.signal,
			});
			controller.abort();

			const result = await promise;

			expect(result.exitCode).toBe(1);
			expect(handle.process.executeCommand).not.toHaveBeenCalled();
			expect(handle.process.createSession).toHaveBeenCalledTimes(1);
			expect(handle.process.deleteSession).toHaveBeenCalledTimes(1);
		});

		it("retries session deletion when setup-time abort deletes too early", async () => {
			const handle = createMockHandle();
			const controller = new AbortController();
			let resolveCreateSession!: () => void;
			handle.process.createSession.mockReturnValue(
				new Promise<void>((resolve) => {
					resolveCreateSession = resolve;
				}),
			);
			handle.process.deleteSession
				.mockRejectedValueOnce(new Error("session not ready"))
				.mockResolvedValueOnce(undefined);
			const sandbox = await createTestSandbox(handle);

			const promise = sandbox.execWithArgs("gh", ["pr", "view", "1"], {
				signal: controller.signal,
			});
			await Promise.resolve();
			controller.abort();
			await Promise.resolve();
			resolveCreateSession();

			const result = await promise;

			expect(result.exitCode).toBe(1);
			expect(handle.process.executeSessionCommand).not.toHaveBeenCalled();
			expect(handle.process.deleteSession).toHaveBeenCalledTimes(2);
		});

		it("times out session commands that never complete", async () => {
			vi.useFakeTimers();
			try {
				const handle = createMockHandle();
				handle.process.getSessionCommand.mockResolvedValue({});
				const sandbox = await createTestSandbox(handle);
				const controller = new AbortController();

				const promise = sandbox.execWithArgs("gh", ["pr", "view", "1"], {
					signal: controller.signal,
				});
				await vi.advanceTimersByTimeAsync(90_100);
				const result = await promise;

				expect(result.exitCode).toBe(1);
				expect(result.stderr).toContain("timed out");
				expect(handle.process.deleteSession).toHaveBeenCalledTimes(1);
			} finally {
				vi.useRealTimers();
			}
		});

		it("returns a cancelled result when abort fires after completion is observed", async () => {
			const handle = createMockHandle();
			const controller = new AbortController();
			handle.process.getSessionCommand.mockImplementation(async () => {
				controller.abort();
				return { exitCode: 0 };
			});
			const sandbox = await createTestSandbox(handle);

			const result = await sandbox.execWithArgs("gh", ["pr", "view", "1"], {
				signal: controller.signal,
			});

			expect(result).toEqual({ stdout: "", stderr: "", exitCode: 1 });
			expect(handle.process.getSessionCommandLogs).not.toHaveBeenCalled();
			expect(handle.process.deleteSession).toHaveBeenCalledTimes(1);
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
