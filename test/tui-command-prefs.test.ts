import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadCommandPrefs, saveCommandPrefs } from "../src/cli-tui/ui-state.js";

const withTempPrefs = (fn: (path: string) => void) => {
	const dir = mkdtempSync(join(tmpdir(), "composer-prefs-"));
	const file = join(dir, "prefs.json");
	const prev = process.env.COMPOSER_COMMAND_PREFS;
	process.env.COMPOSER_COMMAND_PREFS = file;
	try {
		fn(file);
	} finally {
		if (prev === undefined) {
			// biome-ignore lint/performance/noDelete: Must use delete, not = undefined
			delete process.env.COMPOSER_COMMAND_PREFS;
		} else {
			process.env.COMPOSER_COMMAND_PREFS = prev;
		}
	}
};

describe("command prefs", () => {
	it("saves and loads favorites/recents", () => {
		withTempPrefs((file) => {
			saveCommandPrefs({ favorites: ["run"], recents: ["help", "run"] });
			const raw = readFileSync(file, "utf8");
			expect(raw).toContain("run");
			const prefs = loadCommandPrefs();
			expect(prefs.favorites).toEqual(["run"]);
			expect(prefs.recents).toEqual(["help", "run"]);
		});
	});
});
