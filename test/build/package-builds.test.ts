import { access, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..", "..");

describe("Package Build Verification", () => {
	describe("TUI package", () => {
		const tuiDistPath = join(projectRoot, "packages", "tui", "dist");

		it("should have TUI dist directory", async () => {
			await expect(access(tuiDistPath)).resolves.not.toThrow();
		});

		it("should have TUI entry files", async () => {
			const entryFiles = ["index.js", "index.d.ts"];
			for (const file of entryFiles) {
				const filePath = join(tuiDistPath, file);
				await expect(access(filePath)).resolves.not.toThrow();
				const stats = await stat(filePath);
				expect(stats.size).toBeGreaterThan(0);
			}
		});

		it("should have TUI components", async () => {
			const { readdir } = await import("node:fs/promises");
			const entries = await readdir(tuiDistPath);
			expect(entries.length).toBeGreaterThan(0);
		});
	});

	describe("Web package", () => {
		const webDistPath = join(projectRoot, "packages", "web", "dist");

		it("should have Web dist directory", async () => {
			await expect(access(webDistPath)).resolves.not.toThrow();
		});

		it("should have Web build artifacts", async () => {
			const { readdir } = await import("node:fs/promises");
			const entries = await readdir(webDistPath);
			expect(entries.length).toBeGreaterThan(0);

			// Should have at least one bundle artifact
			const hasBundle = entries.some(
				(e) =>
					e.endsWith(".es.js") || e.endsWith(".umd.js") || e.endsWith(".js"),
			);
			expect(hasBundle).toBe(true);
		});
	});

	describe("Contracts package", () => {
		const contractsDistPath = join(
			projectRoot,
			"packages",
			"contracts",
			"dist",
		);

		it("should have Contracts dist directory", async () => {
			await expect(access(contractsDistPath)).resolves.not.toThrow();
		});

		it("should have Contracts type definitions", async () => {
			const { readdir } = await import("node:fs/promises");
			const entries = await readdir(contractsDistPath);
			const dtsFiles = entries.filter((e) => e.endsWith(".d.ts"));
			expect(dtsFiles.length).toBeGreaterThan(0);
		});
	});

	describe("AI package", () => {
		const aiDistPath = join(projectRoot, "packages", "ai", "dist");

		it("should have AI dist directory", async () => {
			await expect(access(aiDistPath)).resolves.not.toThrow();
		});

		it("should have AI module files", async () => {
			const { readdir } = await import("node:fs/promises");
			const entries = await readdir(aiDistPath);
			expect(entries.length).toBeGreaterThan(0);
		});
	});
});
