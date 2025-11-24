import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseStatusOutput } from "../src/tools/diff.js";

const pathArb = fc
	.array(fc.constantFrom(..."abcd _-.".split("")), {
		minLength: 1,
		maxLength: 15,
	})
	.map((chars) => chars.join(""))
	.filter(
		(s) =>
			!s.includes("\0") &&
			!s.startsWith(" ") &&
			!s.endsWith(" ") &&
			s.trim().length > 0,
	);

const xyArb = fc.constantFrom("M.", "A.", "D.", "R.", "C.");
const scoreArb = fc
	.integer({ min: 0, max: 100 })
	.map((n) => n.toString().padStart(3, "0"));

const changeEntry = fc.record({
	kind: fc.constant<"change">("change"),
	xy: xyArb,
	path: pathArb,
});

const untrackedEntry = fc.record({
	kind: fc.constant<"untracked">("untracked"),
	path: pathArb,
});

const ignoredEntry = fc.record({
	kind: fc.constant<"ignored">("ignored"),
	path: pathArb,
});

const renameEntry = fc.record({
	kind: fc.constant<"rename">("rename"),
	xy: fc.constantFrom("R.", "C."),
	score: scoreArb,
	oldPath: pathArb,
	newPath: pathArb,
});

const entryTemplate = fc.oneof(
	changeEntry,
	untrackedEntry,
	ignoredEntry,
	renameEntry,
);

function buildEntries(
	entries: Array<any>,
): string[] {
	const lines: string[] = [];
	for (const entry of entries) {
		switch (entry.kind) {
			case "change": {
				lines.push(
					`1 ${entry.xy} N... 100644 100644 100644 deadbeef deadbeef ${entry.path}`,
				);
				break;
			}
			case "untracked": {
				lines.push(`? ${entry.path}`);
				break;
			}
			case "ignored": {
				lines.push(`! ${entry.path}`);
				break;
			}
			case "rename": {
				const scorePrefix = entry.xy.startsWith("C") ? "C" : "R";
				lines.push(
					`2 ${entry.xy} N... 100644 100644 100644 deadbeef deadbeef ${scorePrefix}${entry.score} ${entry.newPath}`,
				);
				lines.push(entry.oldPath);
				break;
			}
		}
	}
	return lines;
}

describe("parseStatusOutput fuzz", () => {
	it("handles rename paths containing question marks and multibyte chars", () => {
		const raw =
			"2 R. N... 100644 100644 100644 deadbeef deadbeef R042 café?.js\0src/old?name.js\0";
		const parsed = parseStatusOutput(raw);
		const rename = parsed.files.find((f) => f.kind === "rename");
		expect(rename).toMatchObject({
			path: "café?.js",
			origPath: "src/old?name.js",
			score: 42,
		});
	});

	it("handles rename old paths that start with status-like prefixes", () => {
		const raw =
			"2 R. N... 100644 100644 100644 deadbeef deadbeef R000 !\0! !\0" +
			"1 M. N... 100644 100644 100644 deadbeef deadbeef file.txt\0";
		const parsed = parseStatusOutput(raw);
		expect(parsed.files).toHaveLength(2);
		const rename = parsed.files.find((f) => f.kind === "rename");
		expect(rename).toMatchObject({ path: "!", origPath: "! !", score: 0 });
	});

	it("never throws on generated valid entries and preserves paths", () => {
		fc.assert(
			fc.property(
				fc.array(entryTemplate, { minLength: 1, maxLength: 6 }),
				(entries) => {
					const lines = buildEntries(entries);
					const raw = `${lines.join("\0")}\0`;
					const parsed = parseStatusOutput(raw);
					const expectedFiles = entries.map((e) =>
						e.kind === "rename" ? "rename" : e.kind,
					);
					expect(parsed.files).toHaveLength(expectedFiles.length);
					for (const file of parsed.files) {
						expect(["change", "untracked", "ignored", "rename"]).toContain(
							file.kind,
						);
					}
					const renameEntries = entries.filter((e) => e.kind === "rename");
					for (const ren of renameEntries) {
						const parsedRename = parsed.files.find(
							(f) =>
								f.kind === "rename" &&
								f.path === ren.newPath &&
								f.origPath === ren.oldPath,
						);
						expect(parsedRename).toBeDefined();
					}
				},
			),
			{ numRuns: 100 },
		);
	});
});
