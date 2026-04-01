import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentToolResult } from "../../src/agent/types.js";
import {
	formatGuardianResult,
	runGuardian,
	shouldGuardCommand,
} from "../../src/guardian/index.js";
import { bashTool } from "../../src/tools/bash.js";
import { toolRegistry } from "../../src/tools/index.js";

// Mock the safe-mode and guardian modules
vi.mock("../../src/safety/safe-mode.js", () => ({
	requirePlanCheck: vi.fn(),
}));

vi.mock("../../src/guardian/index.js", () => ({
	shouldGuardCommand: vi.fn().mockReturnValue({ shouldGuard: false }),
	runGuardian: vi.fn(),
	formatGuardianResult: vi.fn(),
}));

// Helper to extract text from content blocks
function getTextOutput(result: AgentToolResult<unknown>): string {
	return (
		result.content
			?.filter((c): c is { type: "text"; text: string } => {
				return (
					c != null && typeof c === "object" && "type" in c && c.type === "text"
				);
			})
			.map((c) => c.text)
			.join("\n") || ""
	);
}

describe("bash tool", () => {
	let testDir: string;

	beforeEach(() => {
		vi.useRealTimers();
		testDir = mkdtempSync(join(tmpdir(), "bash-tool-test-"));
		vi.clearAllMocks();
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("basic command execution", () => {
		it("executes simple echo command", async () => {
			const result = await bashTool.execute("bash-1", {
				command: "echo 'Hello World'",
			});

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("Hello World");
		});

		it("executes via tool registry", async () => {
			const result = await toolRegistry.bash!.execute("bash-registry", {
				command: "echo 'Registry OK'",
			});

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("Registry OK");
		});

		it("executes pwd command", async () => {
			const result = await bashTool.execute("bash-2", {
				command: "pwd",
			});

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("/");
		});

		it("executes command with arguments", async () => {
			const result = await bashTool.execute("bash-3", {
				command: "echo one two three",
			});

			const output = getTextOutput(result);
			expect(output).toContain("one two three");
		});

		it("handles command with no output", async () => {
			const result = await bashTool.execute("bash-4", {
				command: "true",
			});

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("successfully");
		});
	});

	describe("guardian integration", () => {
		it("uses maestro wording when guardian blocks execution", async () => {
			vi.mocked(shouldGuardCommand).mockReturnValueOnce({
				shouldGuard: true,
				trigger: "git",
			});
			vi.mocked(runGuardian).mockResolvedValueOnce({
				status: "failed",
				exitCode: 1,
				startedAt: Date.now(),
				durationMs: 5,
				target: "staged",
				trigger: "git",
				filesScanned: 1,
				summary: "blocked",
				toolResults: [],
			});
			vi.mocked(formatGuardianResult).mockReturnValueOnce("blocked details");

			const result = await bashTool.execute("bash-guardian-1", {
				command: "git push",
			});

			const output = getTextOutput(result);
			expect(output).toContain("Maestro Guardian blocked git");
			expect(output).toContain("blocked details");
			expect(output).not.toContain("Composer Guardian blocked git");
		});
	});

	describe("working directory", () => {
		it("executes in specified cwd", async () => {
			const result = await bashTool.execute("bash-5", {
				command: "pwd",
				cwd: testDir,
			});

			const output = getTextOutput(result);
			expect(output).toContain(testDir);
		});

		it("handles relative cwd", async () => {
			// Create a subdirectory
			const subDir = join(testDir, "subdir");
			require("node:fs").mkdirSync(subDir);

			const result = await bashTool.execute("bash-6", {
				command: "pwd",
				cwd: subDir,
			});

			const output = getTextOutput(result);
			expect(output).toContain("subdir");
		});
	});

	describe("environment variables", () => {
		it("passes custom environment variables", async () => {
			const result = await bashTool.execute("bash-7", {
				command: 'echo "Value: $MY_VAR"',
				env: { MY_VAR: "test_value" },
			});

			const output = getTextOutput(result);
			expect(output).toContain("test_value");
		});

		it("inherits existing environment", async () => {
			const result = await bashTool.execute("bash-8", {
				command: 'echo "Home: $HOME"',
			});

			const output = getTextOutput(result);
			expect(output).toContain("Home:");
			expect(output).not.toContain("$HOME");
		});
	});

	describe("command chaining", () => {
		it("supports && chaining", async () => {
			const result = await bashTool.execute("bash-9", {
				command: "echo first && echo second",
			});

			const output = getTextOutput(result);
			expect(output).toContain("first");
			expect(output).toContain("second");
		});

		it("supports ; chaining", async () => {
			const result = await bashTool.execute("bash-10", {
				command: "echo one; echo two",
			});

			const output = getTextOutput(result);
			expect(output).toContain("one");
			expect(output).toContain("two");
		});

		it("supports pipe", async () => {
			const result = await bashTool.execute("bash-11", {
				command: "echo 'hello world' | tr 'a-z' 'A-Z'",
			});

			const output = getTextOutput(result);
			expect(output).toContain("HELLO WORLD");
		});
	});

	describe("exit codes", () => {
		it("reports non-zero exit code", async () => {
			const result = await bashTool.execute("bash-12", {
				command: "exit 1",
			});

			const output = getTextOutput(result);
			expect(output).toContain("Exit code: 1");
		});

		it("includes exit code in output for failures", async () => {
			const result = await bashTool.execute("bash-13", {
				command: "false",
			});

			const output = getTextOutput(result);
			expect(output).toContain("Exit code");
		});
	});

	describe("stderr handling", () => {
		it("captures stderr output", async () => {
			const result = await bashTool.execute("bash-14", {
				command: "echo error >&2",
			});

			const output = getTextOutput(result);
			expect(output).toContain("error");
		});

		it("combines stdout and stderr", async () => {
			const result = await bashTool.execute("bash-15", {
				command: "echo stdout; echo stderr >&2",
			});

			const output = getTextOutput(result);
			expect(output).toContain("stdout");
			expect(output).toContain("stderr");
		});
	});

	describe("file operations", () => {
		it("can read files with cat", async () => {
			const filePath = join(testDir, "test.txt");
			writeFileSync(filePath, "file contents");

			const result = await bashTool.execute("bash-16", {
				command: `cat "${filePath}"`,
			});

			const output = getTextOutput(result);
			expect(output).toContain("file contents");
		});

		it("can list directory", async () => {
			writeFileSync(join(testDir, "file1.txt"), "");
			writeFileSync(join(testDir, "file2.txt"), "");

			const result = await bashTool.execute("bash-17", {
				command: `ls "${testDir}"`,
			});

			const output = getTextOutput(result);
			expect(output).toContain("file1.txt");
			expect(output).toContain("file2.txt");
		});
	});

	describe("timeout handling", () => {
		it("respects timeout parameter", async () => {
			vi.useFakeTimers();
			try {
				const promise = bashTool.execute("bash-18", {
					command: "sleep 10",
					timeout: 1,
				});

				await vi.advanceTimersByTimeAsync(1000);
				const result = await promise;

				const output = getTextOutput(result);
				expect(output).toContain("timed out");
			} finally {
				vi.useRealTimers();
			}
		});

		it("completes before timeout", async () => {
			const result = await bashTool.execute("bash-19", {
				command: "echo fast",
				timeout: 10,
			});

			const output = getTextOutput(result);
			expect(output).toContain("fast");
			expect(output).not.toContain("timed out");
		});
	});

	describe("interpolation", () => {
		it("interpolates ${cwd}", async () => {
			const result = await bashTool.execute("bash-20", {
				command: 'echo "CWD: ${cwd}"',
			});

			const output = getTextOutput(result);
			expect(output).toContain("CWD:");
			expect(output).toContain("/");
		});

		it("interpolates ${home}", async () => {
			const result = await bashTool.execute("bash-21", {
				command: 'echo "Home: ${home}"',
			});

			const output = getTextOutput(result);
			expect(output).toContain("Home:");
		});
	});

	describe("abort signal", () => {
		it("respects abort signal during execution", async () => {
			vi.useFakeTimers();
			try {
				const controller = new AbortController();

				// Start a long-running command then abort after a short delay
				const promise = bashTool.execute(
					"bash-22",
					{ command: "sleep 10" },
					controller.signal,
				);

				// Abort after 100ms (fake timers)
				setTimeout(() => controller.abort(), 100);
				await vi.advanceTimersByTimeAsync(100);

				// Switch back to real timers so the process can exit promptly
				vi.useRealTimers();

				const race = Promise.race([
					promise.then(() => "done"),
					new Promise((resolve) => setTimeout(() => resolve("timeout"), 500)),
				]);
				const outcome = await race;

				// The key test: it shouldn't wait 10 seconds
				expect(outcome).toBe("done");
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe("special characters", () => {
		it("handles quotes in command", async () => {
			const result = await bashTool.execute("bash-23", {
				command: `echo "double quotes" 'single quotes'`,
			});

			const output = getTextOutput(result);
			expect(output).toContain("double quotes");
			expect(output).toContain("single quotes");
		});

		it("handles paths with spaces", async () => {
			const dirWithSpaces = join(testDir, "dir with spaces");
			require("node:fs").mkdirSync(dirWithSpaces);
			writeFileSync(join(dirWithSpaces, "file.txt"), "content");

			const result = await bashTool.execute("bash-24", {
				command: `cat "${join(dirWithSpaces, "file.txt")}"`,
			});

			const output = getTextOutput(result);
			expect(output).toContain("content");
		});
	});

	describe("multiline output", () => {
		it("preserves multiline output", async () => {
			const result = await bashTool.execute("bash-25", {
				command: 'echo -e "line1\\nline2\\nline3"',
			});

			const output = getTextOutput(result);
			expect(output).toContain("line1");
			expect(output).toContain("line2");
			expect(output).toContain("line3");
		});
	});

	describe("process cleanup edge cases", () => {
		it("kills process tree on timeout", async () => {
			// Start a command that spawns a subprocess
			const result = await bashTool.execute("bash-26", {
				command: "bash -c 'sleep 30 & sleep 30'",
				timeout: 0.1, // 100ms timeout
			});

			const output = getTextOutput(result);
			expect(output).toContain("timed out");
		});

		it("handles command that exits before timeout", async () => {
			const result = await bashTool.execute("bash-28", {
				command: "echo 'quick'; exit 0",
				timeout: 5,
			});

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("quick");
		});

		it("handles command that outputs continuously then times out", async () => {
			const result = await bashTool.execute("bash-29", {
				command: "for i in 1 2 3; do echo $i; sleep 0.1; done; sleep 30",
				timeout: 0.5,
			});

			const output = getTextOutput(result);
			// Should capture some output before timeout
			expect(output).toContain("1");
			expect(output).toContain("timed out");
		});

		it("handles stderr output on timeout", async () => {
			const result = await bashTool.execute("bash-30", {
				command: "echo 'error message' >&2; sleep 30",
				timeout: 0.1,
			});

			const output = getTextOutput(result);
			expect(output).toContain("error message");
			expect(output).toContain("timed out");
		});

		it("handles concurrent abort and timeout", async () => {
			const controller = new AbortController();

			const promise = bashTool.execute(
				"bash-31",
				{ command: "sleep 30", timeout: 0.2 },
				controller.signal,
			);

			// Abort at the same time as timeout
			setTimeout(() => controller.abort(), 200);

			const result = await promise;
			const output = getTextOutput(result);
			// Either abort or timeout message is acceptable
			expect(output).toMatch(/aborted|timed out/i);
		});
	});
});
