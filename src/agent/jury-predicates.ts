/**
 * Jury record state predicates
 *
 * Builds on the jury record primitive (part 1 of #2668, merged as
 * #2680) and the markdown renderer (#2689). Pure predicates the
 * orchestrator uses to decide which pass to run next for a finding,
 * and what the funnel state at any moment looks like.
 *
 * No I/O. No mutation. Each predicate either inspects a single record
 * or summarizes a collection.
 */

import type {
	FindingState,
	JurorVerdict,
	JuryFindingRecord,
	JuryPassId,
} from "./jury-record.js";

/** True when the finding is eligible for Pass 1 (synthesis on Pass 0 verdicts). */
export function shouldRunPass1(record: JuryFindingRecord): boolean {
	return (
		record.state === "proposed" &&
		hasVerdictsForPass(record, 0) &&
		!hasVerdictsForPass(record, 1)
	);
}

/** True when the finding is eligible for Pass 2 (prior-art enrichment). */
export function shouldRunPass2(record: JuryFindingRecord): boolean {
	return record.state === "promoted" && !hasVerdictsForPass(record, 2);
}

/**
 * True when the finding is eligible for Pass 3 (deep research). Pass 3
 * only runs after Pass 2 has committed its findings, so prior art
 * built on Pass 2's output isn't duplicated.
 */
export function shouldRunPass3(record: JuryFindingRecord): boolean {
	return (
		record.state === "promoted" &&
		hasVerdictsForPass(record, 2) &&
		!hasVerdictsForPass(record, 3)
	);
}

/**
 * True when the finding is eligible for Pass 8 (red-team adversarial
 * synthesis). Pass 8 runs against findings that survived through
 * Pass 3 and haven't already been pushed into a terminal state.
 *
 * The "haven't run yet" check is more subtle than for the other
 * passes: `synthesizePass8` leaves `state` unchanged on a
 * `RED-TEAM-INCONCLUSIVE` verdict so the orchestrator can re-run the
 * pass with adjusted context. If the latest Pass 8 verdict is
 * inconclusive (or there's no Pass 8 verdict yet) the record is
 * still eligible.
 */
export function shouldRunPass8(record: JuryFindingRecord): boolean {
	if (record.state !== "promoted") return false;
	if (!hasVerdictsForPass(record, 3)) return false;
	const latestPass8 = latestVerdictForPass(record, 8);
	if (!latestPass8) return true;
	return latestPass8.classification === "RED-TEAM-INCONCLUSIVE";
}

/**
 * True when the finding needs more context (Pass 1 came back
 * inconclusive on at least one juror). The orchestrator surfaces
 * needs-context findings to a recursive juror with extra evidence
 * before re-running Pass 1.
 */
export function shouldEscalateForContext(record: JuryFindingRecord): boolean {
	return record.state === "needs-context";
}

/**
 * True when the finding has reached a state from which no further
 * passes are scheduled. Terminal states are the two endpoints of the
 * funnel: `demoted` (rejected) and `red-team-survived` (fully
 * promoted through Pass 8).
 */
export function isTerminalState(state: FindingState): boolean {
	return state === "demoted" || state === "red-team-survived";
}

/** True when the record's state is terminal. */
export function isTerminal(record: JuryFindingRecord): boolean {
	return isTerminalState(record.state);
}

/**
 * Decide the next pass to run for `record`, or `null` when the record
 * is terminal / needs human input.
 *
 * Resolution order (lowest pass first):
 *   1 → 2 → 3 → 8
 *
 * Returns `null` for needs-context (orchestrator should surface for
 * human input, not auto-advance) and terminal states.
 */
export function nextPassFor(record: JuryFindingRecord): JuryPassId | null {
	if (isTerminal(record)) return null;
	if (shouldRunPass1(record)) return 1;
	if (shouldRunPass2(record)) return 2;
	if (shouldRunPass3(record)) return 3;
	if (shouldRunPass8(record)) return 8;
	return null;
}

/** Counts of records bucketed by terminal-state-vs-not. */
export interface FunnelCounts {
	/** Records still moving through passes (proposed, promoted, needs-context). */
	inFlight: number;
	/** Records that finished at `red-team-survived`. */
	survived: number;
	/** Records that finished at `demoted`. */
	demoted: number;
	/** Records still needing context (counted separately for orchestrator UX). */
	needsContext: number;
}

/**
 * Summarize a collection of records by state. Useful for "47 in
 * flight, 12 survived, 5 demoted, 3 need context" labels.
 */
export function funnelCounts(
	records: readonly JuryFindingRecord[],
): FunnelCounts {
	const counts: FunnelCounts = {
		inFlight: 0,
		survived: 0,
		demoted: 0,
		needsContext: 0,
	};
	for (const r of records) {
		if (r.state === "red-team-survived") {
			counts.survived += 1;
		} else if (r.state === "demoted") {
			counts.demoted += 1;
		} else if (r.state === "needs-context") {
			counts.needsContext += 1;
			counts.inFlight += 1;
		} else {
			counts.inFlight += 1;
		}
	}
	return counts;
}

/**
 * Partition records by `nextPassFor`. Useful when the orchestrator
 * wants to batch-dispatch all records that need the same pass.
 */
export function groupByNextPass(records: readonly JuryFindingRecord[]): {
	byPass: Map<JuryPassId, JuryFindingRecord[]>;
	terminal: JuryFindingRecord[];
	awaiting: JuryFindingRecord[];
} {
	const byPass = new Map<JuryPassId, JuryFindingRecord[]>();
	const terminal: JuryFindingRecord[] = [];
	const awaiting: JuryFindingRecord[] = [];
	for (const r of records) {
		if (isTerminal(r)) {
			terminal.push(r);
			continue;
		}
		const next = nextPassFor(r);
		if (next === null) {
			awaiting.push(r);
			continue;
		}
		const bucket = byPass.get(next);
		if (bucket) {
			bucket.push(r);
		} else {
			byPass.set(next, [r]);
		}
	}
	return { byPass, terminal, awaiting };
}

function hasVerdictsForPass(
	record: JuryFindingRecord,
	pass: JuryPassId,
): boolean {
	return record.verdicts.some((v) => v.pass === pass);
}

/**
 * Return the last verdict for `pass` in `record.verdicts` order, or
 * undefined when none exists. Order-by-array-position (not stampedAt)
 * so this stays in sync with `synthesizePass8` in `jury-record.ts`,
 * which picks the last Pass 8 verdict by array position too. If they
 * disagreed, the orchestrator could re-schedule Pass 8 against a
 * record synthesis already considered final, or skip a retry synthesis
 * still considered inconclusive.
 */
function latestVerdictForPass(
	record: JuryFindingRecord,
	pass: JuryPassId,
): JurorVerdict | undefined {
	for (let i = record.verdicts.length - 1; i >= 0; i -= 1) {
		const verdict = record.verdicts[i];
		if (verdict?.pass === pass) return verdict;
	}
	return undefined;
}
