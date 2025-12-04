import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	expandHomeDir,
	matchesModelPattern,
	matchesPathPattern,
	resolveRealPath,
} from "../../src/utils/path-matcher.js";

describe("expandHomeDir", () => {
	it("expands standalone ~", () => {
		const result = expandHomeDir("~");
		expect(result).toBe(homedir());
	});

	it("expands ~/path", () => {
		const result = expandHomeDir("~/projects");
		expect(result).toBe(join(homedir(), "projects"));
	});

	it("expands ~/nested/path", () => {
		const result = expandHomeDir("~/projects/myapp");
		expect(result).toBe(join(homedir(), "projects", "myapp"));
	});

	it("does not expand absolute paths", () => {
		const result = expandHomeDir("/home/user/projects");
		expect(result).toBe("/home/user/projects");
	});

	it("does not expand relative paths without ~", () => {
		const result = expandHomeDir("./projects");
		expect(result).toBe("./projects");
	});

	it("does not expand paths with ~ in the middle", () => {
		const result = expandHomeDir("/home/~user/projects");
		expect(result).toBe("/home/~user/projects");
	});

	it("handles empty string", () => {
		const result = expandHomeDir("");
		expect(result).toBe("");
	});
});

describe("resolveRealPath", () => {
	it("resolves absolute paths", () => {
		const result = resolveRealPath("/tmp");
		// Should return the path (possibly resolved if symlinked)
		expect(result).toBeTruthy();
		expect(result.startsWith("/")).toBe(true);
	});

	it("expands ~ before resolving", () => {
		const result = resolveRealPath("~");
		expect(result).toBe(homedir());
	});

	it("handles non-existent paths by resolving parent", () => {
		const result = resolveRealPath("/tmp/nonexistent-file-abc123");
		expect(result).toBe("/tmp/nonexistent-file-abc123");
	});

	it("returns resolved path for deeply nested non-existent paths", () => {
		const result = resolveRealPath("/tmp/a/b/c/d/e/f");
		expect(result.startsWith("/")).toBe(true);
	});
});

describe("matchesPathPattern", () => {
	const cwd = process.cwd();

	describe("glob patterns", () => {
		it("matches single wildcard", () => {
			expect(
				matchesPathPattern("/home/user/file.txt", ["/home/user/*.txt"]),
			).toBe(true);
		});

		it("matches double wildcard for nested paths", () => {
			expect(
				matchesPathPattern("/home/user/projects/sub/file.txt", [
					"/home/user/**/*.txt",
				]),
			).toBe(true);
		});

		it("does not match with matchBase disabled", () => {
			// Pattern "*.txt" should NOT match "/home/user/file.txt"
			// because matchBase is disabled
			expect(matchesPathPattern("/home/user/file.txt", ["*.txt"])).toBe(false);
		});

		it("matches question mark wildcard", () => {
			expect(
				matchesPathPattern("/home/user/file1.txt", ["/home/user/file?.txt"]),
			).toBe(true);
		});

		it("does not match when pattern does not match", () => {
			expect(
				matchesPathPattern("/home/user/file.js", ["/home/user/*.txt"]),
			).toBe(false);
		});
	});

	describe("directory patterns", () => {
		it("matches file in directory", () => {
			expect(matchesPathPattern("/home/user/file.txt", ["/home/user"])).toBe(
				true,
			);
		});

		it("matches file in nested directory", () => {
			expect(
				matchesPathPattern("/home/user/projects/file.txt", ["/home/user"]),
			).toBe(true);
		});

		it("matches exact directory path", () => {
			expect(matchesPathPattern("/home/user", ["/home/user"])).toBe(true);
		});

		it("does not match sibling directories", () => {
			expect(matchesPathPattern("/home/other/file.txt", ["/home/user"])).toBe(
				false,
			);
		});

		it("does not match parent directory", () => {
			expect(matchesPathPattern("/home", ["/home/user"])).toBe(false);
		});
	});

	describe("home directory expansion", () => {
		it("expands ~ in file path", () => {
			const home = homedir();
			expect(
				matchesPathPattern("~/projects/file.txt", [`${home}/projects`]),
			).toBe(true);
		});

		it("expands ~ in pattern", () => {
			const home = homedir();
			expect(
				matchesPathPattern(`${home}/projects/file.txt`, ["~/projects"]),
			).toBe(true);
		});
	});

	describe("multiple patterns", () => {
		it("matches if any pattern matches", () => {
			expect(
				matchesPathPattern("/home/user/file.txt", [
					"/home/other",
					"/home/user",
					"/home/admin",
				]),
			).toBe(true);
		});

		it("does not match if no patterns match", () => {
			expect(
				matchesPathPattern("/home/user/file.txt", [
					"/home/other",
					"/home/admin",
				]),
			).toBe(false);
		});
	});

	describe("relative pattern resolution", () => {
		it("resolves relative non-glob patterns to CWD", () => {
			const relativePath = "src/file.txt";
			const absolutePath = resolve(cwd, relativePath);
			expect(matchesPathPattern(absolutePath, ["src"])).toBe(true);
		});

		it("does not resolve glob patterns to CWD", () => {
			// Glob patterns should be used as-is, not resolved to CWD
			expect(matchesPathPattern("/absolute/path/file.txt", ["**/*.txt"])).toBe(
				true,
			);
		});
	});

	describe("empty patterns", () => {
		it("returns false for empty pattern array", () => {
			expect(matchesPathPattern("/home/user/file.txt", [])).toBe(false);
		});
	});

	describe("dot files", () => {
		it("matches dot files with explicit pattern", () => {
			expect(
				matchesPathPattern("/home/user/.gitignore", ["/home/user/.*"]),
			).toBe(true);
		});

		it("matches dot files with ** pattern", () => {
			expect(
				matchesPathPattern("/home/user/.config/file", ["/home/user/**"]),
			).toBe(true);
		});
	});
});

