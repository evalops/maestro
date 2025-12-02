import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { backgroundTaskManager } from "../../src/tools/background-tasks.js";
import {
	parseBackgroundPrefixCommand,
	startBackgroundTask,
	stripBackgroundSuffix,
} from "../../src/tui/bash/background-launcher.js";
import { BashAutocompleteProvider } from "../../src/tui/bash/bash-autocomplete.js";
import {
	appendToHistory,
	getHistoryFilePath,
	loadBashHistory,
	saveBashHistory,
} from "../../src/tui/bash/bash-history.js";
import { highlightBashCommand } from "../../src/tui/bash/bash-syntax.js";
import { runStreamingShellCommand } from "../../src/tui/run/streaming-shell-command.js";

// =============================================================================
// BASH HISTORY TESTS
// =============================================================================

describe("bash-history", () => {
	let tempDir: string;
	let originalEnv: string | undefined;

	beforeEach(() => {
		// Create a unique temp directory for each test
		tempDir = mkdtempSync(join(tmpdir(), "composer-bash-history-"));
		originalEnv = process.env.COMPOSER_BASH_HISTORY;
		// Set a unique history file for this test
		process.env.COMPOSER_BASH_HISTORY = join(
			tempDir,
			`history-${Date.now()}.json`,
		);
	});

	afterEach(() => {
		// Restore original env
		if (originalEnv !== undefined) {
			process.env.COMPOSER_BASH_HISTORY = originalEnv;
		} else {
			// biome-ignore lint/performance/noDelete: Required for proper env var cleanup
			delete process.env.COMPOSER_BASH_HISTORY;
		}
		// Clean up temp directory
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe("getHistoryFilePath", () => {
		it("returns env var path when set", () => {
			const customPath = "/custom/path/history.json";
			process.env.COMPOSER_BASH_HISTORY = customPath;
			expect(getHistoryFilePath()).toBe(customPath);
		});

		it("returns default path when env var not set", () => {
			// biome-ignore lint/performance/noDelete: Required for proper env var cleanup
			delete process.env.COMPOSER_BASH_HISTORY;
			const path = getHistoryFilePath();
			expect(path).toContain(".composer");
			expect(path).toContain("bash-history.json");
		});
	});

	describe("loadBashHistory", () => {
		it("returns empty array when no history file exists", () => {
			const historyFile = getHistoryFilePath();
			expect(existsSync(historyFile)).toBe(false);
			const history = loadBashHistory();
			expect(history).toEqual([]);
		});

		it("returns empty array for invalid JSON", () => {
			const historyFile = getHistoryFilePath();
			mkdirSync(tempDir, { recursive: true });
			writeFileSync(historyFile, "not valid json", "utf-8");
			const history = loadBashHistory();
			expect(history).toEqual([]);
		});

		it("returns empty array when entries is not an array", () => {
			const historyFile = getHistoryFilePath();
			mkdirSync(tempDir, { recursive: true });
			writeFileSync(
				historyFile,
				JSON.stringify({ entries: "not an array", version: 1 }),
				"utf-8",
			);
			const history = loadBashHistory();
			expect(history).toEqual([]);
		});

		it("loads valid history entries", () => {
			const historyFile = getHistoryFilePath();
			const entries = ["echo hello", "ls -la", "npm test"];
			mkdirSync(tempDir, { recursive: true });
			writeFileSync(
				historyFile,
				JSON.stringify({ entries, version: 1 }),
				"utf-8",
			);
			const history = loadBashHistory();
			expect(history).toEqual(entries);
		});

		it("truncates history to max size on load", () => {
			const historyFile = getHistoryFilePath();
			const entries = Array.from({ length: 600 }, (_, i) => `cmd ${i}`);
			mkdirSync(tempDir, { recursive: true });
			writeFileSync(
				historyFile,
				JSON.stringify({ entries, version: 1 }),
				"utf-8",
			);
			const history = loadBashHistory();
			expect(history.length).toBe(500);
			expect(history[0]).toBe("cmd 100"); // First 100 should be dropped
			expect(history[499]).toBe("cmd 599");
		});
	});

	describe("saveBashHistory", () => {
		it("creates directory if it does not exist", () => {
			const nestedPath = join(tempDir, "nested", "dir", "history.json");
			process.env.COMPOSER_BASH_HISTORY = nestedPath;
			saveBashHistory(["test command"]);
			expect(existsSync(nestedPath)).toBe(true);
		});

		it("saves history with correct format", () => {
			const historyFile = getHistoryFilePath();
			const entries = ["echo hello", "ls -la"];
			saveBashHistory(entries);

			const raw = readFileSync(historyFile, "utf-8");
			const data = JSON.parse(raw);
			expect(data.entries).toEqual(entries);
			expect(data.version).toBe(1);
		});

		it("truncates history to max size on save", () => {
			const historyFile = getHistoryFilePath();
			const entries = Array.from({ length: 600 }, (_, i) => `cmd ${i}`);
			saveBashHistory(entries);

			const raw = readFileSync(historyFile, "utf-8");
			const data = JSON.parse(raw);
			expect(data.entries.length).toBe(500);
			expect(data.entries[499]).toBe("cmd 599");
		});
	});

	describe("appendToHistory", () => {
		it("appends command to history", () => {
			let history: string[] = [];
			history = appendToHistory(history, "first command");
			expect(history).toEqual(["first command"]);
		});

		it("persists appended commands to disk", () => {
			let history: string[] = [];
			history = appendToHistory(history, "test command");

			const loaded = loadBashHistory();
			expect(loaded).toEqual(["test command"]);
		});

		it("avoids consecutive duplicates", () => {
			let history: string[] = [];
			history = appendToHistory(history, "echo hello");
			history = appendToHistory(history, "echo hello");
			history = appendToHistory(history, "echo world");
			history = appendToHistory(history, "echo hello");

			expect(history).toEqual(["echo hello", "echo world", "echo hello"]);
		});

		it("trims whitespace from commands", () => {
			let history: string[] = [];
			history = appendToHistory(history, "  trimmed  ");
			expect(history).toEqual(["trimmed"]);
		});

		it("ignores empty commands", () => {
			let history: string[] = [];
			history = appendToHistory(history, "");
			history = appendToHistory(history, "   ");
			history = appendToHistory(history, "\t\n");

			expect(history).toEqual([]);
		});

		it("enforces max history size", () => {
			let history = Array.from({ length: 500 }, (_, i) => `cmd ${i}`);
			history = appendToHistory(history, "new command");

			expect(history.length).toBe(500);
			expect(history[0]).toBe("cmd 1"); // cmd 0 should be dropped
			expect(history[499]).toBe("new command");
		});
	});
});

// =============================================================================
// BASH SYNTAX HIGHLIGHTING TESTS
// =============================================================================

describe("bash-syntax highlighting", () => {
	it("preserves command text", () => {
		const result = highlightBashCommand("echo hello");
		expect(result).toContain("echo");
		expect(result).toContain("hello");
	});

	it("handles flags", () => {
		const result = highlightBashCommand("ls -la --color");
		expect(result).toContain("-la");
		expect(result).toContain("--color");
	});

	it("handles double-quoted strings", () => {
		const result = highlightBashCommand('echo "hello world"');
		expect(result).toContain('"hello world"');
	});

	it("handles single-quoted strings", () => {
		const result = highlightBashCommand("echo 'hello world'");
		expect(result).toContain("'hello world'");
	});

	it("handles escaped characters in strings", () => {
		const result = highlightBashCommand('echo "hello\\"world"');
		expect(result).toContain('\\"');
	});

	it("handles variables", () => {
		const result = highlightBashCommand("echo $HOME");
		expect(result).toContain("$HOME");
	});

	it("handles braced variables", () => {
		const result = highlightBashCommand("echo ${HOME}");
		expect(result).toContain("${HOME}");
	});

	it("handles pipe operator", () => {
		const result = highlightBashCommand("cat file.txt | grep pattern");
		expect(result).toContain("|");
	});

	it("handles && operator", () => {
		const result = highlightBashCommand("make && make install");
		expect(result).toContain("&&");
	});

	it("handles || operator", () => {
		const result = highlightBashCommand("test -f file || echo missing");
		expect(result).toContain("||");
	});

	it("handles redirect operators", () => {
		const result = highlightBashCommand("echo hello > file.txt");
		expect(result).toContain(">");
	});

	it("handles complex commands", () => {
		const result = highlightBashCommand(
			'git commit -m "feat: add feature" && npm test',
		);
		expect(result).toContain("git");
		expect(result).toContain("commit");
		expect(result).toContain("-m");
		expect(result).toContain("&&");
		expect(result).toContain("npm");
	});

	it("handles paths", () => {
		const result = highlightBashCommand("cat /path/to/file.txt");
		expect(result).toContain("/path/to/file.txt");
	});

	it("handles empty input", () => {
		const result = highlightBashCommand("");
		expect(result).toBe("");
	});

	it("handles whitespace-only input", () => {
		const result = highlightBashCommand("   ");
		expect(result.trim()).toBe("");
	});
});

// =============================================================================
// BASH AUTOCOMPLETE PROVIDER TESTS
// =============================================================================

describe("BashAutocompleteProvider", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "composer-bash-autocomplete-"));
		// Create test files
		writeFileSync(
			join(tempDir, "package.json"),
			JSON.stringify({
				scripts: {
					test: "vitest",
					build: "tsc",
					dev: "vite",
					"test:watch": "vitest --watch",
				},
			}),
		);
		writeFileSync(join(tempDir, "README.md"), "# Test");
		mkdirSync(join(tempDir, "src"));
		writeFileSync(join(tempDir, "src", "index.ts"), "export {}");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe("git subcommand completion", () => {
		it("completes git subcommands", () => {
			const provider = new BashAutocompleteProvider(tempDir);
			const result = provider.getSuggestions(["git ch"], 0, 6);

			expect(result).not.toBeNull();
			expect(result?.items.some((item) => item.value === "checkout")).toBe(
				true,
			);
		});

		it("filters git subcommands by prefix", () => {
			const provider = new BashAutocompleteProvider(tempDir);
			const result = provider.getSuggestions(["git st"], 0, 6);

			expect(result).not.toBeNull();
			expect(result?.items.some((item) => item.value === "status")).toBe(true);
			expect(result?.items.some((item) => item.value === "stash")).toBe(true);
			expect(result?.items.some((item) => item.value === "checkout")).toBe(
				false,
			);
		});

		it("returns empty for non-matching prefix", () => {
			const provider = new BashAutocompleteProvider(tempDir);
			const result = provider.getSuggestions(["git xyz"], 0, 7);

			expect(result).toBeNull();
		});
	});

	describe("npm/bun script completion", () => {
		it("completes npm run scripts", () => {
			const provider = new BashAutocompleteProvider(tempDir);
			const result = provider.getSuggestions(["npm run t"], 0, 9);

			expect(result).not.toBeNull();
			expect(result?.items.some((item) => item.value === "test")).toBe(true);
			expect(result?.items.some((item) => item.value === "test:watch")).toBe(
				true,
			);
		});

		it("completes bun run scripts", () => {
			const provider = new BashAutocompleteProvider(tempDir);
			const result = provider.getSuggestions(["bun run b"], 0, 9);

			expect(result).not.toBeNull();
			expect(result?.items.some((item) => item.value === "build")).toBe(true);
		});

		it("returns empty when no package.json exists", () => {
			rmSync(join(tempDir, "package.json"));
			const provider = new BashAutocompleteProvider(tempDir);
			const result = provider.getSuggestions(["npm run t"], 0, 9);

			expect(result).toBeNull();
		});

		it("caches npm scripts", () => {
			const provider = new BashAutocompleteProvider(tempDir);

			// First call
			const result1 = provider.getSuggestions(["npm run t"], 0, 9);
			expect(result1).not.toBeNull();

			// Modify package.json
			writeFileSync(
				join(tempDir, "package.json"),
				JSON.stringify({ scripts: { newscript: "echo" } }),
			);

			// Second call should use cache
			const result2 = provider.getSuggestions(["npm run t"], 0, 9);
			expect(result2).not.toBeNull();
			expect(result2?.items.some((item) => item.value === "test")).toBe(true);
		});

		it("invalidates cache on setBasePath", () => {
			const provider = new BashAutocompleteProvider(tempDir);

			// First call
			provider.getSuggestions(["npm run t"], 0, 9);

			// Create new directory with different package.json
			const newDir = mkdtempSync(join(tmpdir(), "composer-bash-new-"));
			writeFileSync(
				join(newDir, "package.json"),
				JSON.stringify({ scripts: { different: "echo" } }),
			);

			provider.setBasePath(newDir);
			const result = provider.getSuggestions(["npm run d"], 0, 9);

			expect(result).not.toBeNull();
			expect(result?.items.some((item) => item.value === "different")).toBe(
				true,
			);

			rmSync(newDir, { recursive: true, force: true });
		});
	});

	describe("command completion", () => {
		it("completes shell builtins", () => {
			const provider = new BashAutocompleteProvider(tempDir);
			const result = provider.getSuggestions(["ec"], 0, 2);

			expect(result).not.toBeNull();
			expect(result?.items.some((item) => item.value === "echo")).toBe(true);
		});

		it("includes cd builtin", () => {
			const provider = new BashAutocompleteProvider(tempDir);
			const result = provider.getSuggestions(["c"], 0, 1);

			expect(result).not.toBeNull();
			expect(result?.items.some((item) => item.value === "cd")).toBe(true);
		});
	});

	describe("history-based completion", () => {
		it("includes history matches", () => {
			const history = ["npm run test", "npm run build", "git status"];
			const provider = new BashAutocompleteProvider(tempDir, history);
			const result = provider.getSuggestions(["npm"], 0, 3);

			expect(result).not.toBeNull();
			expect(result?.items.some((item) => item.description === "history")).toBe(
				true,
			);
		});

		it("fuzzy matches history", () => {
			const history = ["docker-compose up", "docker build ."];
			const provider = new BashAutocompleteProvider(tempDir, history);
			const result = provider.getSuggestions(["dock"], 0, 4);

			expect(result).not.toBeNull();
			const historyItems = result?.items.filter(
				(item) => item.description === "history",
			);
			expect(historyItems?.length).toBeGreaterThan(0);
		});

		it("updates history via setHistory", () => {
			const provider = new BashAutocompleteProvider(tempDir, []);
			provider.setHistory(["custom command here"]);

			const result = provider.getSuggestions(["custom"], 0, 6);
			expect(result).not.toBeNull();
			expect(
				result?.items.some((item) => item.value === "custom command here"),
			).toBe(true);
		});

		it("returns recent history when prefix is empty", () => {
			const history = ["cmd1", "cmd2", "cmd3", "cmd4", "cmd5", "cmd6"];
			const provider = new BashAutocompleteProvider(tempDir, history);
			// Empty prefix should return last 5 commands reversed
			const result = provider.getSuggestions([""], 0, 0);

			expect(result).not.toBeNull();
		});
	});

	describe("file path completion", () => {
		it("completes files in current directory", () => {
			const provider = new BashAutocompleteProvider(tempDir);
			const result = provider.getSuggestions(["cat ./"], 0, 6);

			expect(result).not.toBeNull();
			expect(result?.items.some((item) => item.label === "package.json")).toBe(
				true,
			);
		});

		it("completes directories with trailing slash", () => {
			const provider = new BashAutocompleteProvider(tempDir);
			const result = provider.getSuggestions(["cd ./"], 0, 5);

			expect(result).not.toBeNull();
			const srcItem = result?.items.find((item) => item.label === "src");
			expect(srcItem).toBeDefined();
			expect(srcItem?.value).toMatch(/\/$/); // Should end with /
		});

		it("completes files in subdirectory", () => {
			const provider = new BashAutocompleteProvider(tempDir);
			const result = provider.getSuggestions(["cat ./src/"], 0, 10);

			expect(result).not.toBeNull();
			expect(result?.items.some((item) => item.label === "index.ts")).toBe(
				true,
			);
		});

		it("filters by prefix", () => {
			const provider = new BashAutocompleteProvider(tempDir);
			const result = provider.getSuggestions(["cat ./pack"], 0, 10);

			expect(result).not.toBeNull();
			expect(result?.items.some((item) => item.label === "package.json")).toBe(
				true,
			);
			expect(result?.items.some((item) => item.label === "README.md")).toBe(
				false,
			);
		});

		it("expands ~ to home directory", () => {
			const provider = new BashAutocompleteProvider(tempDir);
			// This test depends on HOME being set and accessible
			const home = process.env.HOME;
			if (home && existsSync(home)) {
				const result = provider.getSuggestions(["cat ~/"], 0, 6);
				expect(result).not.toBeNull();
			}
		});

		it("returns empty for non-existent directory", () => {
			const provider = new BashAutocompleteProvider(tempDir);
			const result = provider.getSuggestions(["cat ./nonexistent/"], 0, 18);

			expect(result).toBeNull();
		});

		it("sorts directories before files", () => {
			const provider = new BashAutocompleteProvider(tempDir);
			const result = provider.getSuggestions(["ls ./"], 0, 5);

			expect(result).not.toBeNull();
			const items = result?.items || [];
			const srcIdx = items.findIndex((item) => item.label === "src");
			const readmeIdx = items.findIndex((item) => item.label === "README.md");
			expect(srcIdx).toBeLessThan(readmeIdx);
		});
	});

	describe("applyCompletion", () => {
		it("applies command completion with trailing space", () => {
			const provider = new BashAutocompleteProvider(tempDir);
			const result = provider.applyCompletion(
				["git ch"],
				0,
				6,
				{ value: "checkout", label: "checkout", description: "git" },
				"ch",
			);

			expect(result.lines[0]).toBe("git checkout ");
			expect(result.cursorCol).toBe(13); // "git checkout " length
		});

		it("applies directory completion without trailing space", () => {
			const provider = new BashAutocompleteProvider(tempDir);
			const result = provider.applyCompletion(
				["cd ./s"],
				0,
				6,
				{ value: "./src/", label: "src", description: "directory" },
				"./s",
			);

			expect(result.lines[0]).toBe("cd ./src/");
			expect(result.cursorCol).toBe(9);
		});

		it("preserves text after cursor", () => {
			const provider = new BashAutocompleteProvider(tempDir);
			const result = provider.applyCompletion(
				["echo he world"],
				0,
				7,
				{ value: "hello", label: "hello", description: "history" },
				"he",
			);

			expect(result.lines[0]).toBe("echo hello  world");
		});
	});
});

