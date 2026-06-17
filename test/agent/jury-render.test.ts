import { describe, expect, it } from "vitest";
import {
	type FindingSeverity,
	type JurorVerdict,
	type JuryFindingRecord,
	type Pass1Verdict,
	makeFindingRecord,
} from "../../src/agent/jury-record.js";
import {
	renderJuryFinding,
	renderJuryFindings,
} from "../../src/agent/jury-render.js";

function makeRecord(
	overrides: Partial<{
		id: string;
		title: string;
		severity: FindingSeverity;
		state: JuryFindingRecord["state"];
		area: string;
		verdicts: JurorVerdict[];
	}> = {},
): JuryFindingRecord {
	const base = makeFindingRecord({
		id: overrides.id ?? "F-1",
		area: overrides.area ?? "auth",
		title: overrides.title ?? "Cross-site scripting in profile name",
		proposedSeverity: overrides.severity ?? "high",
		location: {
			file: "src/web/profile.tsx",
			line: 42,
			commitSha: "abcdef1234567890abcdef1234567890abcdef12",
		},
		codeQuote: "<p>Hi {props.name}</p>",
		proposedAt: "2026-06-15T18:00:00.000Z",
	});
	const record: JuryFindingRecord = {
		...base,
		state: overrides.state ?? "promoted",
		verdicts: overrides.verdicts ?? [
			{
				pass: 1,
				jurorId: "juror-a",
				modelFamily: "anthropic",
				classification: "CONFIRMED" as Pass1Verdict,
				stampedAt: "2026-06-15T18:30:00.000Z",
			},
		],
	};
	return record;
}

