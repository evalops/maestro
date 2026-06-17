import { describe, expect, it } from "vitest";
import {
	funnelCounts,
	groupByNextPass,
	isTerminal,
	isTerminalState,
	nextPassFor,
	shouldEscalateForContext,
	shouldRunPass1,
	shouldRunPass2,
	shouldRunPass3,
	shouldRunPass8,
} from "../../src/agent/jury-predicates.js";
import {
	type JurorVerdict,
	type JuryFindingRecord,
	type JuryPassId,
	makeFindingRecord,
} from "../../src/agent/jury-record.js";

function makeVerdict(pass: JuryPassId): JurorVerdict {
	return {
		pass,
		jurorId: "juror-a",
		modelFamily: "anthropic",
		classification: "CONFIRMED",
		stampedAt: "2026-06-15T18:00:00.000Z",
	};
}

function makeRecord(
	overrides: Partial<JuryFindingRecord> = {},
): JuryFindingRecord {
	const base = makeFindingRecord({
		id: "F-1",
		area: "auth",
		title: "XSS in profile",
		proposedSeverity: "high",
		location: {
			file: "src/web/profile.tsx",
			line: 42,
			commitSha: "abcdef1234567890abcdef1234567890abcdef12",
		},
		codeQuote: "<p>{name}</p>",
		now: "2026-06-15T18:00:00.000Z",
	});
	return { ...base, ...overrides };
}

