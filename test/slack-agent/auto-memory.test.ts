/**
 * Tests for the auto-memory module
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendToMemory,
	createMemoryUpdate,
	extractFacts,
	formatMemoryUpdate,
	hasSignificantFacts,
} from "../../packages/slack-agent/src/auto-memory.js";

describe("auto-memory", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(
			tmpdir(),
			`auto-memory-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	describe("extractFacts", () => {
		it("extracts files modified from write tool calls", () => {
			const toolCalls = [
				{
					name: "write",
					args: { path: "/workspace/src/index.ts", content: "..." },
					success: true,
				},
				{
					name: "write",
					args: { path: "/workspace/src/utils.ts", content: "..." },
					success: true,
				},
			];

			const facts = extractFacts(toolCalls, []);

			expect(facts.filesModified).toContain("/workspace/src/index.ts");
			expect(facts.filesModified).toContain("/workspace/src/utils.ts");
		});

		it("extracts files modified from edit tool calls", () => {
			const toolCalls = [
				{
					name: "edit",
					args: {
						path: "/workspace/config.json",
						oldText: "...",
						newText: "...",
					},
					success: true,
				},
			];

			const facts = extractFacts(toolCalls, []);

			expect(facts.filesModified).toContain("/workspace/config.json");
		});

		it("ignores failed tool calls", () => {
			const toolCalls = [
				{
					name: "write",
					args: { path: "/workspace/failed.ts", content: "..." },
					success: false,
				},
			];

			const facts = extractFacts(toolCalls, []);

			expect(facts.filesModified).not.toContain("/workspace/failed.ts");
		});

		it("extracts meaningful bash commands", () => {
			const toolCalls = [
				{
					name: "bash",
					args: { command: "npm install express" },
					success: true,
				},
				{
					name: "bash",
					args: { command: "npm test" },
					success: true,
				},
				{
					name: "bash",
					args: { command: "echo hello" }, // Should be ignored
					success: true,
				},
			];

			const facts = extractFacts(toolCalls, []);

			expect(facts.commandsRun).toContain("npm install express");
			expect(facts.commandsRun).toContain("npm test");
			expect(facts.commandsRun).not.toContain("echo hello");
		});

		it("extracts problems solved from assistant messages", () => {
			const messages = [
				{ role: "user" as const, text: "Help me fix the login bug" },
				{
					role: "assistant" as const,
					text: "I fixed the authentication error in the login handler",
				},
			];

			const facts = extractFacts([], messages);

			expect(facts.problemsSolved.length).toBeGreaterThan(0);
			expect(facts.problemsSolved[0]).toContain("authentication error");
		});

		it("extracts user preferences", () => {
			const messages = [
				{
					role: "user" as const,
					text: "I prefer using TypeScript over JavaScript",
				},
				{ role: "assistant" as const, text: "Got it!" },
			];

			const facts = extractFacts([], messages);

			expect(facts.preferences.length).toBeGreaterThan(0);
			expect(facts.preferences[0]).toContain("TypeScript");
		});

		it("extracts decisions from assistant messages", () => {
			const messages = [
				{ role: "user" as const, text: "What approach should we use?" },
				{
					role: "assistant" as const,
					text: "We'll use a middleware pattern for this",
				},
			];

			const facts = extractFacts([], messages);

			expect(facts.decisions.length).toBeGreaterThan(0);
			expect(facts.decisions[0]).toContain("middleware pattern");
		});

		it("extracts technical topics from user messages", () => {
			const messages = [
				{
					role: "user" as const,
					text: "How do I improve the API performance?",
				},
				{ role: "assistant" as const, text: "Here are some tips..." },
			];

			const facts = extractFacts([], messages);

			expect(facts.topics).toContain("api");
			expect(facts.topics).toContain("performance");
		});

		it("limits array sizes", () => {
			const toolCalls = Array.from({ length: 20 }, (_, i) => ({
				name: "write",
				args: { path: `/workspace/file${i}.ts`, content: "..." },
				success: true,
			}));

			const facts = extractFacts(toolCalls, []);

			expect(facts.filesModified.length).toBeLessThanOrEqual(10);
		});
	});

	describe("hasSignificantFacts", () => {
		it("returns false for empty facts", () => {
			const facts = {
				filesModified: [],
				commandsRun: [],
				problemsSolved: [],
				preferences: [],
				decisions: [],
				topics: [],
			};

			expect(hasSignificantFacts(facts)).toBe(false);
		});

		it("returns true when files were modified", () => {
			const facts = {
				filesModified: ["/workspace/index.ts"],
				commandsRun: [],
				problemsSolved: [],
				preferences: [],
				decisions: [],
				topics: [],
			};

			expect(hasSignificantFacts(facts)).toBe(true);
		});

		it("returns true when problems were solved", () => {
			const facts = {
				filesModified: [],
				commandsRun: [],
				problemsSolved: ["Fixed login bug"],
				preferences: [],
				decisions: [],
				topics: [],
			};

			expect(hasSignificantFacts(facts)).toBe(true);
		});

		it("returns false when only topics exist", () => {
			const facts = {
				filesModified: [],
				commandsRun: [],
				problemsSolved: [],
				preferences: [],
				decisions: [],
				topics: ["api", "performance"],
			};

			expect(hasSignificantFacts(facts)).toBe(false);
		});
	});

	describe("formatMemoryUpdate", () => {
		it("formats update with timestamp header", () => {
			const update = {
				timestamp: "2024-01-15T10:00:00Z",
				summary: "Worked on auth module",
				facts: {
					filesModified: ["/workspace/auth.ts"],
					commandsRun: [],
					problemsSolved: [],
					preferences: [],
					decisions: [],
					topics: [],
				},
			};

			const formatted = formatMemoryUpdate(update);

			expect(formatted).toContain("### 2024-01-15");
			expect(formatted).toContain("Worked on auth module");
			expect(formatted).toContain("Files modified");
			expect(formatted).toContain("auth.ts");
		});

		it("includes all fact types when present", () => {
			const update = {
				timestamp: "2024-01-15T10:00:00Z",
				summary: "",
				facts: {
					filesModified: ["file.ts"],
					commandsRun: ["npm test"],
					problemsSolved: ["Fixed bug"],
					preferences: ["Use TypeScript"],
					decisions: ["Use middleware"],
					topics: [],
				},
			};

			const formatted = formatMemoryUpdate(update);

			expect(formatted).toContain("**Files modified:**");
			expect(formatted).toContain("**Solved:**");
			expect(formatted).toContain("**Decisions:**");
			expect(formatted).toContain("**Preferences:**");
			expect(formatted).toContain("**Commands:**");
		});
	});

	describe("appendToMemory", () => {
		it("creates MEMORY.md if it doesn't exist", () => {
			const update = {
				timestamp: "2024-01-15T10:00:00Z",
				summary: "Test",
				facts: {
					filesModified: ["file.ts"],
					commandsRun: [],
					problemsSolved: [],
					preferences: [],
					decisions: [],
					topics: [],
				},
			};

			const result = appendToMemory(testDir, update);

			expect(result).toBe(true);
			const memoryPath = join(testDir, "MEMORY.md");
			expect(existsSync(memoryPath)).toBe(true);

			const content = readFileSync(memoryPath, "utf-8");
			expect(content).toContain("# Channel Memory");
			expect(content).toContain("### 2024-01-15");
		});

		it("appends to existing MEMORY.md", () => {
			const memoryPath = join(testDir, "MEMORY.md");
			const existingContent = "# Channel Memory\n\nExisting content.\n";
			const fs = require("node:fs");
			fs.writeFileSync(memoryPath, existingContent);

			const update = {
				timestamp: "2024-01-15T10:00:00Z",
				summary: "New update",
				facts: {
					filesModified: ["new.ts"],
					commandsRun: [],
					problemsSolved: [],
					preferences: [],
					decisions: [],
					topics: [],
				},
			};

			const result = appendToMemory(testDir, update);

			expect(result).toBe(true);
			const content = readFileSync(memoryPath, "utf-8");
			expect(content).toContain("Existing content");
			expect(content).toContain("### 2024-01-15");
			expect(content).toContain("new.ts");
		});

		it("skips duplicate entries for same day", () => {
			const memoryPath = join(testDir, "MEMORY.md");
			const existingContent =
				"# Channel Memory\n\n### 2024-01-15\n\nAlready exists.\n";
			const fs = require("node:fs");
			fs.writeFileSync(memoryPath, existingContent);

			const update = {
				timestamp: "2024-01-15T10:00:00Z",
				summary: "Duplicate",
				facts: {
					filesModified: ["file.ts"],
					commandsRun: [],
					problemsSolved: [],
					preferences: [],
					decisions: [],
					topics: [],
				},
			};

			const result = appendToMemory(testDir, update);

			expect(result).toBe(false);
		});

		it("returns false for insignificant facts", () => {
			const update = {
				timestamp: "2024-01-15T10:00:00Z",
				summary: "Nothing happened",
				facts: {
					filesModified: [],
					commandsRun: [],
					problemsSolved: [],
					preferences: [],
					decisions: [],
					topics: ["api"], // Only topics, not significant
				},
			};

			const result = appendToMemory(testDir, update);

			expect(result).toBe(false);
		});
	});

	describe("createMemoryUpdate", () => {
		it("creates update with summary from problems solved", () => {
			const toolCalls = [
				{ name: "edit", args: { path: "/file.ts" }, success: true },
			];
			const messages = [
				{ role: "user" as const, text: "Fix the bug" },
				{
					role: "assistant" as const,
					text: "I fixed the authentication issue",
				},
			];

			const update = createMemoryUpdate(toolCalls, messages);

			expect(update.timestamp).toBeDefined();
			expect(update.summary).toContain("Fixed");
		});

		it("creates update with summary from files modified", () => {
			const toolCalls = [
				{ name: "write", args: { path: "/a.ts" }, success: true },
				{ name: "write", args: { path: "/b.ts" }, success: true },
				{ name: "write", args: { path: "/c.ts" }, success: true },
			];
			const messages: Array<{ role: "user" | "assistant"; text: string }> = [];

			const update = createMemoryUpdate(toolCalls, messages);

			expect(update.summary).toContain("3 file(s)");
		});

		it("creates update with summary from topics", () => {
			const toolCalls: Array<{
				name: string;
				args: Record<string, unknown>;
				success: boolean;
			}> = [];
			const messages = [
				{
					role: "user" as const,
					text: "How does the API authentication work?",
				},
				{ role: "assistant" as const, text: "Let me explain..." },
			];

			const update = createMemoryUpdate(toolCalls, messages);

			expect(update.summary).toContain("Discussed");
		});
	});
});
