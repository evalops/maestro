import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { copyThemes } from "../../scripts/copy-themes.js";

function createTempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

describe("copyThemes", () => {
	it("copies all json files when present", () => {
		const root = createTempDir("copy-themes-json-");
		const source = join(root, "src");
		const target = join(root, "dist");
		mkdirSync(source, { recursive: true });
		const themeFile = join(source, "dark.json");
		writeFileSync(themeFile, '{"name":"dark"}');
		const otherFile = join(source, "notes.txt");
		writeFileSync(otherFile, "ignore me");

		copyThemes({ sourceDir: source, targetDir: target });

		const copied = join(target, "dark.json");
		expect(existsSync(copied)).toBe(true);
		expect(readFileSync(copied, "utf8")).toBe('{"name":"dark"}');
		expect(readdirSync(target)).toEqual(["dark.json"]);
	});

	it("no-ops when source directory is missing", () => {
		const root = createTempDir("copy-themes-missing-");
		const source = join(root, "missing-src");
		const target = join(root, "dist");

		copyThemes({ sourceDir: source, targetDir: target });

		expect(existsSync(target)).toBe(false);
	});

	it("no-ops when directory exists but no json files", () => {
		const root = createTempDir("copy-themes-empty-");
		const source = join(root, "src");
		const target = join(root, "dist");
		mkdirSync(source, { recursive: true });
		writeFileSync(join(source, "readme.md"), "docs");

		copyThemes({ sourceDir: source, targetDir: target });

		expect(existsSync(target)).toBe(false);
	});
});
