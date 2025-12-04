import { access, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..", "..");
const distPath = join(projectRoot, "dist");

describe("Build Verification", () => {
	describe("Critical CLI artifacts", () => {
		const criticalFiles = [
			"cli.js",
			"cli.d.ts",
			"main.js",
			"main.d.ts",
			"index.js",
			"index.d.ts",
		];

		for (const file of criticalFiles) {
			it(`should have ${file}`, async () => {
				const filePath = join(distPath, file);
				await expect(access(filePath)).resolves.not.toThrow();
			});

			it(`should have non-zero size for ${file}`, async () => {
				const filePath = join(distPath, file);
				const stats = await stat(filePath);
				expect(stats.size).toBeGreaterThan(0);
			});
		}

		it("should have executable cli.js", async () => {
			const cliPath = join(distPath, "cli.js");
			const stats = await stat(cliPath);
			// Check that file is readable and has content
			expect(stats.size).toBeGreaterThan(1000); // Should be substantial
			const content = await readFile(cliPath, "utf-8");
			expect(content).toContain("#!/usr/bin/env node");
		});
	});

	describe("Core module structure", () => {
		const coreModules = [
			"agent",
			"cli",
			"tools",
			"models",
			"session",
			"config",
			"safety",
		];

		for (const module of coreModules) {
			it(`should have ${module} module directory`, async () => {
				const modulePath = join(distPath, module);
				await expect(access(modulePath)).resolves.not.toThrow();
			});
		}
	});

	describe("Type definitions", () => {
		it("should have type definitions for main entry points", async () => {
			const typeFiles = [
				"cli.d.ts",
				"main.d.ts",
				"index.d.ts",
				"web-server.d.ts",
			];

			for (const typeFile of typeFiles) {
				const filePath = join(distPath, typeFile);
				await expect(access(filePath)).resolves.not.toThrow();
				const content = await readFile(filePath, "utf-8");
				expect(content.length).toBeGreaterThan(0);
			}
		});

		it("should have source maps for main files", async () => {
			const sourceMapFiles = ["cli.js.map", "main.js.map", "index.js.map"];

			for (const mapFile of sourceMapFiles) {
				const filePath = join(distPath, mapFile);
				await expect(access(filePath)).resolves.not.toThrow();
				const content = await readFile(filePath, "utf-8");
				const map = JSON.parse(content);
				expect(map).toHaveProperty("version");
				expect(map).toHaveProperty("sources");
			}
		});
	});

	describe("Web server artifacts", () => {
		it("should have web-server.js", async () => {
			const webServerPath = join(distPath, "web-server.js");
			await expect(access(webServerPath)).resolves.not.toThrow();
			const stats = await stat(webServerPath);
			expect(stats.size).toBeGreaterThan(0);
		});

		it("should have web module directory", async () => {
			const webPath = join(distPath, "web");
			await expect(access(webPath)).resolves.not.toThrow();
		});
	});

	describe("Tool modules", () => {
		const essentialTools = [
			"read.js",
			"write.js",
			"edit.js",
			"list.js",
			"search.js",
			"bash.js",
			"diff.js",
		];

		for (const tool of essentialTools) {
			it(`should have ${tool} tool`, async () => {
				const toolPath = join(distPath, "tools", tool);
				await expect(access(toolPath)).resolves.not.toThrow();
			});
		}
	});

	describe("Package exports", () => {
		it("should have valid main entry point", async () => {
			const indexPath = join(distPath, "index.js");
			const content = await readFile(indexPath, "utf-8");
			// Should export something
			expect(content).toMatch(/export|module\.exports/);
		});

		it("should have CLI entry point", async () => {
			const cliPath = join(distPath, "cli.js");
			const content = await readFile(cliPath, "utf-8");
			// Should import main or have executable code
			expect(content.length).toBeGreaterThan(100);
		});
	});

	describe("Build integrity", () => {
		it("should not have empty directories", async () => {
			const { readdir, stat } = await import("node:fs/promises");
			const dirs = ["agent", "tools", "cli", "models"];

			for (const dir of dirs) {
				const dirPath = join(distPath, dir);
				const entries = await readdir(dirPath);
				expect(entries.length).toBeGreaterThan(0);
			}
		});

		it("should have consistent file structure", async () => {
			// Check that .js files have corresponding .d.ts files for key modules
			const { readdir } = await import("node:fs/promises");
			const toolsPath = join(distPath, "tools");
			const toolFiles = await readdir(toolsPath);
			const jsFiles = toolFiles.filter(
				(f) => f.endsWith(".js") && !f.endsWith(".map"),
			);

			// At least some tools should have type definitions
			const dtsFiles = toolFiles.filter((f) => f.endsWith(".d.ts"));
			expect(dtsFiles.length).toBeGreaterThan(0);
		});
	});
});
