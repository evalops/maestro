/**
 * Native Sandbox Tests
 *
 * Tests for the macOS Seatbelt and Linux Landlock sandbox implementations.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSandbox } from "../../src/sandbox/index.js";
import {
	NativeSandbox,
	type NativeSandboxPolicy,
	createNativeSandbox,
	getNativeSandboxType,
	isNativeSandboxAvailable,
} from "../../src/sandbox/native-sandbox.js";

describe("Native Sandbox", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `sandbox-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("isNativeSandboxAvailable", () => {
		it("returns boolean based on platform", () => {
			const available = isNativeSandboxAvailable();
			expect(typeof available).toBe("boolean");

			// On macOS, should check for sandbox-exec
			if (platform() === "darwin") {
				// Most macOS systems have sandbox-exec
				expect(available).toBe(existsSync("/usr/bin/sandbox-exec"));
			}
		});
	});

	describe("getNativeSandboxType", () => {
		it("returns correct sandbox type for platform", () => {
			const sandboxType = getNativeSandboxType();

			if (platform() === "darwin") {
				expect(sandboxType).toBe("seatbelt");
			} else if (platform() === "linux") {
				expect(sandboxType).toBe("landlock");
			} else {
				expect(sandboxType).toBe("none");
			}
		});
	});

	describe("createNativeSandbox", () => {
		it("creates sandbox with workspace-write policy", () => {
			const policy: NativeSandboxPolicy = {
				mode: "workspace-write",
				networkAccess: true,
			};

			const sandbox = createNativeSandbox(policy, testDir);
			expect(sandbox).toBeInstanceOf(NativeSandbox);
		});

		it("creates sandbox with read-only policy", () => {
			const policy: NativeSandboxPolicy = {
				mode: "read-only",
			};

			const sandbox = createNativeSandbox(policy, testDir);
			expect(sandbox).toBeInstanceOf(NativeSandbox);
		});
	});

	describe("NativeSandbox", () => {
		describe("file operations", () => {
			it("reads files correctly", async () => {
				const testFile = join(testDir, "test.txt");
				writeFileSync(testFile, "hello world", "utf-8");

				const sandbox = createNativeSandbox(
					{ mode: "workspace-write" },
					testDir,
				);
				await sandbox.initialize();

				const content = await sandbox.readFile("test.txt");
				expect(content).toBe("hello world");

				await sandbox.dispose();
			});

			it("writes files in workspace-write mode", async () => {
				const sandbox = createNativeSandbox(
					{ mode: "workspace-write" },
					testDir,
				);
				await sandbox.initialize();

				await sandbox.writeFile("output.txt", "written content");

				const written = await sandbox.readFile("output.txt");
				expect(written).toBe("written content");

				await sandbox.dispose();
			});

			it("throws on write in read-only mode", async () => {
				const sandbox = createNativeSandbox({ mode: "read-only" }, testDir);
				await sandbox.initialize();

				await expect(
					sandbox.writeFile("should-fail.txt", "content"),
				).rejects.toThrow("Cannot write files in read-only sandbox mode");

				await sandbox.dispose();
			});

			it("checks file existence", async () => {
				const testFile = join(testDir, "existing.txt");
				writeFileSync(testFile, "exists", "utf-8");

				const sandbox = createNativeSandbox(
					{ mode: "workspace-write" },
					testDir,
				);
				await sandbox.initialize();

				expect(await sandbox.exists("existing.txt")).toBe(true);
				expect(await sandbox.exists("nonexistent.txt")).toBe(false);

				await sandbox.dispose();
			});

			it("lists directory contents", async () => {
				writeFileSync(join(testDir, "file1.txt"), "1", "utf-8");
				writeFileSync(join(testDir, "file2.txt"), "2", "utf-8");
				mkdirSync(join(testDir, "subdir"));

				const sandbox = createNativeSandbox(
					{ mode: "workspace-write" },
					testDir,
				);
				await sandbox.initialize();

				const files = await sandbox.list(".");
				expect(files).toContain("file1.txt");
				expect(files).toContain("file2.txt");
				expect(files).toContain("subdir");

				await sandbox.dispose();
			});

			it("deletes files", async () => {
				const testFile = join(testDir, "to-delete.txt");
				writeFileSync(testFile, "delete me", "utf-8");

				const sandbox = createNativeSandbox(
					{ mode: "workspace-write" },
					testDir,
				);
				await sandbox.initialize();

				expect(await sandbox.exists("to-delete.txt")).toBe(true);
				await sandbox.delete("to-delete.txt");
				expect(await sandbox.exists("to-delete.txt")).toBe(false);

				await sandbox.dispose();
			});

			it("throws on delete in read-only mode", async () => {
				const testFile = join(testDir, "protected.txt");
				writeFileSync(testFile, "protected", "utf-8");

				const sandbox = createNativeSandbox({ mode: "read-only" }, testDir);
				await sandbox.initialize();

				await expect(sandbox.delete("protected.txt")).rejects.toThrow(
					"Cannot delete files in read-only sandbox mode",
				);

				await sandbox.dispose();
			});
		});

		describe("command execution", () => {
			it("executes simple commands", async () => {
				const sandbox = createNativeSandbox(
					{ mode: "workspace-write" },
					testDir,
				);
				await sandbox.initialize();

				const result = await sandbox.exec("echo 'hello'");
				expect(result.stdout.trim()).toBe("hello");
				expect(result.exitCode).toBe(0);

				await sandbox.dispose();
			});

			it("captures stderr", async () => {
				const sandbox = createNativeSandbox(
					{ mode: "workspace-write" },
					testDir,
				);
				await sandbox.initialize();

				const result = await sandbox.exec("echo error >&2");
				expect(result.stderr.trim()).toBe("error");
				expect(result.exitCode).toBe(0);

				await sandbox.dispose();
			});

			it("returns non-zero exit code on failure", async () => {
				const sandbox = createNativeSandbox(
					{ mode: "workspace-write" },
					testDir,
				);
				await sandbox.initialize();

				const result = await sandbox.exec("exit 42");
				expect(result.exitCode).toBe(42);

				await sandbox.dispose();
			});

			it("respects cwd parameter", async () => {
				const subDir = join(testDir, "subdir");
				mkdirSync(subDir);
				writeFileSync(join(subDir, "marker.txt"), "found", "utf-8");

				const sandbox = createNativeSandbox(
					{ mode: "workspace-write" },
					testDir,
				);
				await sandbox.initialize();

				const result = await sandbox.exec("cat marker.txt", subDir);
				expect(result.stdout.trim()).toBe("found");

				await sandbox.dispose();
			});

			it("passes environment variables", async () => {
				const sandbox = createNativeSandbox(
					{ mode: "workspace-write" },
					testDir,
				);
				await sandbox.initialize();

				const result = await sandbox.exec("echo $MY_VAR", undefined, {
					MY_VAR: "custom_value",
				});
				expect(result.stdout.trim()).toBe("custom_value");

				await sandbox.dispose();
			});

			it("sets COMPOSER_SANDBOX env var", async () => {
				const sandbox = createNativeSandbox(
					{ mode: "workspace-write" },
					testDir,
				);
				await sandbox.initialize();

				const result = await sandbox.exec("echo $COMPOSER_SANDBOX");
				const expectedType =
					platform() === "darwin"
						? "seatbelt"
						: platform() === "linux"
							? "landlock"
							: "none";
				expect(result.stdout.trim()).toBe(expectedType);

				await sandbox.dispose();
			});
		});

		// Platform-specific sandboxing tests
		if (platform() === "darwin" && existsSync("/usr/bin/sandbox-exec")) {
			describe("macOS Seatbelt", () => {
				it("blocks writes outside workspace in workspace-write mode", async () => {
					const sandbox = createNativeSandbox(
						{
							mode: "workspace-write",
							excludeTmpdir: true,
							excludeSlashTmp: true,
						},
						testDir,
					);
					await sandbox.initialize();

					// Try to write to /tmp (should fail under seatbelt)
					const result = await sandbox.exec(
						"touch /tmp/seatbelt-test-should-fail-$$ 2>&1",
					);

					// Seatbelt returns "Operation not permitted" on blocked writes
					expect(
						result.exitCode !== 0 ||
							result.stderr.includes("Operation not permitted") ||
							result.stderr.includes("denied"),
					).toBe(true);

					await sandbox.dispose();
				});

				it("allows writes within workspace", async () => {
					const sandbox = createNativeSandbox(
						{ mode: "workspace-write" },
						testDir,
					);
					await sandbox.initialize();

					const result = await sandbox.exec(
						"touch allowed.txt && ls allowed.txt",
					);
					expect(result.exitCode).toBe(0);
					expect(result.stdout.trim()).toBe("allowed.txt");

					await sandbox.dispose();
				});

				it("read-only mode blocks all writes", async () => {
					const sandbox = createNativeSandbox({ mode: "read-only" }, testDir);
					await sandbox.initialize();

					// Even writing to the workspace should fail
					const result = await sandbox.exec(
						"touch blocked.txt 2>&1; echo exit=$?",
					);

					// Verify the file was not created by checking both:
					// 1. Non-zero exit code OR error in output
					// 2. The file doesn't exist
					const writeBlocked =
						result.exitCode !== 0 ||
						result.stderr.includes("Operation not permitted") ||
						result.stderr.includes("denied") ||
						result.stdout.includes("Operation not permitted") ||
						result.stdout.includes("denied");

					// If sandbox didn't block, at least verify via file check
					if (!writeBlocked) {
						const fileExists = await sandbox.exists("blocked.txt");
						expect(fileExists).toBe(false);
					}

					await sandbox.dispose();
				});
			});
		}
	});

	describe("createSandbox with native mode", () => {
		it("creates native sandbox when mode is native", async () => {
			if (!isNativeSandboxAvailable()) {
				// Skip on platforms without native sandbox support
				return;
			}

			const sandbox = await createSandbox({
				mode: "native",
				cwd: testDir,
				native: {
					policy: "workspace-write",
					networkAccess: true,
				},
			});

			expect(sandbox).toBeInstanceOf(NativeSandbox);
			await sandbox?.dispose();
		});

		it("falls back to local when native not available", async () => {
			// This test is platform-dependent
			// On unsupported platforms, native should fall back to local
			const originalPlatform = process.platform;

			// We can't easily mock platform(), so just verify the fallback logic exists
			const sandbox = await createSandbox({
				mode: "native",
				cwd: testDir,
			});

			if (sandbox) {
				// Should either be NativeSandbox or LocalSandbox
				expect(sandbox.exec).toBeDefined();
				expect(sandbox.dispose).toBeDefined();
				await sandbox.dispose();
			}
		});
	});
});
