import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setTheme, stopThemeWatcher, theme } from "../../src/theme/theme.js";

describe("Theme compatibility", () => {
	let themePath: string | undefined;

	afterEach(() => {
		stopThemeWatcher();
		// Restore to a built-in theme to avoid leaking custom theme state.
		setTheme("dark");
		if (themePath) {
			rmSync(themePath, { force: true });
		}
	});

	it("loads a pi-mono-like theme missing accentWarm and containing extra keys", () => {
		const themesDir = join(homedir(), ".composer", "agent", "themes");
		mkdirSync(themesDir, { recursive: true });

		const dark = JSON.parse(readFileSync("src/theme/dark.json", "utf-8")) as {
			$schema?: string;
			name: string;
			vars?: Record<string, unknown>;
			colors: Record<string, unknown>;
		};

		const { accentWarm: _accentWarm, ...colorsWithoutAccentWarm } = dark.colors;
		const colors = {
			...colorsWithoutAccentWarm,
			thinkingXhigh: colorsWithoutAccentWarm.thinkingHigh,
			bashMode: colorsWithoutAccentWarm.accent,
		};

		const customTheme = {
			...dark,
			name: "pi-mono-compat",
			colors,
		};

		const themeName = `pi-mono-compat-test-${Date.now()}`;
		themePath = join(themesDir, `${themeName}.json`);

		writeFileSync(themePath, JSON.stringify(customTheme, null, 2));

		const result = setTheme(themeName);
		expect(result.success).toBe(true);
		expect(() => theme.getFgAnsi("accentWarm")).not.toThrow();
	});
});
