import { beforeAll, describe, expect, it } from "vitest";
import {
	analyzeCommandSafety,
	ensureParserReady,
	isKnownSafeCommand,
	isParserAvailable,
	parseBashCommand,
	unwrapShellCommand,
} from "../src/safety/bash-parser.js";

describe("bash-parser", () => {
	beforeAll(async () => {
		// Ensure parser initialization completes before tests run
		await ensureParserReady();
	});

	describe("parseBashCommand", () => {
		it("parses simple commands", () => {
			if (!isParserAvailable()) {
				// Skip test if parser not available (e.g., no native bindings)
				return;
			}
			const result = parseBashCommand("ls -la");
			expect(result.success).toBe(true);
			expect(result.commands).toHaveLength(1);
			expect(result.commands[0]!.program).toBe("ls");
			expect(result.commands[0]!.args).toContain("-la");
		});

		it("detects pipes", () => {
			if (!isParserAvailable()) return;
			const result = parseBashCommand("cat file.txt | grep pattern");
			expect(result.success).toBe(true);
			expect(result.hasPipes).toBe(true);
			expect(result.commands.length).toBeGreaterThanOrEqual(2);
		});

		it("detects redirects", () => {
			if (!isParserAvailable()) return;
			const result = parseBashCommand("echo hello > file.txt");
			expect(result.success).toBe(true);
			expect(result.hasRedirects).toBe(true);
		});

		it("detects command substitution", () => {
			if (!isParserAvailable()) return;
			const result = parseBashCommand("echo $(whoami)");
			expect(result.success).toBe(true);
			expect(result.hasCommandSubstitution).toBe(true);
		});

		it("parses git commands", () => {
			if (!isParserAvailable()) return;
			const result = parseBashCommand("git status");
			expect(result.success).toBe(true);
			expect(result.commands[0]!.program).toBe("git");
			expect(result.commands[0]!.args).toContain("status");
		});
	});

	describe("analyzeCommandSafety", () => {
		it("marks sudo as unsafe", () => {
			if (!isParserAvailable()) return;
			const result = analyzeCommandSafety("sudo rm file.txt");
			expect(result.safe).toBe(false);
			expect(result.reason).toContain("sudo");
		});

		it("marks rm -rf as unsafe", () => {
			if (!isParserAvailable()) return;
			const result = analyzeCommandSafety("rm -rf /tmp/test");
			expect(result.safe).toBe(false);
			expect(result.reason).toContain("recursive");
		});

		it("marks rm -f as unsafe", () => {
			if (!isParserAvailable()) return;
			const result = analyzeCommandSafety("rm -f file.txt");
			expect(result.safe).toBe(false);
			expect(result.reason).toContain("force");
		});

		it("marks git reset as unsafe", () => {
			if (!isParserAvailable()) return;
			const result = analyzeCommandSafety("git reset --hard HEAD~1");
			expect(result.safe).toBe(false);
			expect(result.reason).toContain("reset");
		});

		it("marks git push as unsafe", () => {
			if (!isParserAvailable()) return;
			const result = analyzeCommandSafety("git push origin main");
			expect(result.safe).toBe(false);
			expect(result.reason).toContain("push");
		});

		it("marks command substitution as unsafe", () => {
			if (!isParserAvailable()) return;
			const result = analyzeCommandSafety("echo $(cat /etc/passwd)");
			expect(result.safe).toBe(false);
			expect(result.reason).toContain("command substitution");
		});

		it("allows safe read-only commands", () => {
			if (!isParserAvailable()) return;
			expect(analyzeCommandSafety("ls -la").safe).toBe(true);
			expect(analyzeCommandSafety("cat file.txt").safe).toBe(true);
			expect(analyzeCommandSafety("grep pattern file").safe).toBe(true);
			expect(analyzeCommandSafety("git status").safe).toBe(true);
			expect(analyzeCommandSafety("git log --oneline").safe).toBe(true);
		});

		it("allows safe pipelines", () => {
			if (!isParserAvailable()) return;
			const result = analyzeCommandSafety("cat file | grep pattern | wc -l");
			expect(result.safe).toBe(true);
		});
	});

	describe("isKnownSafeCommand", () => {
		it("returns true for read-only commands", () => {
			if (!isParserAvailable()) return;
			expect(isKnownSafeCommand("ls")).toBe(true);
			expect(isKnownSafeCommand("cat file.txt")).toBe(true);
			expect(isKnownSafeCommand("grep -r pattern .")).toBe(true);
			expect(isKnownSafeCommand("git status")).toBe(true);
			expect(isKnownSafeCommand("git diff")).toBe(true);
		});

		it("returns false for write commands", () => {
			if (!isParserAvailable()) return;
			expect(isKnownSafeCommand("rm file.txt")).toBe(false);
			expect(isKnownSafeCommand("git push")).toBe(false);
		});

		it("returns false for command substitution", () => {
			if (!isParserAvailable()) return;
			expect(isKnownSafeCommand("ls $(pwd)")).toBe(false);
		});
	});

	describe("unwrapShellCommand", () => {
		it("unwraps bash -c commands", () => {
			if (!isParserAvailable()) return;
			expect(unwrapShellCommand('bash -c "ls -la"')).toBe("ls -la");
			expect(unwrapShellCommand("bash -c 'git status'")).toBe("git status");
		});

		it("unwraps bash -lc commands", () => {
			if (!isParserAvailable()) return;
			expect(unwrapShellCommand('bash -lc "echo hello"')).toBe("echo hello");
		});

		it("unwraps sh -c commands", () => {
			if (!isParserAvailable()) return;
			expect(unwrapShellCommand('sh -c "pwd"')).toBe("pwd");
		});

		it("returns null for non-wrapper commands", () => {
			if (!isParserAvailable()) return;
			expect(unwrapShellCommand("ls -la")).toBeNull();
			expect(unwrapShellCommand("git status")).toBeNull();
		});
	});
});