describe("agent/jury-render", () => {
	describe("renderJuryFinding", () => {
		it("renders title, id+area, state, location, and verdict timeline", () => {
			const out = renderJuryFinding(makeRecord());
			expect(out).toContain(
				"### **[HIGH]** Cross-site scripting in profile name",
			);
			expect(out).toContain("**Finding id:** `F-1` (area: `auth`)");
			expect(out).toContain("`promoted`");
			expect(out).toContain("`src/web/profile.tsx:42`");
			expect(out).toContain("`abcdef1`");
			expect(out).toContain("**Verdict timeline:**");
			expect(out).toContain("Pass 1 · `juror-a` (anthropic) → **CONFIRMED**");
		});

		it("includes the code quote inside a fenced block by default", () => {
			const out = renderJuryFinding(makeRecord());
			expect(out).toContain("```\n<p>Hi {props.name}</p>\n```");
		});

		it("skips the code quote when includeCode = false", () => {
			const out = renderJuryFinding(makeRecord(), { includeCode: false });
			expect(out).not.toContain("```");
		});

		it("filters verdicts by sincePass", () => {
			const record = makeRecord({
				verdicts: [
					{
						pass: 1,
						jurorId: "juror-a",
						modelFamily: "anthropic",
						classification: "CONFIRMED",
						stampedAt: "2026-06-15T18:30:00.000Z",
					},
					{
						pass: 8,
						jurorId: "redteam-a",
						modelFamily: "openai",
						classification: "RED-TEAM-SURVIVED",
						stampedAt: "2026-06-15T19:00:00.000Z",
					},
				],
			});
			const out = renderJuryFinding(record, { sincePass: 8 });
			expect(out).toContain("Pass 8");
			expect(out).not.toContain("Pass 1");
		});

		it("renders the verdict reason when present", () => {
			const record = makeRecord({
				verdicts: [
					{
						pass: 1,
						jurorId: "juror-a",
						modelFamily: "anthropic",
						classification: "CONFIRMED",
						reason: "name is rendered into HTML without escape",
						stampedAt: "2026-06-15T18:30:00.000Z",
					},
				],
			});
			const out = renderJuryFinding(record);
			expect(out).toContain("_name is rendered into HTML without escape_");
		});

		it("escapes markdown metacharacters in the title", () => {
			const record = makeRecord({
				title: "`xss` via `<img onerror=*>` *or* something",
			});
			const out = renderJuryFinding(record);
			// Backticks + asterisks should be escaped.
			expect(out).toContain("\\`xss\\`");
			expect(out).toContain("\\*or\\*");
		});

		it("flattens title newlines so they cannot break the heading", () => {
			const record = makeRecord({
				title: "escaped title\n---\nnext line",
			});
			const out = renderJuryFinding(record);
			expect(out).toContain("### **[HIGH]** escaped title --- next line");
		});

		it("escapes asterisks in verdict classification so the bold span survives", () => {
			const record = makeRecord({
				verdicts: [
					{
						pass: 1,
						jurorId: "juror-a",
						modelFamily: "anthropic",
						classification: "BAD**STATE" as unknown as "CONFIRMED",
						stampedAt: "2026-06-15T18:30:00.000Z",
					},
				],
			});
			const out = renderJuryFinding(record);
			// Without escaping the classification, the embedded ** would
			// close the bold span early and corrupt the verdict timeline.
			expect(out).toContain("**BAD\\*\\*STATE**");
		});

		it("flattens verdict reason newlines so they stay inline", () => {
			const record = makeRecord({
				verdicts: [
					{
						pass: 1,
						jurorId: "juror-a",
						modelFamily: "anthropic",
						classification: "CONFIRMED",
						reason: "first line\n- injected list item",
						stampedAt: "2026-06-15T18:30:00.000Z",
					},
				],
			});
			const out = renderJuryFinding(record);
			expect(out).toContain("_first line - injected list item_");
		});

		it("sanitizes record metadata fields rendered outside escapeMd", () => {
			const record = {
				...makeRecord({
					id: "F-1`\n## injected heading",
					area: "auth`\n- injected area",
					verdicts: [
						{
							pass: 1,
							jurorId: "juror`\n# injected juror",
							modelFamily: "anthropic",
							classification: "CONFIRMED",
							stampedAt: "2026-06-15T18:30:00.000Z",
						},
					],
				}),
				location: {
					file: "src/`\n---\nprofile.tsx",
					line: 42,
					commitSha: "ab`\ncdef1234567890",
				},
				proposedAt: "2026-06-15T18:00:00.000Z\n---",
				updatedAt: "2026-06-15T18:45:00.000Z\n# injected update",
				priorArt: [
					{
						id: "CVE-2026`\n- injected prior art",
						kind: "cve" as const,
						summary: "existing sanitizer still applies",
					},
				],
			};
			const out = renderJuryFinding(record);
			expect(out).toContain(
				"**Finding id:** ``F-1` ## injected heading`` (area: ``auth` - injected area``)",
			);
			expect(out).toContain(
				"**Location:** ``src/` --- profile.tsx:42`` @ ``ab` cde``",
			);
			expect(out).toContain(
				"**Proposed:** 2026-06-15T18:00:00.000Z --- · **Updated:** 2026-06-15T18:45:00.000Z # injected update",
			);
			expect(out).toContain(
				"Pass 1 · ``juror` # injected juror`` (anthropic) → **CONFIRMED**",
			);
			expect(out).toContain(
				"- ``CVE-2026` - injected prior art`` (cve): existing sanitizer still applies",
			);
		});

		it("emits no fenced block when codeQuote is whitespace-only", () => {
			const record = makeRecord();
			const empty = { ...record, codeQuote: "   \n  " };
			const out = renderJuryFinding(empty);
			expect(out).not.toContain("```");
		});

		it("breaks out of an embedded triple-backtick in the code quote", () => {
			const record = makeRecord();
			const tricky = {
				...record,
				codeQuote: "before\n```malicious\nstuff\n```\nafter",
			};
			const out = renderJuryFinding(tricky);
			// All triple-backticks inside the quote get rewritten to a
			// zero-width-space-broken variant so they don't close the
			// outer fence.
			const innerFences = out
				.split("\n")
				.filter((line) => line.trim() === "```").length;
			expect(innerFences).toBe(2);
		});
	});

	describe("renderJuryFindings", () => {
		it("returns a 'no findings' placeholder when the list is empty", () => {
			expect(renderJuryFindings([])).toBe("_No findings to render._");
		});

		it("emits a count header + severity mix line", () => {
			const out = renderJuryFindings([
				makeRecord({ id: "F-1", severity: "high" }),
				makeRecord({ id: "F-2", severity: "medium" }),
			]);
			expect(out).toContain("## Jury findings (2)");
			expect(out).toMatch(
				/Severity mix: 0 critical · 1 high · 1 medium · 0 low · 0 info/,
			);
		});

		it("sorts critical above high above lower severities", () => {
			const out = renderJuryFindings([
				makeRecord({
					id: "F-info",
					title: "info finding",
					severity: "info",
				}),
				makeRecord({
					id: "F-crit",
					title: "critical finding",
					severity: "critical",
				}),
				makeRecord({
					id: "F-med",
					title: "medium finding",
					severity: "medium",
				}),
			]);
			const critIdx = out.indexOf("critical finding");
			const medIdx = out.indexOf("medium finding");
			const infoIdx = out.indexOf("info finding");
			expect(critIdx).toBeGreaterThan(0);
			expect(critIdx).toBeLessThan(medIdx);
			expect(medIdx).toBeLessThan(infoIdx);
		});

		it("separates findings with a horizontal rule", () => {
			const out = renderJuryFindings([
				makeRecord({ id: "F-1" }),
				makeRecord({ id: "F-2" }),
			]);
			expect(out.split("---").length).toBeGreaterThanOrEqual(2);
		});
	});
});