// =============================================================================
// STREAMING SHELL COMMAND TESTS
// =============================================================================

describe("runStreamingShellCommand", () => {
	it("executes simple commands", async () => {
		const result = await runStreamingShellCommand("echo hello");

		expect(result.success).toBe(true);
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("hello");
	});

	it("captures stderr", async () => {
		const result = await runStreamingShellCommand("echo error >&2");

		expect(result.stderr).toBe("error");
	});

	it("captures both stdout and stderr", async () => {
		const result = await runStreamingShellCommand("echo out; echo err >&2");

		expect(result.stdout).toBe("out");
		expect(result.stderr).toBe("err");
	});

	it("streams stdout via callback", async () => {
		const chunks: string[] = [];
		const result = await runStreamingShellCommand(
			"echo one; sleep 0.1; echo two",
			{
				onStdout: (chunk) => chunks.push(chunk),
			},
		);

		expect(result.success).toBe(true);
		expect(chunks.length).toBeGreaterThan(0);
		expect(chunks.join("")).toContain("one");
		expect(chunks.join("")).toContain("two");
	});

	it("streams stderr via callback", async () => {
		const chunks: string[] = [];
		const result = await runStreamingShellCommand("echo err >&2", {
			onStderr: (chunk) => chunks.push(chunk),
		});

		expect(chunks.join("")).toContain("err");
	});

	it("respects cwd option", async () => {
		const result = await runStreamingShellCommand("pwd", {
			cwd: "/tmp",
		});

		expect(result.stdout).toMatch(/^\/tmp|^\/private\/tmp/);
	});

	it("respects env option", async () => {
		const result = await runStreamingShellCommand("echo $TEST_VAR", {
			env: { ...process.env, TEST_VAR: "custom_value" },
		});

		expect(result.stdout).toBe("custom_value");
	});

	it("reports non-zero exit codes", async () => {
		const result = await runStreamingShellCommand("exit 42");

		expect(result.success).toBe(false);
		expect(result.code).toBe(42);
	});

	it("can be aborted via signal", async () => {
		const controller = new AbortController();

		const promise = runStreamingShellCommand("sleep 10", {
			signal: controller.signal,
		});

		// Abort after a short delay
		setTimeout(() => controller.abort(), 50);

		const result = await promise;
		expect(result.success).toBe(false);
		expect(result.stderr).toContain("aborted");
	});

	it("handles already aborted signal", async () => {
		const controller = new AbortController();
		controller.abort();

		const result = await runStreamingShellCommand("echo should not run", {
			signal: controller.signal,
		});

		expect(result.success).toBe(false);
	});

	it("handles command errors gracefully", async () => {
		const result = await runStreamingShellCommand("nonexistent_command_xyz");

		expect(result.success).toBe(false);
		expect(result.code).not.toBe(0);
	});

	it("trims trailing whitespace from output", async () => {
		const result = await runStreamingShellCommand("echo -e 'hello\\n\\n'");

		expect(result.stdout).toBe("hello");
	});

	it("handles multi-line output", async () => {
		const result = await runStreamingShellCommand(
			"echo -e 'line1\\nline2\\nline3'",
		);

		expect(result.stdout).toBe("line1\nline2\nline3");
	});
});

