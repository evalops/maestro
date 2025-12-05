import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type SandboxMode,
	createSandbox,
	loadSandboxConfig,
} from "../src/sandbox/index.js";
import { LocalSandbox } from "../src/sandbox/local-sandbox.js";

describe("Sandbox", () => {
	describe("LocalSandbox", () => {
		let sandbox: LocalSandbox;

		beforeEach(() => {
			sandbox = new LocalSandbox();
		});

		afterEach(async () => {
			await sandbox.dispose();
		});

		it("should execute commands", async () => {
			const result = await sandbox.exec("echo hello");
			expect(result.exitCode).toBe(0);
			expect(result.stdout.trim()).toBe("hello");
		});

		it("should handle command errors", async () => {
			const result = await sandbox.exec("exit 1");
			expect(result.exitCode).toBe(1);
		});

		it("should read files", async () => {
			const testDir = join(tmpdir(), `sandbox-test-${Date.now()}`);
			mkdirSync(testDir, { recursive: true });
			const testFile = join(testDir, "test.txt");
			writeFileSync(testFile, "test content");

			try {
				const content = await sandbox.readFile(testFile);
				expect(content).toBe("test content");
			} finally {
				rmSync(testDir, { recursive: true, force: true });
			}
		});

		it("should write files", async () => {
			const testDir = join(tmpdir(), `sandbox-test-${Date.now()}`);
			mkdirSync(testDir, { recursive: true });
			const testFile = join(testDir, "output.txt");

			try {
				await sandbox.writeFile(testFile, "written content");
				const content = await sandbox.readFile(testFile);
				expect(content).toBe("written content");
			} finally {
				rmSync(testDir, { recursive: true, force: true });
			}
		});

		it("should check file existence", async () => {
			const testDir = join(tmpdir(), `sandbox-test-${Date.now()}`);
			mkdirSync(testDir, { recursive: true });
			const existingFile = join(testDir, "exists.txt");
			const nonExistingFile = join(testDir, "not-exists.txt");
			writeFileSync(existingFile, "content");

			try {
				expect(await sandbox.exists(existingFile)).toBe(true);
				expect(await sandbox.exists(nonExistingFile)).toBe(false);
			} finally {
				rmSync(testDir, { recursive: true, force: true });
			}
		});
	});

	describe("loadSandboxConfig", () => {
		let testDir: string;

		beforeEach(() => {
			testDir = join(tmpdir(), `sandbox-config-test-${Date.now()}`);
			mkdirSync(join(testDir, ".composer"), { recursive: true });
		});

		afterEach(() => {
			rmSync(testDir, { recursive: true, force: true });
		});

		it("should return undefined when no config file exists", () => {
			const config = loadSandboxConfig(testDir);
			// Remove the .composer dir to simulate no config
			rmSync(join(testDir, ".composer"), { recursive: true, force: true });
			expect(loadSandboxConfig(testDir)).toBeUndefined();
		});

		it("should load valid config file", () => {
			const configPath = join(testDir, ".composer", "sandbox.json");
			writeFileSync(
				configPath,
				JSON.stringify({
					mode: "docker",
					docker: {
						image: "node:18",
						workspaceMount: "/app",
					},
				}),
			);

			const config = loadSandboxConfig(testDir);
			expect(config).toEqual({
				mode: "docker",
				docker: {
					image: "node:18",
					workspaceMount: "/app",
				},
			});
		});

		it("should return undefined for invalid JSON", () => {
			const configPath = join(testDir, ".composer", "sandbox.json");
			writeFileSync(configPath, "{ invalid json }");

			// Should log warning and return undefined
			const config = loadSandboxConfig(testDir);
			expect(config).toBeUndefined();
		});
	});

	describe("createSandbox", () => {
		let originalWebServer: string | undefined;

		beforeEach(() => {
			// Ensure web-server mode is disabled for these tests
			originalWebServer = process.env.COMPOSER_WEB_SERVER;
			// biome-ignore lint/performance/noDelete: Must use delete, not = undefined (which sets to string "undefined")
			delete process.env.COMPOSER_WEB_SERVER;
		});

		afterEach(() => {
			// Restore original env
			if (originalWebServer !== undefined) {
				process.env.COMPOSER_WEB_SERVER = originalWebServer;
			} else {
				// biome-ignore lint/performance/noDelete: Must use delete, not = undefined (which sets to string "undefined")
				delete process.env.COMPOSER_WEB_SERVER;
			}
		});

		it("should return undefined for mode 'none'", async () => {
			const sandbox = await createSandbox({ mode: "none" });
			expect(sandbox).toBeUndefined();
		});

		it("should create LocalSandbox for mode 'local'", async () => {
			const sandbox = await createSandbox({ mode: "local" });
			expect(sandbox).toBeInstanceOf(LocalSandbox);
			await sandbox?.dispose();
		});

		it("should respect COMPOSER_SANDBOX_MODE env var", async () => {
			const originalEnv = process.env.COMPOSER_SANDBOX_MODE;
			try {
				process.env.COMPOSER_SANDBOX_MODE = "local";
				const sandbox = await createSandbox({});
				expect(sandbox).toBeInstanceOf(LocalSandbox);
				await sandbox?.dispose();
			} finally {
				if (originalEnv === undefined) {
					// biome-ignore lint/performance/noDelete: Must use delete, not = undefined (which sets to string "undefined")
					delete process.env.COMPOSER_SANDBOX_MODE;
				} else {
					process.env.COMPOSER_SANDBOX_MODE = originalEnv;
				}
			}
		});

		it("should use config file when no explicit mode", async () => {
			const testDir = join(tmpdir(), `sandbox-create-test-${Date.now()}`);
			mkdirSync(join(testDir, ".composer"), { recursive: true });
			const configPath = join(testDir, ".composer", "sandbox.json");
			writeFileSync(configPath, JSON.stringify({ mode: "local" }));

			// Save and clear env var to ensure config is used
			const originalEnv = process.env.COMPOSER_SANDBOX_MODE;
			// biome-ignore lint/performance/noDelete: Must use delete, not = undefined (which sets to string "undefined")
			delete process.env.COMPOSER_SANDBOX_MODE;

			try {
				const sandbox = await createSandbox({ cwd: testDir });
				expect(sandbox).toBeInstanceOf(LocalSandbox);
				await sandbox?.dispose();
			} finally {
				// Restore env var
				if (originalEnv !== undefined) {
					process.env.COMPOSER_SANDBOX_MODE = originalEnv;
				}
				rmSync(testDir, { recursive: true, force: true });
			}
		});
	});
});
