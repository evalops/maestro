import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	embeddedThemes,
	getAvailableThemes,
	loadThemeJson,
	resolveThemeFilePath,
} from "../../src/theme/theme-loader.js";

describe("theme-loader", () => {
	let testDir: string;
	let workspaceDir: string;
	let previousMaestroHome: string | undefined;

	beforeEach(() => {
		testDir = join(tmpdir(), `composer-theme-loader-${Date.now()}`);
		workspaceDir = join(testDir, "workspace");
		previousMaestroHome = process.env.MAESTRO_HOME;
		process.env.MAESTRO_HOME = join(testDir, ".maestro-home");
		mkdirSync(join(workspaceDir, ".maestro"), { recursive: true });
	});

	afterEach(() => {
		if (previousMaestroHome === undefined) {
			delete process.env.MAESTRO_HOME;
		} else {
			process.env.MAESTRO_HOME = previousMaestroHome;
		}
		rmSync(testDir, { recursive: true, force: true });
	});

	it("loads configured package themes relative to project config", () => {
		const packageDir = join(workspaceDir, "vendor", "theme-pack");
		const packagedThemeDir = join(packageDir, "themes", "sunrise");
		mkdirSync(packagedThemeDir, { recursive: true });
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: "@test/theme-pack",
				keywords: ["maestro-package"],
				maestro: {
					themes: ["./themes"],
				},
			}),
		);
		writeFileSync(
			join(packagedThemeDir, "theme.json"),
			JSON.stringify(embeddedThemes.dark),
		);
		writeFileSync(
			join(workspaceDir, ".maestro", "config.toml"),
			'packages = ["../vendor/theme-pack"]\n',
		);

		expect(getAvailableThemes(workspaceDir)).toContain("sunrise");
		expect(resolveThemeFilePath("sunrise", workspaceDir)).toBe(
			join(packagedThemeDir, "theme.json"),
		);
		expect(loadThemeJson("sunrise", workspaceDir)).toEqual(embeddedThemes.dark);
	});
});
