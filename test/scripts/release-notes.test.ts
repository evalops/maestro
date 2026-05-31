import { describe, expect, it } from "vitest";
import {
	buildChangelogEntry,
	classifyReleaseNoteSubject,
	extractChangelogEntry,
	formatReleaseNoteSubject,
	groupReleaseNotes,
	insertChangelogEntry,
	mergeOrInsertChangelogEntry,
	replaceOrInsertChangelogEntry,
	shouldSkipReleaseNoteSubject,
} from "../../scripts/release-notes.js";

describe("release notes helpers", () => {
	it("skips generated mirror and release commits", () => {
		expect(
			shouldSkipReleaseNoteSubject("chore: sync public mirror from internal"),
		).toBe(true);
		expect(shouldSkipReleaseNoteSubject("Release v0.10.19")).toBe(true);
		expect(shouldSkipReleaseNoteSubject("fix: keep sessions alive")).toBe(
			false,
		);
	});

	it("classifies conventional commit subjects into changelog sections", () => {
		expect(classifyReleaseNoteSubject("feat(agent): add planner")).toBe(
			"Added",
		);
		expect(classifyReleaseNoteSubject("fix: repair publish smoke")).toBe(
			"Fixed",
		);
		expect(classifyReleaseNoteSubject("docs: update runbook")).toBe("Changed");
	});

	it("formats subjects as human-readable changelog bullets", () => {
		expect(formatReleaseNoteSubject("feat(agent): add planner (#123)")).toBe(
			"Add planner (#123).",
		);
		expect(formatReleaseNoteSubject("fix: preserve existing period.")).toBe(
			"Preserve existing period.",
		);
	});

	it("groups release notes and falls back for empty maintenance releases", () => {
		expect(
			groupReleaseNotes([
				"feat(agent): add planner",
				"fix: repair publish smoke",
				"chore: sync public mirror from internal",
			]),
		).toMatchObject({
			Added: ["Add planner."],
			Fixed: ["Repair publish smoke."],
		});

		expect(
			groupReleaseNotes(["chore: sync public mirror from internal"]).Changed,
		).toEqual([
			"Maintenance release with repository, CI, or documentation updates since the previous tag.",
		]);
	});

	it("builds and extracts versioned changelog entries", () => {
		const entry = buildChangelogEntry({
			version: "1.2.3",
			date: "2026-05-17",
			subjects: ["feat: add cadence", "fix: repair publish smoke"],
		});
		const changelog = insertChangelogEntry(
			"# Changelog\n\n## [1.2.2] - 2026-05-10\n\n### Fixed\n\n- Prior fix.\n",
			entry,
		);

		expect(changelog).toContain("## [1.2.3] - 2026-05-17");
		expect(changelog.indexOf("## [1.2.3]")).toBeLessThan(
			changelog.indexOf("## [1.2.2]"),
		);
		expect(extractChangelogEntry(changelog, "1.2.3")).toContain(
			"### Added\n\n- Add cadence.",
		);
	});

	it("replaces an existing generated entry when refreshing a release branch", () => {
		const changelog = `# Changelog

## [1.2.3] - 2026-05-17

Release manager summary stays intact.

### Changed

- Old note.

## [1.2.2] - 2026-05-10

### Fixed

- Prior fix.
`;
		const nextEntry = buildChangelogEntry({
			version: "1.2.3",
			date: "2026-05-18",
			subjects: ["fix: current note"],
		});

		const updated = replaceOrInsertChangelogEntry(
			changelog,
			"1.2.3",
			nextEntry,
		);

		expect(updated).toContain("## [1.2.3] - 2026-05-18");
		expect(updated).toContain("- Current note.");
		expect(updated).not.toContain("- Old note.");
		expect(updated).toContain("## [1.2.2] - 2026-05-10");
	});

	it("merges generated notes without clobbering manual release edits", () => {
		const changelog = `# Changelog

## [1.2.3] - 2026-05-17

Release manager summary stays intact.

### Changed

- Carefully edited release-manager wording.

## [1.2.2] - 2026-05-10

### Fixed

- Prior fix.
`;
		const nextEntry = buildChangelogEntry({
			version: "1.2.3",
			date: "2026-05-18",
			subjects: ["fix: current note", "chore: maintenance update"],
		});

		const updated = mergeOrInsertChangelogEntry(changelog, "1.2.3", nextEntry);

		expect(updated).toContain("Release manager summary stays intact.");
		expect(updated).toContain("- Carefully edited release-manager wording.");
		expect(updated).toContain("### Fixed\n\n- Current note.");
		expect(updated).toContain("- Maintenance update.");
		expect(updated).toContain("## [1.2.2] - 2026-05-10");
	});

	it("does not duplicate edited generated notes that keep their marker", () => {
		const generatedEntry = buildChangelogEntry({
			version: "1.2.3",
			date: "2026-05-18",
			subjects: ["feat: add planner"],
		});
		const marker =
			generatedEntry.match(/<!-- maestro-release-note:[a-f0-9]{12} -->/)?.[0] ??
			"";

		expect(marker).not.toBe("");

		const changelog = `# Changelog

## [1.2.3] - 2026-05-17

### Changed

- Better release-manager wording for the planner. ${marker}
`;

		const updated = mergeOrInsertChangelogEntry(
			changelog,
			"1.2.3",
			generatedEntry,
		);

		expect(updated).toContain(
			"- Better release-manager wording for the planner. ",
		);
		expect(updated).not.toContain("- Add planner. ");
	});
});
