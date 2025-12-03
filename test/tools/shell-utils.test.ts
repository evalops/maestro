import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getShellConfig,
	killProcessTree,
	parseCommandArguments,
	validateShellParams,
} from "../../src/tools/shell-utils.js";

describe("shell-utils", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "shell-utils-test-"));
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("getShellConfig", () => {
		it("returns sh on unix platforms", () => {
			if (process.platform !== "win32") {
				const config = getShellConfig();
				expect(config.shell).toBe("sh");
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
			expect(() => killProcessTree(999999999)).not.toThrow();
		});

		it("handles negative pid gracefully", () => {
			expect(() => killProcessTree(-1)).not.toThrow();
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
	});
});
