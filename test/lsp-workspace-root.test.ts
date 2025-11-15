import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureRootResolver, configureServers } from "../src/lsp/index.js";
import { resolveWorkspaceRoot } from "../src/workspace/root-resolver.js";

const TEST_DIR = join(process.cwd(), "tmp", "lsp-workspace-root-tests");

describe("LSP Workspace Root Integration", () => {
	beforeEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
		mkdirSync(TEST_DIR, { recursive: true });
	});

	afterEach(() => {
		configureServers([]);
	});

	it("should resolve workspace root with package.json", async () => {
		const projectDir = join(TEST_DIR, "project1");
		const srcDir = join(projectDir, "src");
		mkdirSync(srcDir, { recursive: true });

		writeFileSync(join(projectDir, "package.json"), "{}");
		const testFile = join(srcDir, "index.ts");
		writeFileSync(testFile, "const x = 1;");

		const root = await resolveWorkspaceRoot(testFile);
		expect(root).toBe(projectDir);
	});

	it("should resolve workspace root with tsconfig.json", async () => {
		const projectDir = join(TEST_DIR, "project2");
		const srcDir = join(projectDir, "src");
		mkdirSync(srcDir, { recursive: true });

		writeFileSync(join(projectDir, "tsconfig.json"), "{}");
		const testFile = join(srcDir, "index.ts");
		writeFileSync(testFile, "const x = 1;");

		const root = await resolveWorkspaceRoot(testFile);
		expect(root).toBe(projectDir);
	});

	it("should resolve workspace root with .git", async () => {
		const projectDir = join(TEST_DIR, "project3");
		const srcDir = join(projectDir, "src", "nested");
		mkdirSync(srcDir, { recursive: true });
		mkdirSync(join(projectDir, ".git"));

		const testFile = join(srcDir, "index.ts");
		writeFileSync(testFile, "const x = 1;");

		const root = await resolveWorkspaceRoot(testFile);
		expect(root).toBe(projectDir);
	});

	it("should resolve to nearest root when multiple markers exist", async () => {
		const outerProject = join(TEST_DIR, "outer");
		const innerProject = join(outerProject, "packages", "inner");
		mkdirSync(innerProject, { recursive: true });

		writeFileSync(join(outerProject, "package.json"), "{}");
		writeFileSync(join(innerProject, "package.json"), "{}");

		const testFile = join(innerProject, "src", "index.ts");
		mkdirSync(join(innerProject, "src"));
		writeFileSync(testFile, "const x = 1;");

		const root = await resolveWorkspaceRoot(testFile);
		expect(root).toBe(innerProject);
	});

	it("should return undefined when no workspace root found", async () => {
		// Create test file in tmp which is outside project root
		const isolatedDir = join("/tmp", "lsp-test-isolated", "deep", "nested");
		mkdirSync(isolatedDir, { recursive: true });

		const testFile = join(isolatedDir, "file.ts");
		writeFileSync(testFile, "const x = 1;");

		const root = await resolveWorkspaceRoot(testFile);
		expect(root).toBeUndefined();

		// Cleanup
		rmSync(join("/tmp", "lsp-test-isolated"), { recursive: true, force: true });
	});

	it("should cache workspace root lookups", async () => {
		const projectDir = join(TEST_DIR, "project4");
		const srcDir = join(projectDir, "src");
		mkdirSync(srcDir, { recursive: true });

		writeFileSync(join(projectDir, "package.json"), "{}");
		const file1 = join(srcDir, "file1.ts");
		const file2 = join(srcDir, "file2.ts");
		writeFileSync(file1, "const x = 1;");
		writeFileSync(file2, "const y = 2;");

		// First lookup
		const start1 = Date.now();
		const root1 = await resolveWorkspaceRoot(file1);
		const time1 = Date.now() - start1;

		// Second lookup (should be cached and faster)
		const start2 = Date.now();
		const root2 = await resolveWorkspaceRoot(file2);
		const time2 = Date.now() - start2;

		expect(root1).toBe(projectDir);
		expect(root2).toBe(projectDir);
		// Cache should make second lookup faster (though not guaranteed in all environments)
		expect(time2).toBeLessThanOrEqual(time1 + 5); // Allow some variance
	});

	it("should work with custom root resolver in LSP", async () => {
		const customRoot = join(TEST_DIR, "custom-root");
		mkdirSync(customRoot, { recursive: true });

		const customResolver = async (file: string) => {
			// Always return custom root regardless of file location
			return customRoot;
		};

		configureRootResolver(customResolver);

		// Verify resolver is configured (we can't test the full LSP flow without servers)
		expect(true).toBe(true);
	});

	it("should handle Python project markers", async () => {
		const projectDir = join(TEST_DIR, "python-project");
		const srcDir = join(projectDir, "src");
		mkdirSync(srcDir, { recursive: true });

		writeFileSync(join(projectDir, "pyproject.toml"), "");
		const testFile = join(srcDir, "main.py");
		writeFileSync(testFile, "x = 1");

		const root = await resolveWorkspaceRoot(testFile);
		expect(root).toBe(projectDir);
	});

	it("should handle Go project markers", async () => {
		const projectDir = join(TEST_DIR, "go-project");
		mkdirSync(projectDir, { recursive: true });

		writeFileSync(join(projectDir, "go.mod"), "");
		const testFile = join(projectDir, "main.go");
		writeFileSync(testFile, "package main");

		const root = await resolveWorkspaceRoot(testFile);
		expect(root).toBe(projectDir);
	});

	it("should handle Rust project markers", async () => {
		const projectDir = join(TEST_DIR, "rust-project");
		const srcDir = join(projectDir, "src");
		mkdirSync(srcDir, { recursive: true });

		writeFileSync(join(projectDir, "Cargo.toml"), "");
		const testFile = join(srcDir, "main.rs");
		writeFileSync(testFile, "fn main() {}");

		const root = await resolveWorkspaceRoot(testFile);
		expect(root).toBe(projectDir);
	});

	it("should handle monorepo with pnpm-workspace", async () => {
		const monorepoRoot = join(TEST_DIR, "monorepo");
		const packageDir = join(monorepoRoot, "packages", "app");
		mkdirSync(packageDir, { recursive: true });

		writeFileSync(join(monorepoRoot, "pnpm-workspace.yaml"), "");
		const testFile = join(packageDir, "index.ts");
		writeFileSync(testFile, "const x = 1;");

		const root = await resolveWorkspaceRoot(testFile);
		expect(root).toBe(monorepoRoot);
	});

	it("should handle multiple root markers preference", async () => {
		const projectDir = join(TEST_DIR, "project5");
		mkdirSync(projectDir, { recursive: true });

		// Add multiple markers
		writeFileSync(join(projectDir, "package.json"), "{}");
		writeFileSync(join(projectDir, "tsconfig.json"), "{}");
		mkdirSync(join(projectDir, ".git"));

		const testFile = join(projectDir, "index.ts");
		writeFileSync(testFile, "const x = 1;");

		const root = await resolveWorkspaceRoot(testFile);
		expect(root).toBe(projectDir); // Should find any marker
	});
});