// =============================================================================
// BASH SHELL BLOCK TESTS
// =============================================================================

describe("BashShellBlock", () => {
	it("creates block with title and initial body", async () => {
		const { BashShellBlock } = await import(
			"../../src/tui/bash-shell-block.js"
		);

		const block = new BashShellBlock("test-path", "initial body");
		expect(block).toBeDefined();
	});

	it("supports status changes", async () => {
		const { BashShellBlock } = await import(
			"../../src/tui/bash-shell-block.js"
		);

		const block = new BashShellBlock("path", "body");
		// Should not throw
		block.setStatus("pending");
		block.setStatus("success");
		block.setStatus("error");
	});

	it("supports body updates", async () => {
		const { BashShellBlock } = await import(
			"../../src/tui/bash-shell-block.js"
		);

		const block = new BashShellBlock("path", "initial");
		block.setBody("updated body");
	});

	it("supports prompt line", async () => {
		const { BashShellBlock } = await import(
			"../../src/tui/bash-shell-block.js"
		);

		const block = new BashShellBlock("path", "body");
		block.setPromptLine("$ command");
	});

	it("supports streaming output", async () => {
		const { BashShellBlock } = await import(
			"../../src/tui/bash-shell-block.js"
		);

		const block = new BashShellBlock("path", "body");
		block.setPromptLine("$ command");
		block.appendStreamOutput("chunk1");
		block.appendStreamOutput("chunk2");
		block.clearStreamBuffer();
	});

	it("tracks elapsed time", async () => {
		const { BashShellBlock } = await import(
			"../../src/tui/bash-shell-block.js"
		);

		const block = new BashShellBlock("path", "body");
		const elapsed1 = block.getElapsedMs();
		expect(elapsed1).toBeGreaterThanOrEqual(0);

		// Wait a bit
		await new Promise((resolve) => setTimeout(resolve, 10));

		const elapsed2 = block.getElapsedMs();
		expect(elapsed2).toBeGreaterThan(elapsed1);
	});
});

