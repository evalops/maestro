import { describe, expect, it } from "vitest";
import {
	AGENT_NOTE_SCHEMA_VERSION,
	type AgentNoteInput,
	buildAgentNote,
	gitAiNotesRef,
	makeAgentNote,
	parseAgentNote,
} from "../../src/agent/git-ai-note.js";

function makeInput(overrides: Partial<AgentNoteInput> = {}): AgentNoteInput {
	return {
		commitSha: "abc1234",
		intent: "Add the foo to the bar.",
		evidence: ["test/foo.test.ts passed", "manual smoke ok"],
		followUps: [
			{
				title: "Backport to v1",
				detail: "Cherry-pick when stable.",
				severity: "info",
			},
		],
		provenance: {
			modelId: "claude-opus-4-7",
			sessionId: "sess-1",
			agentVersion: "maestro-0.10.48",
			createdAt: "2026-06-15T18:00:00.000Z",
		},
		...overrides,
	};
}

describe("agent/git-ai-note", () => {
	describe("makeAgentNote", () => {
		it("normalizes evidence, follow-ups, and provenance", () => {
			const note = makeAgentNote(
				makeInput({
					evidence: ["  passed  ", "", "another  "],
					followUps: [
						{ title: "  spaced  ", detail: "  detail  " },
						{ title: "no severity given" },
					],
				}),
			);

			expect(note.version).toBe(AGENT_NOTE_SCHEMA_VERSION);
			expect(note.evidence).toEqual(["passed", "another"]);
			expect(note.followUps[0]).toEqual({
				title: "spaced",
				detail: "detail",
				severity: "info",
			});
			expect(note.followUps[1].severity).toBe("info");
		});

		it("trims commitSha and rejects non-hex strings", () => {
			expect(() =>
				makeAgentNote(makeInput({ commitSha: "  abc1234  " })),
			).not.toThrow();
			expect(() => makeAgentNote(makeInput({ commitSha: "" }))).toThrow(
				/commitSha is required/,
			);
			expect(() => makeAgentNote(makeInput({ commitSha: "not-hex" }))).toThrow(
				/7-64 hex/,
			);
			expect(() => makeAgentNote(makeInput({ commitSha: "abc" }))).toThrow(
				/7-64 hex/,
			);
		});

		it("rejects empty intent and overlong intent", () => {
			expect(() => makeAgentNote(makeInput({ intent: "" }))).toThrow(
				/intent is required/,
			);
			expect(() =>
				makeAgentNote(makeInput({ intent: "a".repeat(2001) })),
			).toThrow(/2000 characters/);
		});

		it("requires provenance and a non-empty createdAt", () => {
			expect(() =>
				makeAgentNote({ ...makeInput(), provenance: undefined as never }),
			).toThrow(/provenance is required/);
			expect(() =>
				makeAgentNote(
					makeInput({
						provenance: { createdAt: "" } as never,
					}),
				),
			).toThrow(/createdAt is required/);
		});

		it("rejects follow-ups with empty titles", () => {
			expect(() =>
				makeAgentNote(
					makeInput({
						followUps: [{ title: "  " }],
					}),
				),
			).toThrow(/follow-up title is required/);
		});

		it("drops empty optional provenance fields", () => {
			const note = makeAgentNote(
				makeInput({
					provenance: {
						modelId: "",
						sessionId: undefined,
						agentVersion: "  ",
						createdAt: "2026-06-15T18:00:00.000Z",
					},
				}),
			);
			expect(note.provenance.modelId).toBeUndefined();
			expect(note.provenance.sessionId).toBeUndefined();
			expect(note.provenance.agentVersion).toBeUndefined();
			expect(note.provenance.createdAt).toBe("2026-06-15T18:00:00.000Z");
		});
	});

	describe("buildAgentNote", () => {
		it("renders the intent, evidence, follow-ups, and provenance sections", () => {
			const text = buildAgentNote(makeInput());
			expect(text).toContain("# Maestro agent note for abc1234");
			expect(text).toContain("## Intent");
			expect(text).toContain("Add the foo to the bar.");
			expect(text).toContain("## Evidence");
			expect(text).toContain("- test/foo.test.ts passed");
			expect(text).toContain("## Follow-ups");
			expect(text).toContain("- **Backport to v1**");
			expect(text).toContain("- Cherry-pick when stable.");
			expect(text).toContain("## Provenance");
			expect(text).toContain("- Model: `claude-opus-4-7`");
			expect(text).toContain("- Created: 2026-06-15T18:00:00.000Z");
		});

		it("annotates risk follow-ups with their severity", () => {
			const text = buildAgentNote(
				makeInput({
					followUps: [
						{ title: "Watch flaky test", severity: "watch" },
						{ title: "Possible perf regression", severity: "risk" },
					],
				}),
			);
			expect(text).toContain("- **Watch flaky test** (watch)");
			expect(text).toContain("- **Possible perf regression** (risk)");
		});

		it("omits Evidence and Follow-ups sections when both are empty", () => {
			const text = buildAgentNote(makeInput({ evidence: [], followUps: [] }));
			expect(text).not.toContain("## Evidence");
			expect(text).not.toContain("## Follow-ups");
		});

		it("appends a canonical fenced JSON block", () => {
			const text = buildAgentNote(makeInput());
			expect(text).toContain("```json maestro-note");
			const fenceStart = text.indexOf("```json maestro-note");
			expect(fenceStart).toBeGreaterThan(0);
			const jsonText = text
				.slice(fenceStart + "```json maestro-note".length)
				.split("```")[0]
				.trim();
			const parsed = JSON.parse(jsonText);
			expect(parsed.version).toBe(AGENT_NOTE_SCHEMA_VERSION);
			expect(parsed.commitSha).toBe("abc1234");
		});
	});

	describe("parseAgentNote round-trip", () => {
		it("reads back the note that buildAgentNote rendered", () => {
			const text = buildAgentNote(makeInput());
			const result = parseAgentNote(text);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.note.commitSha).toBe("abc1234");
				expect(result.note.intent).toBe("Add the foo to the bar.");
				expect(result.note.evidence).toHaveLength(2);
				expect(result.note.followUps).toHaveLength(1);
			}
		});

		it("round-trips note fields that contain fenced-code delimiters", () => {
			const text = buildAgentNote(
				makeInput({
					intent: "Document the ```json maestro-note format.",
					evidence: ["Saw ``` in user-facing guidance."],
					followUps: [
						{
							title: "Preserve ``` in notes",
							detail: "Keep ```json examples round-trippable.",
						},
					],
				}),
			);
			const result = parseAgentNote(text);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.note.intent).toBe(
					"Document the ```json maestro-note format.",
				);
				expect(result.note.evidence).toEqual([
					"Saw ``` in user-facing guidance.",
				]);
				expect(result.note.followUps[0]).toEqual({
					title: "Preserve ``` in notes",
					detail: "Keep ```json examples round-trippable.",
					severity: "info",
				});
			}
		});

		it("ignores prose edits above the JSON block", () => {
			const text = buildAgentNote(makeInput());
			const tampered = text.replace(
				"## Intent\n\nAdd the foo to the bar.",
				"## Intent\n\nI rewrote the prose to claim something else.",
			);
			const result = parseAgentNote(tampered);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.note.intent).toBe("Add the foo to the bar.");
			}
		});

		it("returns no-fenced-json when no JSON block is present", () => {
			const result = parseAgentNote("just some prose, no fence");
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason).toBe("no-fenced-json");
			}
		});

		it("returns invalid-json when the fenced block isn't valid JSON", () => {
			const text = "intro\n\n```json maestro-note\nnot json {\n```\n";
			const result = parseAgentNote(text);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason).toBe("invalid-json");
			}
		});

		it("returns missing-required-field when required keys are absent", () => {
			const text = '```json maestro-note\n{"version": 1}\n```\n';
			const result = parseAgentNote(text);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason).toBe("missing-required-field");
			}
		});

		it("returns unsupported-version when version exceeds current schema", () => {
			const text = `\`\`\`json maestro-note\n${JSON.stringify({
				version: AGENT_NOTE_SCHEMA_VERSION + 1,
				commitSha: "abc1234",
				intent: "x",
				evidence: [],
				followUps: [],
				provenance: { createdAt: "2026-06-15T18:00:00.000Z" },
			})}\n\`\`\`\n`;
			const result = parseAgentNote(text);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason).toBe("unsupported-version");
			}
		});
	});

	describe("gitAiNotesRef", () => {
		it("builds the canonical maestro/<projectId>/<channel> ref", () => {
			expect(gitAiNotesRef("default")).toBe(
				"refs/notes/maestro/default/checkpoints",
			);
			expect(gitAiNotesRef("billing-service", "reviews")).toBe(
				"refs/notes/maestro/billing-service/reviews",
			);
		});

		it("rejects non-alphanumeric project ids", () => {
			expect(() => gitAiNotesRef("../escape")).toThrow();
			expect(() => gitAiNotesRef("project name with spaces")).toThrow();
			expect(() => gitAiNotesRef("")).toThrow();
		});
	});
});
