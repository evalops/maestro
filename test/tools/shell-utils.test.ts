import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getShellConfig,
	killProcessTree,
	parseCommandArguments,
	validateShellParams,
} from "../../src/tools/shell-utils.js";
import {
	applyShellEnvironmentPolicy,
	resolveShellEnvironment,
} from "../../src/utils/shell-env.js";

describe("shell-utils", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "shell-utils-test-"));
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
		vi.unstubAllEnvs();
	});

	describe("getShellConfig", () => {
		it("uses SHELL on unix platforms when set", () => {
			if (process.platform !== "win32") {
				vi.stubEnv("SHELL", "/bin/sh");
				const config = getShellConfig();
				expect(config.shell).toBe("/bin/sh");
				expect(config.args).toEqual(["-c"]);
			}
		});

		it("falls back to /bin/bash or sh when SHELL is missing", () => {
			if (process.platform !== "win32") {
				vi.stubEnv("SHELL", "");
				const config = getShellConfig();
				const expected = existsSync("/bin/bash") ? "/bin/bash" : "sh";
				expect(config.shell).toBe(expected);
				expect(config.args).toEqual(["-c"]);
			}
		});

		it("returns correct args structure", () => {
			const config = getShellConfig();
			expect(config).toHaveProperty("shell");
			expect(config).toHaveProperty("args");
			expect(Array.isArray(config.args)).toBe(true);
		});
	});

	describe("killProcessTree", () => {
		it("handles non-existent pid gracefully", () => {
			// Should not throw for invalid PID
			// Use a very high PID that won't exist
			expect(() => killProcessTree(999999999)).not.toThrow();
		});

		it("handles negative pid gracefully", () => {
			// Negative PIDs are invalid and should return early without error
			expect(() => killProcessTree(-1)).not.toThrow();
		});

		it("handles zero pid gracefully", () => {
			// Zero is invalid and should return early without error
			expect(() => killProcessTree(0)).not.toThrow();
		});

		it("handles PID 1 gracefully", () => {
			// PID 1 (init) should be protected and return early
			expect(() => killProcessTree(1)).not.toThrow();
		});
	});

	describe("validateShellParams", () => {
		it("validates basic command", () => {
			const result = validateShellParams("echo hello");
			expect(result).toEqual({ resolvedCwd: undefined });
		});

		it("throws for empty command", () => {
			expect(() => validateShellParams("")).toThrow();
		});

		it("throws for command with control characters", () => {
			expect(() => validateShellParams("echo\x00hello")).toThrow(
				"Command contains invalid control characters",
			);
		});

		it("validates cwd when provided", () => {
			const result = validateShellParams("echo hello", testDir);
			expect(result.resolvedCwd).toBe(testDir);
		});

		it("throws for non-existent cwd", () => {
			expect(() =>
				validateShellParams("echo hello", "/nonexistent/path/xyz"),
			).toThrow("Working directory not found");
		});

		it("throws for empty cwd", () => {
			expect(() => validateShellParams("echo hello", "")).toThrow();
		});

		it("validates environment variables", () => {
			const result = validateShellParams("echo hello", undefined, {
				FOO: "bar",
				BAZ: "qux",
			});
			expect(result).toEqual({ resolvedCwd: undefined });
		});

		it("throws for env var with control characters", () => {
			expect(() =>
				validateShellParams("echo hello", undefined, {
					FOO: "bar\x00baz",
				}),
			).toThrow("contains invalid characters");
		});

		it("throws for env var key with control characters", () => {
			expect(() =>
				validateShellParams("echo hello", undefined, {
					"FOO\x00": "bar",
				}),
			).toThrow("contains invalid characters");
		});

		it("expands ~ in cwd path", () => {
			// Create a subdirectory in testDir and use it
			const subDir = join(testDir, "subdir");
			mkdirSync(subDir);
			const result = validateShellParams("echo hello", subDir);
			expect(result.resolvedCwd).toBe(subDir);
		});
	});

	describe("parseCommandArguments", () => {
		it("parses simple command", () => {
			const args = parseCommandArguments("echo hello world");
			expect(args).toEqual(["echo", "hello", "world"]);
		});

		it("parses command with single quotes", () => {
			const args = parseCommandArguments("echo 'hello world'");
			expect(args).toEqual(["echo", "hello world"]);
		});

		it("parses command with double quotes", () => {
			const args = parseCommandArguments('echo "hello world"');
			expect(args).toEqual(["echo", "hello world"]);
		});

		it("parses command with escaped characters", () => {
			const args = parseCommandArguments("echo hello\\ world");
			expect(args).toEqual(["echo", "hello world"]);
		});

		it("parses command with mixed quotes", () => {
			const args = parseCommandArguments(`echo "hello" 'world'`);
			expect(args).toEqual(["echo", "hello", "world"]);
		});

		it("handles nested quotes", () => {
			const args = parseCommandArguments(`echo "it's a test"`);
			expect(args).toEqual(["echo", "it's a test"]);
		});

		it("throws for unterminated single quote", () => {
			expect(() => parseCommandArguments("echo 'hello")).toThrow(
				"unterminated quotes",
			);
		});

		it("throws for unterminated double quote", () => {
			expect(() => parseCommandArguments('echo "hello')).toThrow(
				"unterminated quotes",
			);
		});

		it("throws for unfinished escape sequence", () => {
			expect(() => parseCommandArguments("echo hello\\")).toThrow(
				"unfinished escape sequence",
			);
		});

		it("throws for empty command", () => {
			expect(() => parseCommandArguments("")).toThrow();
		});

		it("handles multiple spaces between arguments", () => {
			const args = parseCommandArguments("echo    hello     world");
			expect(args).toEqual(["echo", "hello", "world"]);
		});

		it("handles tabs and other whitespace", () => {
			const args = parseCommandArguments("echo\thello\tworld");
			expect(args).toEqual(["echo", "hello", "world"]);
		});

		it("handles escaped quotes inside double quotes", () => {
			const args = parseCommandArguments('echo "hello \\"world\\""');
			expect(args).toEqual(["echo", 'hello "world"']);
		});

		it("does not escape inside single quotes", () => {
			const args = parseCommandArguments("echo 'hello\\nworld'");
			expect(args).toEqual(["echo", "hello\\nworld"]);
		});

		it("preserves empty quoted arguments", () => {
			const args = parseCommandArguments('echo "" ""');
			expect(args).toEqual(["echo", "", ""]);
		});

		it("preserves empty argument at end", () => {
			const args = parseCommandArguments('node -e ""');
			expect(args).toEqual(["node", "-e", ""]);
		});
	});

	describe("shell environment policy", () => {
		it("excludes default secret-like variables by default", () => {
			const baseEnv = {
				PATH: "/usr/bin",
				OPENAI_API_KEY: "sk-test",
				GITHUB_TOKEN: "ghp-test",
				NORMAL: "ok",
			};
			const env = applyShellEnvironmentPolicy(baseEnv);
			expect(env.PATH).toBe("/usr/bin");
			expect(env.NORMAL).toBe("ok");
			expect(env.OPENAI_API_KEY).toBeUndefined();
			expect(env.GITHUB_TOKEN).toBeUndefined();
		});

		it("keeps secret-like variables when ignore_default_excludes is true", () => {
			const baseEnv = {
				OPENAI_API_KEY: "sk-test",
				NORMAL: "ok",
			};
			const env = applyShellEnvironmentPolicy(baseEnv, {
				ignore_default_excludes: true,
			});
			expect(env.OPENAI_API_KEY).toBe("sk-test");
			expect(env.NORMAL).toBe("ok");
		});

		it("supports inherit core", () => {
			const baseEnv = {
				PATH: "/bin",
				HOME: "/home/test",
				OPENAI_API_KEY: "sk-test",
			};
			const env = applyShellEnvironmentPolicy(baseEnv, {
				inherit: "core",
				ignore_default_excludes: true,
			});
			expect(env.PATH).toBe("/bin");
			expect(env.HOME).toBe("/home/test");
			expect(env.OPENAI_API_KEY).toBeUndefined();
		});

		it("applies include_only patterns", () => {
			const baseEnv = {
				PATH: "/bin",
				HOME: "/home/test",
				EDITOR: "vim",
			};
			const env = applyShellEnvironmentPolicy(baseEnv, {
				ignore_default_excludes: true,
				include_only: ["PATH", "HOME"],
			});
			expect(env.PATH).toBe("/bin");
			expect(env.HOME).toBe("/home/test");
			expect(env.EDITOR).toBeUndefined();
		});

		it("merges explicit overrides after policy", () => {
			const baseEnv = {
				PATH: "/bin",
				OPENAI_API_KEY: "sk-test",
			};
			const env = resolveShellEnvironment(
				{ OPENAI_API_KEY: "override" },
				{ baseEnv },
			);
			expect(env.PATH).toBe("/bin");
			expect(env.OPENAI_API_KEY).toBe("override");
		});
	});
});
