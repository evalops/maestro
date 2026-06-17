import { describe, expect, it } from "vitest";
import {
	renderAgentNote,
	renderAgentNotes,
} from "../../src/agent/git-ai-note-render.js";
import { type AgentNote, makeAgentNote } from "../../src/agent/git-ai-note.js";

function makeNote(overrides: Partial<AgentNote> = {}): AgentNote {
	const base = makeAgentNote({
		commitSha: "abc1234deadbeef",
		intent: "Implement OAuth login.",
		evidence: ["test/auth/oauth.test.ts: 12/12 pass"],
		followUps: [],
		provenance: {
			createdAt: "2026-06-15T18:00:00.000Z",
			modelId: "claude-opus-4-7",
			sessionId: "session-1",
		},
	});
	return { ...base, ...overrides };
}

describe("agent/git-ai-note-render", () => {
	describe("renderAgentNote", () => {
		it("renders heading with short commit sha, intent, and provenance", () => {
			const out = renderAgentNote(makeNote());
			expect(out).toContain("### Agent note — `abc1234`");
			expect(out).toContain("**Intent:** Implement OAuth login.");
			expect(out).toContain("model `claude-opus-4-7`");
			expect(out).toContain("session `session-1`");
			expect(out).toContain("at 2026-06-15T18:00:00.000Z");
		});

		it("escapes backticks in provenance values without breaking the footer", () => {
			const out = renderAgentNote(
				makeNote({
					provenance: {
						createdAt: "2026-06-15T18:00:00.000Z",
						modelId: "claude`opus`4-7",
						sessionId: "session`1",
						agentVersion: "1.2.3`+commit",
					},
				}),
			);
			// Each provenance value must keep its full body inside one code
			// span (no premature span close from embedded backticks).
			expect(out).toContain("model ``claude`opus`4-7``");
			expect(out).toContain("session ``session`1``");
			expect(out).toContain("agent ``1.2.3`+commit``");
		});

		it("renders evidence bullets when present", () => {
			const out = renderAgentNote(
				makeNote({ evidence: ["proof A", "proof B"] }),
			);
			expect(out).toContain("**Evidence:**");
			expect(out).toContain("- proof A");
			expect(out).toContain("- proof B");
		});

		it("omits the evidence section when evidence is empty", () => {
			const out = renderAgentNote(makeNote({ evidence: [] }));
			expect(out).not.toContain("**Evidence:**");
		});

		it("renders follow-ups with severity badges + detail", () => {
			const out = renderAgentNote(
				makeNote({
					followUps: [
						{
							title: "audit telemetry",
							severity: "risk",
							detail: "needs SOC2 review",
						},
						{ title: "watch login latency", severity: "watch" },
						{ title: "doc update", severity: "info" },
						{ title: "no severity given" },
					],
				}),
			);
			expect(out).toContain("- **[RISK]** audit telemetry — needs SOC2 review");
			expect(out).toContain("- **[WATCH]** watch login latency");
			// `info` and undefined severity don't get a badge.
			expect(out).toContain("- doc update");
			expect(out).toContain("- no severity given");
		});

		it("omits provenance block when includeProvenance=false", () => {
			const out = renderAgentNote(makeNote(), { includeProvenance: false });
			expect(out).not.toContain("model");
			expect(out).not.toContain("session");
			expect(out).not.toContain("at 2026-06-15");
		});

		it("falls back to italicized '(unspecified)' for a blank intent (placeholder is a markdown literal)", () => {
			const out = renderAgentNote(makeNote({ intent: "   " }));
			// Pre-fix the underscores were escaped, so reviewers saw
			// literal `\_(unspecified)\_` instead of an italic span.
			expect(out).toContain("**Intent:** _(unspecified)_");
			expect(out).not.toContain("\\_(unspecified)\\_");
		});

		it("collapses newlines inside user content so they can't inject headings or rules", () => {
			const out = renderAgentNote(
				makeNote({
					intent: "First line.\n# Injected heading\n---",
					evidence: ["multiline\nentry\nwith\nlines"],
					provenance: {
						createdAt: "2026-06-15T18:00:00.000Z\n# stop",
					},
				}),
			);
			// No bare H1 hash or rule from the intent should appear at
			// the start of a line.
			expect(out).not.toMatch(/^# Injected heading$/m);
			expect(out).not.toMatch(/^---$/m);
			// The values are preserved with newlines collapsed.
			expect(out).toContain("First line. # Injected heading ---");
			expect(out).toContain("multiline entry with lines");
			expect(out).toContain("at 2026-06-15T18:00:00.000Z # stop");
		});

		it("uses a safe code fence for parsed commit shas with backticks or newlines", () => {
			const out = renderAgentNote(
				makeNote({
					commitSha: "ab`\n#12rest",
				}),
			);
			expect(out).toContain("### Agent note — ``ab` #12``");
			expect(out).not.toMatch(/^#12rest$/m);
		});

		it("uses headingDepthOffset to nest under a deeper heading", () => {
			const out = renderAgentNote(makeNote(), { headingDepthOffset: 1 });
			// H3 (`###`) + offset 1 → H4 (`####`). Check the line itself
			// starts with exactly four hashes, since `####` contains `###`
			// as a substring.
			expect(out).toMatch(/^#{4} Agent note/);
		});

		it("clamps headingDepthOffset so we never overflow markdown's max H6", () => {
			const out = renderAgentNote(makeNote(), { headingDepthOffset: 99 });
			// `###` + clamped 4 → `#######`, but markdown caps at H6.
			// Our renderer caps at 6 hashes.
			expect(out).toMatch(/^#{6} Agent note/);
		});

		it("escapes markdown metacharacters in user content", () => {
			const out = renderAgentNote(
				makeNote({
					intent: "Refactor `useAuth` *and* _useSession_",
					evidence: ["Removed `dead/path/*.ts`"],
				}),
			);
			expect(out).toContain("\\`useAuth\\`");
			expect(out).toContain("\\*and\\*");
			expect(out).toContain("\\_useSession\\_");
			expect(out).toContain("\\`dead/path/\\*.ts\\`");
		});

		it("escapes the commit SHA in the heading so a crafted sha can't break out of the code span", () => {
			const out = renderAgentNote(makeNote({ commitSha: "`abc\n# x" }));
			// Heading still parses as a single H3 line — the injected
			// backtick is escaped and the newline collapses to a space.
			expect(out).toMatch(/^### Agent note — `[^\n]+$/m);
			expect(out).not.toMatch(/^# x$/m);
		});

		it("renders even when provenance has only the required createdAt field", () => {
			const out = renderAgentNote(
				makeNote({
					provenance: { createdAt: "2026-06-15T18:00:00.000Z" },
				}),
			);
			expect(out).toContain("at 2026-06-15T18:00:00.000Z");
			expect(out).not.toContain("model `");
			expect(out).not.toContain("session `");
		});
	});

	describe("renderAgentNotes", () => {
		it("returns a 'no agent notes' placeholder when empty", () => {
			expect(renderAgentNotes([])).toBe("_No agent notes._");
		});

		it("sorts by provenance.createdAt descending (most recent first)", () => {
			const out = renderAgentNotes([
				makeNote({
					commitSha: "older1234",
					intent: "OLDER NOTE",
					provenance: { createdAt: "2026-06-10T18:00:00.000Z" },
				}),
				makeNote({
					commitSha: "newer5678",
					intent: "NEWER NOTE",
					provenance: { createdAt: "2026-06-15T18:00:00.000Z" },
				}),
			]);
			const newerIdx = out.indexOf("NEWER NOTE");
			const olderIdx = out.indexOf("OLDER NOTE");
			expect(newerIdx).toBeGreaterThan(0);
			expect(newerIdx).toBeLessThan(olderIdx);
		});

		it("separates notes with horizontal rules", () => {
			const out = renderAgentNotes([
				makeNote({ commitSha: "aaa1234" }),
				makeNote({ commitSha: "bbb5678" }),
			]);
			expect(out.split("---").length).toBeGreaterThanOrEqual(2);
		});
	});
});