describe("agent/jury-predicates", () => {
	describe("shouldRunPass1", () => {
		it("is true for a proposed record that has at least one Pass 0 verdict", () => {
			const r = makeRecord({
				state: "proposed",
				verdicts: [makeVerdict(0)],
			});
			expect(shouldRunPass1(r)).toBe(true);
		});

		it("is false for a proposed record with no Pass 0 verdicts (waiting for jurors)", () => {
			expect(
				shouldRunPass1(makeRecord({ state: "proposed", verdicts: [] })),
			).toBe(false);
		});

		it("is false once the record has been promoted", () => {
			expect(
				shouldRunPass1(
					makeRecord({ state: "promoted", verdicts: [makeVerdict(0)] }),
				),
			).toBe(false);
		});

		it("is false once Pass 1 verdicts have started arriving", () => {
			expect(
				shouldRunPass1(
					makeRecord({
						state: "proposed",
						verdicts: [makeVerdict(0), makeVerdict(1)],
					}),
				),
			).toBe(false);
		});
	});

	describe("shouldRunPass2", () => {
		it("is true for a promoted record that hasn't been through Pass 2 yet", () => {
			expect(
				shouldRunPass2(makeRecord({ state: "promoted", verdicts: [] })),
			).toBe(true);
		});

		it("is false once Pass 2 has recorded at least one verdict", () => {
			expect(
				shouldRunPass2(
					makeRecord({ state: "promoted", verdicts: [makeVerdict(2)] }),
				),
			).toBe(false);
		});

		it("is false for non-promoted states", () => {
			expect(
				shouldRunPass2(makeRecord({ state: "proposed", verdicts: [] })),
			).toBe(false);
			expect(
				shouldRunPass2(makeRecord({ state: "needs-context", verdicts: [] })),
			).toBe(false);
		});
	});

	describe("shouldRunPass3", () => {
		it("is true only after Pass 2 has run", () => {
			expect(
				shouldRunPass3(
					makeRecord({ state: "promoted", verdicts: [makeVerdict(2)] }),
				),
			).toBe(true);
			expect(
				shouldRunPass3(makeRecord({ state: "promoted", verdicts: [] })),
			).toBe(false);
		});

		it("is false once Pass 3 has run", () => {
			expect(
				shouldRunPass3(
					makeRecord({
						state: "promoted",
						verdicts: [makeVerdict(2), makeVerdict(3)],
					}),
				),
			).toBe(false);
		});
	});

	describe("shouldRunPass8", () => {
		it("is true only after Pass 3 has run", () => {
			expect(
				shouldRunPass8(
					makeRecord({
						state: "promoted",
						verdicts: [makeVerdict(2), makeVerdict(3)],
					}),
				),
			).toBe(true);
			expect(
				shouldRunPass8(
					makeRecord({ state: "promoted", verdicts: [makeVerdict(2)] }),
				),
			).toBe(false);
		});

		it("is true when the latest Pass 8 verdict is INCONCLUSIVE (orchestrator may re-run)", () => {
			// `synthesizePass8` leaves `state === "promoted"` on
			// INCONCLUSIVE so the orchestrator can re-dispatch with more
			// context. The predicate must agree.
			const r = makeRecord({
				state: "promoted",
				verdicts: [
					makeVerdict(2),
					makeVerdict(3),
					{
						pass: 8,
						jurorId: "red-team-a",
						modelFamily: "anthropic",
						classification: "RED-TEAM-INCONCLUSIVE",
						stampedAt: "2026-06-15T19:00:00.000Z",
					},
				],
			});
			expect(shouldRunPass8(r)).toBe(true);
		});

		it("matches synthesizePass8's array-last-entry rule even when stamps are out of order", () => {
			// If shouldRunPass8 picked by stampedAt while synthesizePass8
			// picked by array order, an out-of-order verdict insertion
			// could cause the orchestrator to re-dispatch Pass 8 even
			// though synthesis already treated the finding as final, or
			// skip a retry synthesis still considered inconclusive.
			const r = makeRecord({
				state: "promoted",
				verdicts: [
					makeVerdict(2),
					makeVerdict(3),
					{
						pass: 8,
						jurorId: "red-team-a",
						modelFamily: "anthropic",
						// LATER stamp but EARLIER array position
						classification: "RED-TEAM-INCONCLUSIVE",
						stampedAt: "2026-06-15T20:00:00.000Z",
					},
					{
						pass: 8,
						jurorId: "red-team-b",
						modelFamily: "anthropic",
						// EARLIER stamp but LATER array position
						classification: "RED-TEAM-SURVIVED",
						stampedAt: "2026-06-15T19:00:00.000Z",
					},
				],
			});
			// synthesizePass8 would pick RED-TEAM-SURVIVED (array last),
			// so shouldRunPass8 must agree → false.
			expect(shouldRunPass8(r)).toBe(false);
		});

		it("is false when the latest Pass 8 verdict is a final classification", () => {
			const r = makeRecord({
				state: "promoted",
				verdicts: [
					makeVerdict(2),
					makeVerdict(3),
					{
						pass: 8,
						jurorId: "red-team-a",
						modelFamily: "anthropic",
						classification: "RED-TEAM-SURVIVED",
						stampedAt: "2026-06-15T19:00:00.000Z",
					},
				],
			});
			expect(shouldRunPass8(r)).toBe(false);
		});

		it("is false for terminal records", () => {
			expect(
				shouldRunPass8(
					makeRecord({
						state: "red-team-survived",
						verdicts: [makeVerdict(3), makeVerdict(8)],
					}),
				),
			).toBe(false);
		});
	});

	describe("shouldEscalateForContext", () => {
		it("is true only for needs-context", () => {
			expect(
				shouldEscalateForContext(
					makeRecord({ state: "needs-context", verdicts: [] }),
				),
			).toBe(true);
			expect(
				shouldEscalateForContext(
					makeRecord({ state: "promoted", verdicts: [] }),
				),
			).toBe(false);
		});
	});

	describe("isTerminalState / isTerminal", () => {
		it("treats demoted and red-team-survived as terminal", () => {
			expect(isTerminalState("demoted")).toBe(true);
			expect(isTerminalState("red-team-survived")).toBe(true);
		});

		it("does not treat proposed / promoted / needs-context as terminal", () => {
			expect(isTerminalState("proposed")).toBe(false);
			expect(isTerminalState("promoted")).toBe(false);
			expect(isTerminalState("needs-context")).toBe(false);
		});

		it("isTerminal reads the record state", () => {
			expect(isTerminal(makeRecord({ state: "demoted" }))).toBe(true);
			expect(isTerminal(makeRecord({ state: "proposed" }))).toBe(false);
		});
	});

	describe("nextPassFor", () => {
		it("returns 1 for a proposed record with Pass 0 verdicts", () => {
			expect(
				nextPassFor(
					makeRecord({ state: "proposed", verdicts: [makeVerdict(0)] }),
				),
			).toBe(1);
		});

		it("returns null once Pass 1 verdicts exist but synthesis has not advanced state yet", () => {
			expect(
				nextPassFor(
					makeRecord({
						state: "proposed",
						verdicts: [makeVerdict(0), makeVerdict(1)],
					}),
				),
			).toBeNull();
		});

		it("returns 2 for a fresh promoted record", () => {
			expect(nextPassFor(makeRecord({ state: "promoted", verdicts: [] }))).toBe(
				2,
			);
		});

		it("returns 3 after Pass 2 lands", () => {
			expect(
				nextPassFor(
					makeRecord({ state: "promoted", verdicts: [makeVerdict(2)] }),
				),
			).toBe(3);
		});

		it("returns 8 after Pass 3 lands", () => {
			expect(
				nextPassFor(
					makeRecord({
						state: "promoted",
						verdicts: [makeVerdict(2), makeVerdict(3)],
					}),
				),
			).toBe(8);
		});

		it("returns null for terminal states", () => {
			expect(
				nextPassFor(makeRecord({ state: "demoted", verdicts: [] })),
			).toBeNull();
			expect(
				nextPassFor(makeRecord({ state: "red-team-survived", verdicts: [] })),
			).toBeNull();
		});

		it("returns null for needs-context (orchestrator decides recursion separately)", () => {
			expect(
				nextPassFor(makeRecord({ state: "needs-context", verdicts: [] })),
			).toBeNull();
		});
	});

	describe("funnelCounts", () => {
		it("buckets by state, splits in-flight from terminals", () => {
			const counts = funnelCounts([
				makeRecord({ id: "F-1", state: "proposed" }),
				makeRecord({ id: "F-2", state: "promoted" }),
				makeRecord({ id: "F-3", state: "needs-context" }),
				makeRecord({ id: "F-4", state: "demoted" }),
				makeRecord({ id: "F-5", state: "red-team-survived" }),
			]);
			expect(counts).toEqual({
				inFlight: 3, // proposed + promoted + needs-context
				survived: 1,
				demoted: 1,
				needsContext: 1, // also counted in inFlight
			});
		});

		it("returns zeros for an empty list", () => {
			expect(funnelCounts([])).toEqual({
				inFlight: 0,
				survived: 0,
				demoted: 0,
				needsContext: 0,
			});
		});
	});

	describe("groupByNextPass", () => {
		it("partitions records by next-pass + terminal + awaiting", () => {
			const records = [
				makeRecord({
					id: "F-1",
					state: "proposed",
					verdicts: [makeVerdict(0)],
				}),
				makeRecord({ id: "F-2", state: "promoted", verdicts: [] }),
				makeRecord({
					id: "F-3",
					state: "promoted",
					verdicts: [makeVerdict(2)],
				}),
				makeRecord({
					id: "F-4",
					state: "promoted",
					verdicts: [makeVerdict(2), makeVerdict(3)],
				}),
				makeRecord({ id: "F-5", state: "demoted" }),
				makeRecord({ id: "F-6", state: "needs-context" }),
			];
			const grouped = groupByNextPass(records);
			expect(grouped.byPass.get(1)?.map((r) => r.id)).toEqual(["F-1"]);
			expect(grouped.byPass.get(2)?.map((r) => r.id)).toEqual(["F-2"]);
			expect(grouped.byPass.get(3)?.map((r) => r.id)).toEqual(["F-3"]);
			expect(grouped.byPass.get(8)?.map((r) => r.id)).toEqual(["F-4"]);
			expect(grouped.terminal.map((r) => r.id)).toEqual(["F-5"]);
			expect(grouped.awaiting.map((r) => r.id)).toEqual(["F-6"]);
		});
	});
});