describe("background launcher", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("parseBackgroundPrefixCommand", () => {
		it("parses !& commands", () => {
			expect(parseBackgroundPrefixCommand("!& npm run dev")).toBe(
				"npm run dev",
			);
		});

		it("returns null for invalid inputs", () => {
			expect(parseBackgroundPrefixCommand("!&   ")).toBeNull();
			expect(parseBackgroundPrefixCommand("! npm run dev")).toBeNull();
		});
	});

	describe("stripBackgroundSuffix", () => {
		it("removes trailing ampersand", () => {
			expect(stripBackgroundSuffix("npm run dev &")).toBe("npm run dev");
			expect(stripBackgroundSuffix("npm run dev&")).toBe("npm run dev");
		});

		it("ignores logical operators and escaped ampersands", () => {
			expect(stripBackgroundSuffix("npm run dev && echo done")).toBeNull();
			expect(stripBackgroundSuffix("npm run dev \\&")).toBeNull();
		});
	});

	describe("startBackgroundTask", () => {
		it("starts tasks with provided options", () => {
			const spy = vi
				.spyOn(backgroundTaskManager, "start")
				.mockReturnValue({ id: "task-42", command: "npm run dev" } as any);
			const result = startBackgroundTask("npm run dev", {
				cwd: "/tmp/project",
				env: { NODE_ENV: "test" },
			});
			expect(spy).toHaveBeenCalledWith("npm run dev", {
				cwd: "/tmp/project",
				env: { NODE_ENV: "test" },
				useShell: true,
			});
			expect(result).toEqual({ id: "task-42", command: "npm run dev" });
		});

		it("throws when command is empty", () => {
			expect(() =>
				startBackgroundTask("   ", {
					cwd: "/tmp/project",
				}),
			).toThrow(/cannot be empty/i);
		});
	});
});
