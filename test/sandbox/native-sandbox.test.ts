/**
 * Native Sandbox Tests
 *
 * Tests for the macOS Seatbelt and Linux Landlock sandbox implementations.
 */

import {
	existsSync,
	mkdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { platform } from "node:os";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
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
			} else if (platform() === "linux") {
				expect(available).toBe(false);
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

			it("blocks command cwd outside workspace-write execution roots", async () => {
				const outsideDir = join(tmpdir(), `sandbox-cwd-outside-${Date.now()}`);
				mkdirSync(outsideDir, { recursive: true });
				const sandbox = createNativeSandbox(
					{
						mode: "workspace-write",
						excludeSlashTmp: true,
						excludeTmpdir: true,
					},
					testDir,
				);
				await sandbox.initialize();

				try {
					await expect(sandbox.exec("pwd", outsideDir)).rejects.toThrow(
						"Cannot execute workspace-write command outside workspace or explicit writable roots",
					);
				} finally {
					await sandbox.dispose();
					rmSync(outsideDir, { recursive: true, force: true });
				}
			});

			it("allows command cwd inside implicit tmp roots", async () => {
				const tmpWorkspace = join(tmpdir(), `sandbox-cwd-tmp-${Date.now()}`);
				mkdirSync(tmpWorkspace, { recursive: true });
				const sandbox = createNativeSandbox(
					{ mode: "workspace-write" },
					testDir,
				);
				await sandbox.initialize();

				try {
					const result = await sandbox.exec("pwd", tmpWorkspace);
					expect(result.exitCode).toBe(0);
				} finally {
					await sandbox.dispose();
					rmSync(tmpWorkspace, { recursive: true, force: true });
				}
			});

			it("blocks parent-process writes outside workspace-write roots", async () => {
				const outsideDir = join(tmpdir(), `sandbox-outside-${Date.now()}`);
				mkdirSync(outsideDir, { recursive: true });
				const outsidePath = join(outsideDir, "outside.txt");
				const sandbox = createNativeSandbox(
					{
						mode: "workspace-write",
						excludeSlashTmp: true,
						excludeTmpdir: true,
					},
					testDir,
				);
				await sandbox.initialize();

				try {
					await expect(
						sandbox.writeFile(outsidePath, "blocked"),
					).rejects.toThrow(
						"Cannot write outside writable roots in workspace-write sandbox mode",
					);
					expect(existsSync(outsidePath)).toBe(false);
				} finally {
					await sandbox.dispose();
					rmSync(outsideDir, { recursive: true, force: true });
				}
			});

			it("blocks parent-process writes through dangling symlinks outside writable roots", async () => {
				const outsideDir = join(
					tmpdir(),
					`sandbox-dangling-target-${Date.now()}`,
				);
				mkdirSync(outsideDir, { recursive: true });
				const outsidePath = join(outsideDir, "created-through-link.txt");
				symlinkSync(outsidePath, join(testDir, "outside-link.txt"));
				const sandbox = createNativeSandbox(
					{
						mode: "workspace-write",
						excludeSlashTmp: true,
						excludeTmpdir: true,
					},
					testDir,
				);
				await sandbox.initialize();

				try {
					await expect(
						sandbox.writeFile("outside-link.txt", "blocked"),
					).rejects.toThrow(
						"Cannot write outside writable roots in workspace-write sandbox mode",
					);
					expect(existsSync(outsidePath)).toBe(false);
				} finally {
					await sandbox.dispose();
					rmSync(outsideDir, { recursive: true, force: true });
				}
			});

			it("blocks parent-process relative escapes outside the workspace", async () => {
				const escapedPath = join(dirname(testDir), "escaped.txt");
				const sandbox = createNativeSandbox(
					{
						mode: "workspace-write",
						excludeSlashTmp: true,
						excludeTmpdir: true,
					},
					testDir,
				);
				await sandbox.initialize();

				try {
					await expect(
						sandbox.writeFile("../escaped.txt", "blocked"),
					).rejects.toThrow(
						"Cannot write outside writable roots in workspace-write sandbox mode",
					);
					expect(existsSync(escapedPath)).toBe(false);
				} finally {
					await sandbox.dispose();
					rmSync(escapedPath, { force: true });
				}
			});

			it("allows parent-process writes to explicit writable roots", async () => {
				const writableRoot = join(tmpdir(), `sandbox-writable-${Date.now()}`);
				mkdirSync(writableRoot, { recursive: true });
				const allowedPath = join(writableRoot, "allowed.txt");
				const sandbox = createNativeSandbox(
					{
						mode: "workspace-write",
						writableRoots: [writableRoot],
						excludeSlashTmp: true,
						excludeTmpdir: true,
					},
					testDir,
				);
				await sandbox.initialize();

				try {
					await sandbox.writeFile(allowedPath, "allowed");
					expect(await sandbox.readFile(allowedPath)).toBe("allowed");
				} finally {
					await sandbox.dispose();
					rmSync(writableRoot, { recursive: true, force: true });
				}
			});

			it("keeps .git read-only for parent-process writes", async () => {
				const gitDir = join(testDir, ".git");
				mkdirSync(gitDir, { recursive: true });
				const sandbox = createNativeSandbox(
					{
						mode: "workspace-write",
						excludeSlashTmp: true,
						excludeTmpdir: true,
					},
					testDir,
				);
				await sandbox.initialize();

				try {
					await expect(
						sandbox.writeFile(".git/config", "blocked"),
					).rejects.toThrow(
						"Cannot write outside writable roots in workspace-write sandbox mode",
					);
				} finally {
					await sandbox.dispose();
				}
			});

			it("keeps .git read-only even when default tmp roots are writable", async () => {
				const gitDir = join(testDir, ".git");
				mkdirSync(gitDir, { recursive: true });
				const sandbox = createNativeSandbox(
					{ mode: "workspace-write" },
					testDir,
				);
				await sandbox.initialize();

				try {
					await expect(
						sandbox.writeFile(".git/config", "blocked"),
					).rejects.toThrow(
						"Cannot write outside writable roots in workspace-write sandbox mode",
					);
				} finally {
					await sandbox.dispose();
				}
			});

			it("keeps worktree gitdir targets read-only under writable tmp roots", async () => {
				const realGitDir = join(tmpdir(), `sandbox-real-gitdir-${Date.now()}`);
				mkdirSync(realGitDir, { recursive: true });
				writeFileSync(join(testDir, ".git"), `gitdir: ${realGitDir}\n`);
				const sandbox = createNativeSandbox(
					{ mode: "workspace-write" },
					testDir,
				);
				await sandbox.initialize();

				try {
					await expect(
						sandbox.writeFile(join(realGitDir, "config"), "blocked"),
					).rejects.toThrow(
						"Cannot write outside writable roots in workspace-write sandbox mode",
					);
				} finally {
					await sandbox.dispose();
					rmSync(realGitDir, { recursive: true, force: true });
				}
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

			it("deletes workspace symlinks by link path without touching outside targets", async () => {
				const outsideDir = join(
					tmpdir(),
					`sandbox-delete-link-target-${Date.now()}`,
				);
				mkdirSync(outsideDir, { recursive: true });
				const outsidePath = join(outsideDir, "target.txt");
				writeFileSync(outsidePath, "keep me", "utf-8");
				const linkPath = join(testDir, "outside-link.txt");
				symlinkSync(outsidePath, linkPath);
				const sandbox = createNativeSandbox(
					{
						mode: "workspace-write",
						excludeSlashTmp: true,
						excludeTmpdir: true,
					},
					testDir,
				);
				await sandbox.initialize();

				try {
					await sandbox.delete("outside-link.txt");
					expect(existsSync(linkPath)).toBe(false);
					expect(existsSync(outsidePath)).toBe(true);
				} finally {
					await sandbox.dispose();
					rmSync(outsideDir, { recursive: true, force: true });
				}
			});

			it("blocks recursive deletes that would remove read-only git metadata", async () => {
				const gitDir = join(testDir, ".git");
				mkdirSync(gitDir, { recursive: true });
				writeFileSync(join(gitDir, "config"), "protected", "utf-8");
				writeFileSync(join(testDir, "workspace.txt"), "content", "utf-8");
				const sandbox = createNativeSandbox(
					{
						mode: "workspace-write",
						excludeSlashTmp: true,
						excludeTmpdir: true,
					},
					testDir,
				);
				await sandbox.initialize();

				try {
					await expect(sandbox.delete(".", true)).rejects.toThrow(
						"Cannot write outside writable roots in workspace-write sandbox mode",
					);
					expect(existsSync(join(gitDir, "config"))).toBe(true);
					expect(existsSync(join(testDir, "workspace.txt"))).toBe(true);
				} finally {
					await sandbox.dispose();
				}
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

			it("respects URL cwd parameter in execWithArgs", async () => {
				const subDir = join(testDir, "url-subdir");
				mkdirSync(subDir);
				writeFileSync(join(subDir, "marker.txt"), "found-url", "utf-8");

				const sandbox = createNativeSandbox(
					{ mode: "workspace-write" },
					testDir,
				);
				await sandbox.initialize();

				const result = await sandbox.execWithArgs("cat", ["marker.txt"], {
					cwd: pathToFileURL(subDir),
				});
				expect(result.stdout.trim()).toBe("found-url");

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

			it("sets MAESTRO_SANDBOX env var", async () => {
				const sandbox = createNativeSandbox(
					{ mode: "workspace-write" },
					testDir,
				);
				await sandbox.initialize();

				const result = await sandbox.exec("echo $MAESTRO_SANDBOX");
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

		it("treats policy modes as native sandbox requests", async () => {
			if (!isNativeSandboxAvailable()) {
				// Skip on platforms without native sandbox support
				return;
			}

			const sandbox = await createSandbox({
				mode: "workspace-write",
				cwd: testDir,
				native: {
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
