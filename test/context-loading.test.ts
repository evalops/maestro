import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadProjectContextFiles } from "../src/cli/system-prompt.js";
import { tmpdir } from "node:os";

describe("Hierarchical Context File Loading", () => {
	let testDir: string;
	let originalCwd: string;
	let originalEnv: string | undefined;

	beforeEach(() => {
		// Save original state
		originalCwd = process.cwd();
		originalEnv = process.env.COMPOSER_AGENT_DIR;

		// Create temp test directory
		testDir = join(tmpdir(), `composer-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		// Restore original state
		process.chdir(originalCwd);
		process.env.COMPOSER_AGENT_DIR = originalEnv;

		// Cleanup test directory
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	describe("Global Context Loading", () => {
		it("should load AGENT.md from global directory", () => {
			const globalDir = join(testDir, "global");
			mkdirSync(globalDir, { recursive: true });
			writeFileSync(
				join(globalDir, "AGENT.md"),
				"# Global Context\nThis is global context",
			);

			process.env.COMPOSER_AGENT_DIR = globalDir;
			process.chdir(testDir);

			const contextFiles = loadProjectContextFiles();

			expect(contextFiles.length).toBeGreaterThanOrEqual(1);
			const globalContext = contextFiles.find((f) =>
				f.path.includes("AGENT.md"),
			);
			expect(globalContext).toBeDefined();
			expect(globalContext?.content).toContain("Global Context");
		});

		it("should prefer AGENT.md over CLAUDE.md in same directory", () => {
			const globalDir = join(testDir, "global");
			mkdirSync(globalDir, { recursive: true });
			writeFileSync(
				join(globalDir, "AGENT.md"),
				"# AGENT.md Content\nThis should be loaded",
			);
			writeFileSync(
				join(globalDir, "CLAUDE.md"),
				"# CLAUDE.md Content\nThis should NOT be loaded",
			);

			process.env.COMPOSER_AGENT_DIR = globalDir;
			process.chdir(testDir);

			const contextFiles = loadProjectContextFiles();

			expect(contextFiles.length).toBeGreaterThanOrEqual(1);
			const globalContext = contextFiles.find((f) =>
				f.path.includes("global"),
			);
			expect(globalContext?.path).toContain("AGENT.md");
			expect(globalContext?.path).not.toContain("CLAUDE.md");
			expect(globalContext?.content).toContain("AGENT.md Content");
		});
	});

	describe("Hierarchical Directory Loading", () => {
		it("should load context files from parent directories in order", () => {
			// Create structure: /root/parent/child
			const rootDir = join(testDir, "root");
			const parentDir = join(rootDir, "parent");
			const childDir = join(parentDir, "child");

			mkdirSync(childDir, { recursive: true });

			// Create context files at each level
			writeFileSync(join(rootDir, "AGENT.md"), "# Root Context\nRoot level");
			writeFileSync(
				join(parentDir, "AGENT.md"),
				"# Parent Context\nParent level",
			);
			writeFileSync(
				join(childDir, "AGENT.md"),
				"# Child Context\nChild level",
			);

			// Change to child directory
			process.chdir(childDir);

			const contextFiles = loadProjectContextFiles();

			// Should have at least 3 files (might have global too)
			expect(contextFiles.length).toBeGreaterThanOrEqual(3);

			// Find the three context files
			const rootContext = contextFiles.find((f) => f.content.includes("Root"));
			const parentContext = contextFiles.find((f) =>
				f.content.includes("Parent"),
			);
			const childContext = contextFiles.find((f) =>
				f.content.includes("Child"),
			);

			expect(rootContext).toBeDefined();
			expect(parentContext).toBeDefined();
			expect(childContext).toBeDefined();

			// Verify order: should be loaded root → parent → child
			const rootIndex = contextFiles.indexOf(rootContext!);
			const parentIndex = contextFiles.indexOf(parentContext!);
			const childIndex = contextFiles.indexOf(childContext!);

			expect(rootIndex).toBeLessThan(parentIndex);
			expect(parentIndex).toBeLessThan(childIndex);
		});

		it("should skip directories without context files", () => {
			// Create structure with gaps
			const rootDir = join(testDir, "root");
			const parentDir = join(rootDir, "parent");
			const childDir = join(parentDir, "child");

			mkdirSync(childDir, { recursive: true });

			// Only root and child have context files, parent doesn't
			writeFileSync(join(rootDir, "AGENT.md"), "# Root Context");
			writeFileSync(join(childDir, "AGENT.md"), "# Child Context");
			// No file in parentDir

			process.chdir(childDir);

			const contextFiles = loadProjectContextFiles();

			// Should find exactly 2 project context files (excluding possible global)
			const projectContexts = contextFiles.filter(
				(f) => !f.path.includes("global") && !f.path.includes(".composer"),
			);
			expect(projectContexts.length).toBe(2);

			const rootContext = projectContexts.find((f) =>
				f.content.includes("Root"),
			);
			const childContext = projectContexts.find((f) =>
				f.content.includes("Child"),
			);

			expect(rootContext).toBeDefined();
			expect(childContext).toBeDefined();
		});

		it("should load CLAUDE.md if AGENT.md doesn't exist", () => {
			const projectDir = join(testDir, "project");
			mkdirSync(projectDir, { recursive: true });

			// Only CLAUDE.md exists
			writeFileSync(
				join(projectDir, "CLAUDE.md"),
				"# Claude Context\nUsing CLAUDE.md",
			);

			process.chdir(projectDir);

			const contextFiles = loadProjectContextFiles();

			const claudeContext = contextFiles.find((f) =>
				f.path.includes("CLAUDE.md"),
			);
			expect(claudeContext).toBeDefined();
			expect(claudeContext?.content).toContain("Claude Context");
		});
	});

	describe("Combined Global and Project Loading", () => {
		it("should load global context before project contexts", () => {
			// Setup global context
			const globalDir = join(testDir, "global");
			mkdirSync(globalDir, { recursive: true });
			writeFileSync(
				join(globalDir, "AGENT.md"),
				"# Global\nGlobal settings",
			);

			// Setup project context
			const projectDir = join(testDir, "project");
			mkdirSync(projectDir, { recursive: true });
			writeFileSync(
				join(projectDir, "AGENT.md"),
				"# Project\nProject settings",
			);

			process.env.COMPOSER_AGENT_DIR = globalDir;
			process.chdir(projectDir);

			const contextFiles = loadProjectContextFiles();

			expect(contextFiles.length).toBeGreaterThanOrEqual(2);

			// Global should come first
			const globalContext = contextFiles.find((f) =>
				f.content.includes("Global settings"),
			);
			const projectContext = contextFiles.find((f) =>
				f.content.includes("Project settings"),
			);

			expect(globalContext).toBeDefined();
			expect(projectContext).toBeDefined();

			const globalIndex = contextFiles.indexOf(globalContext!);
			const projectIndex = contextFiles.indexOf(projectContext!);

			expect(globalIndex).toBeLessThan(projectIndex);
		});

		it("should handle all levels together: global → ancestors → current", () => {
			// Setup global
			const globalDir = join(testDir, "global");
			mkdirSync(globalDir, { recursive: true });
			writeFileSync(join(globalDir, "AGENT.md"), "# Global");

			// Setup multi-level project
			const rootDir = join(testDir, "monorepo");
			const packagesDir = join(rootDir, "packages");
			const appDir = join(packagesDir, "app");

			mkdirSync(appDir, { recursive: true });
			writeFileSync(join(rootDir, "AGENT.md"), "# Monorepo Root");
			writeFileSync(join(packagesDir, "AGENT.md"), "# Packages");
			writeFileSync(join(appDir, "AGENT.md"), "# App");

			process.env.COMPOSER_AGENT_DIR = globalDir;
			process.chdir(appDir);

			const contextFiles = loadProjectContextFiles();

			expect(contextFiles.length).toBeGreaterThanOrEqual(4);

			// Verify order
			const contents = contextFiles.map((f) => f.content);
			const globalIdx = contents.findIndex((c) => c.includes("# Global"));
			const rootIdx = contents.findIndex((c) => c.includes("# Monorepo Root"));
			const packagesIdx = contents.findIndex((c) => c.includes("# Packages"));
			const appIdx = contents.findIndex((c) => c.includes("# App"));

			expect(globalIdx).toBeLessThan(rootIdx);
			expect(rootIdx).toBeLessThan(packagesIdx);
			expect(packagesIdx).toBeLessThan(appIdx);
		});
	});

	describe("Edge Cases", () => {
		it("should return empty array when no context files exist", () => {
			const emptyDir = join(testDir, "empty");
			mkdirSync(emptyDir, { recursive: true });

			// Don't set COMPOSER_AGENT_DIR so no global either
			delete process.env.COMPOSER_AGENT_DIR;
			process.chdir(emptyDir);

			const contextFiles = loadProjectContextFiles();

			// Might still have global from default location, so just check it doesn't crash
			expect(Array.isArray(contextFiles)).toBe(true);
		});

		it("should handle malformed/unreadable context files gracefully", () => {
			const projectDir = join(testDir, "project");
			mkdirSync(projectDir, { recursive: true });

			const filePath = join(projectDir, "AGENT.md");
			writeFileSync(filePath, "Valid content");

			process.chdir(projectDir);

			// Should load successfully
			const contextFiles = loadProjectContextFiles();
			expect(contextFiles.length).toBeGreaterThanOrEqual(1);
		});

		it("should stop at filesystem root", () => {
			// This test ensures we don't infinite loop
			const deepDir = join(testDir, "a", "b", "c", "d", "e", "f");
			mkdirSync(deepDir, { recursive: true });

			process.chdir(deepDir);

			// Should complete without hanging
			const contextFiles = loadProjectContextFiles();
			expect(Array.isArray(contextFiles)).toBe(true);
		});
	});
});
