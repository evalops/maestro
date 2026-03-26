import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	formatChangelogVersion,
	getLatestEntry,
	getNewEntries,
	isChangelogHiddenFromEnv,
	parseChangelog,
	readLastShownChangelogVersion,
	summarizeChangelogEntry,
	writeLastShownChangelogVersion,
} from "../../src/update/changelog.js";

const tempDir = () => mkdtempSync(join(tmpdir(), "composer-changelog-"));

describe("changelog utilities", () => {
	afterEach(() => {
		Reflect.deleteProperty(process.env, "MAESTRO_CHANGELOG_STATE");
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

	it("returns no new entries when last shown is the latest", () => {
		const entries = [
			{ major: 0, minor: 10, patch: 0, content: "0.10.0" },
			{ major: 0, minor: 9, patch: 0, content: "0.9.0" },
		];
		expect(getNewEntries(entries, "0.10.0")).toHaveLength(0);
	});

	it("picks only the latest entry across multiple versions", () => {
		const entries = [
			{ major: 0, minor: 9, patch: 1, content: "0.9.1" },
			{ major: 1, minor: 0, patch: 0, content: "1.0.0" },
			{ major: 0, minor: 10, patch: 5, content: "0.10.5" },
		];
		const latest = getLatestEntry(entries);
		expect(latest?.content).toBe("1.0.0");
	});

	it("returns null when no entries exist", () => {
		expect(getLatestEntry([])).toBeNull();
	});

	it("formats changelog versions", () => {
		expect(
			formatChangelogVersion({ major: 2, minor: 3, patch: 4, content: "" }),
		).toBe("2.3.4");
	});

	it("summarizes the first meaningful line of an entry", () => {
		const summary = summarizeChangelogEntry({
			major: 1,
			minor: 0,
			patch: 0,
			content: `## [1.0.0]

- Added shiny thing
- Fixed stuff`,
		});
		expect(summary).toBe("Added shiny thing");
	});

	it("skips summary when no meaningful lines exist", () => {
		const summary = summarizeChangelogEntry({
			major: 1,
			minor: 0,
			patch: 0,
			content: "",
		});
		expect(summary).toBeNull();
	});

	it("respects MAESTRO_CHANGELOG hide values", () => {
		expect(isChangelogHiddenFromEnv({ MAESTRO_CHANGELOG: "off" })).toBe(true);
		expect(isChangelogHiddenFromEnv({ MAESTRO_CHANGELOG: "hidden" })).toBe(
			true,
		);
		expect(isChangelogHiddenFromEnv({ MAESTRO_CHANGELOG: "false" })).toBe(true);
		expect(isChangelogHiddenFromEnv({ MAESTRO_CHANGELOG: "1" })).toBe(false);
		expect(isChangelogHiddenFromEnv({})).toBe(false);
	});

	it("stores last shown version in override path", () => {
		const dir = tempDir();
		const statePath = join(dir, "state.json");
		process.env.MAESTRO_CHANGELOG_STATE = statePath;
		expect(readLastShownChangelogVersion()).toBeNull();
		writeLastShownChangelogVersion("0.3.0");
		const raw = readFileSync(statePath, "utf-8");
		expect(JSON.parse(raw)).toEqual({ version: "0.3.0" });
		expect(readLastShownChangelogVersion()).toBe("0.3.0");
	});
});
