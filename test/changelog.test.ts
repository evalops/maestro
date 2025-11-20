import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	getNewEntries,
	parseChangelog,
	readLastShownChangelogVersion,
	writeLastShownChangelogVersion,
} from "../src/update/changelog.js";

const tempDir = () => mkdtempSync(join(tmpdir(), "composer-changelog-"));

describe("changelog utilities", () => {
	afterEach(() => {
		process.env.COMPOSER_CHANGELOG_STATE = undefined;
	});

	it("parses entries and filters newer ones", () => {
		const dir = tempDir();
		const changelogPath = join(dir, "CHANGELOG.md");
		writeFileSync(
			changelogPath,
			`# Changelog

## [0.2.0] - 2025-11-20
- Added feature

## [0.1.0] - 2025-11-19
- Initial release`,
		);
		const entries = parseChangelog(changelogPath);
		expect(entries).toHaveLength(2);
		const newer = getNewEntries(entries, "0.1.5");
		expect(newer).toHaveLength(1);
		expect(newer[0]?.content).toContain("0.2.0");
	});

	it("stores last shown version in override path", () => {
		const dir = tempDir();
		const statePath = join(dir, "state.json");
		process.env.COMPOSER_CHANGELOG_STATE = statePath;
		expect(readLastShownChangelogVersion()).toBeNull();
		writeLastShownChangelogVersion("0.3.0");
		const raw = readFileSync(statePath, "utf-8");
		expect(JSON.parse(raw)).toEqual({ version: "0.3.0" });
		expect(readLastShownChangelogVersion()).toBe("0.3.0");
	});
});