describe("matchesModelPattern", () => {
	describe("exact matching", () => {
		it("matches exact model ID", () => {
			expect(matchesModelPattern("gpt-4", ["gpt-4"])).toBe(true);
		});

		it("does not match different model ID", () => {
			expect(matchesModelPattern("gpt-4", ["gpt-3.5"])).toBe(false);
		});
	});

	describe("wildcard patterns", () => {
		it("matches with prefix wildcard", () => {
			expect(matchesModelPattern("anthropic/claude-3", ["anthropic/*"])).toBe(
				true,
			);
		});

		it("matches with suffix wildcard", () => {
			expect(matchesModelPattern("gpt-4-turbo", ["gpt-*"])).toBe(true);
		});

		it("matches with middle wildcard", () => {
			expect(matchesModelPattern("claude-3-opus", ["claude-*-opus"])).toBe(
				true,
			);
		});

		it("does not match when wildcard pattern does not apply", () => {
			expect(matchesModelPattern("openai/gpt-4", ["anthropic/*"])).toBe(false);
		});
	});

	describe("case insensitivity", () => {
		it("matches case-insensitively", () => {
			expect(matchesModelPattern("GPT-4", ["gpt-4"])).toBe(true);
		});

		it("matches case-insensitively with wildcards", () => {
			expect(matchesModelPattern("GPT-4-TURBO", ["gpt-*"])).toBe(true);
		});
	});

	describe("multiple patterns", () => {
		it("matches if any pattern matches", () => {
			expect(
				matchesModelPattern("claude-3", ["gpt-*", "claude-*", "gemini-*"]),
			).toBe(true);
		});

		it("does not match if no patterns match", () => {
			expect(matchesModelPattern("llama-2", ["gpt-*", "claude-*"])).toBe(false);
		});
	});

	describe("empty patterns", () => {
		it("returns false for empty pattern array", () => {
			expect(matchesModelPattern("gpt-4", [])).toBe(false);
		});
	});

	describe("special characters", () => {
		it("matches patterns with dots", () => {
			expect(matchesModelPattern("gpt-3.5-turbo", ["gpt-3.5-*"])).toBe(true);
		});

		it("matches patterns with slashes", () => {
			expect(matchesModelPattern("anthropic/claude-3", ["*/claude-*"])).toBe(
				true,
			);
		});
	});
});
