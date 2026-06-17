/**
 * Validation contract progress reporter
 *
 * Builds on the validation contract primitive (part 1 of #2669, merged
 * as #2673). Given a contract and the current per-assertion status,
 * compute the structured progress shape the agent + UI + PR-body
 * renderer all consume:
 *
 *   - totals by status (pending / in-progress / passed / failed)
 *   - overall % complete (passed / total)
 *   - per-area breakdown with the same counters
 *   - up to N "next to do" assertions surfaced for the runner
 *   - failing assertions surfaced separately so the orchestrator can
 *     prioritize fixes
 *
 * Pure function over the contract type. No I/O, no PR-body integration.
 * The renderer + PR-body wiring ride in follow-up PRs.
 */

import type {
	Assertion,
	AssertionStatus,
	ContractArea,
	ValidationContract,
} from "./validation-contract.js";

/** Counts of assertions in each status bucket. */
export interface ContractStatusCounts {
	pending: number;
	"in-progress": number;
	passed: number;
	failed: number;
	/** Sum of all four — equals the total assertion count for the scope. */
	total: number;
}

/** Per-area breakdown inside the report. */
export interface ContractAreaProgress {
	name: string;
	counts: ContractStatusCounts;
	/** Passed / total, clamped to [0, 1]. `0` when total is 0. */
	percentComplete: number;
}

/** Pointer to one assertion shown in the queue. */
export interface AssertionPointer {
	/** Area this assertion belongs to. */
	areaName: string;
	/** Cross-area flow this assertion belongs to (when applicable). */
	flowName?: string;
	/** Stable assertion id. */
	id: string;
	/** Human-readable description. */
	description: string;
	/** Optional evidence stamp. */
	evidence?: string;
}

/** Top-level progress report. */
export interface ContractProgressReport {
	/** Schema version. */
	version: number;
	/** Stable contract identifier. */
	contractId: string;
	/** Aggregate counts across every area + cross-area flow. */
	counts: ContractStatusCounts;
	/** Passed / total, clamped to [0, 1]. `0` when total is 0. */
	percentComplete: number;
	/** Per-area breakdown, in contract order. */
	areas: ContractAreaProgress[];
	/** Cross-area flows, treated as their own "areas" for reporting. */
	flows: ContractAreaProgress[];
	/**
	 * The next set of pending / in-progress assertions to surface to
	 * the runner. Capped by `nextToDoLimit` (defaults to 10).
	 */
	nextToDo: AssertionPointer[];
	/**
	 * Every failing assertion, in contract order. The orchestrator uses
	 * this list to prioritize fixes before promoting more pending work.
	 */
	failing: AssertionPointer[];
}

export const CONTRACT_PROGRESS_VERSION = 1;

export interface BuildContractProgressOptions {
	/** Maximum size of `nextToDo`. Defaults to 10. */
	nextToDoLimit?: number;
}

/**
 * Compute a progress report for `contract`. Pure: derives every field
 * from the contract's own state — no external lookups.
 */
export function buildContractProgress(
	contract: ValidationContract,
	options: BuildContractProgressOptions = {},
): ContractProgressReport {
	const limit = options.nextToDoLimit ?? 10;
	if (!Number.isInteger(limit) || limit < 0) {
		throw new Error(
			`buildContractProgress: nextToDoLimit must be a non-negative integer, got ${limit}`,
		);
	}

	const overall = emptyCounts();
	const areas: ContractAreaProgress[] = contract.areas.map((area) => {
		const counts = countArea(area.assertions);
		mergeCounts(overall, counts);
		return {
			name: area.name,
			counts,
			percentComplete: percentComplete(counts),
		};
	});

	const flows: ContractAreaProgress[] = contract.crossAreaFlows.map((flow) => {
		const counts = countArea(flow.assertions);
		mergeCounts(overall, counts);
		return {
			name: flow.name,
			counts,
			percentComplete: percentComplete(counts),
		};
	});

	const nextToDo: AssertionPointer[] = [];
	const failing: AssertionPointer[] = [];
	for (const area of contract.areas) {
		for (const a of area.assertions) {
			if (a.status === "failed") {
				failing.push(toPointer(area.name, undefined, a));
			} else if (
				(a.status === "pending" || a.status === "in-progress") &&
				nextToDo.length < limit
			) {
				nextToDo.push(toPointer(area.name, undefined, a));
			}
		}
	}
	for (const flow of contract.crossAreaFlows) {
		for (const a of flow.assertions) {
			if (a.status === "failed") {
				failing.push(toPointer(flow.name, flow.name, a));
			} else if (
				(a.status === "pending" || a.status === "in-progress") &&
				nextToDo.length < limit
			) {
				nextToDo.push(toPointer(flow.name, flow.name, a));
			}
		}
	}

	return {
		version: CONTRACT_PROGRESS_VERSION,
		contractId: contract.id,
		counts: overall,
		percentComplete: percentComplete(overall),
		areas,
		flows,
		nextToDo,
		failing,
	};
}

function emptyCounts(): ContractStatusCounts {
	return { pending: 0, "in-progress": 0, passed: 0, failed: 0, total: 0 };
}

function countArea(assertions: readonly Assertion[]): ContractStatusCounts {
	const counts = emptyCounts();
	for (const a of assertions) {
		if (!isKnownStatus(a.status)) {
			throw new Error(
				`buildContractProgress: assertion "${a.id}" has unknown status "${String(
					a.status,
				)}"`,
			);
		}
		counts[a.status] += 1;
		counts.total += 1;
	}
	return counts;
}

function mergeCounts(
	target: ContractStatusCounts,
	source: ContractStatusCounts,
): void {
	target.pending += source.pending;
	target["in-progress"] += source["in-progress"];
	target.passed += source.passed;
	target.failed += source.failed;
	target.total += source.total;
}

function percentComplete(counts: ContractStatusCounts): number {
	if (counts.total === 0) return 0;
	const ratio = counts.passed / counts.total;
	if (ratio < 0) return 0;
	if (ratio > 1) return 1;
	return ratio;
}

function toPointer(
	areaName: string,
	flowName: string | undefined,
	assertion: Assertion,
): AssertionPointer {
	const pointer: AssertionPointer = {
		areaName,
		id: assertion.id,
		description: assertion.description,
	};
	if (flowName !== undefined) pointer.flowName = flowName;
	if (assertion.evidence !== undefined) pointer.evidence = assertion.evidence;
	return pointer;
}

function isKnownStatus(status: unknown): status is AssertionStatus {
	return (
		status === "pending" ||
		status === "in-progress" ||
		status === "passed" ||
		status === "failed"
	);
}

/**
 * Convenience helper: filter areas that are 100% complete out of the
 * report's `areas` list. The UI uses this to collapse finished sections
 * so the reviewer's eye lands on incomplete work.
 */
export function unfinishedAreas(
	report: ContractProgressReport,
): ContractAreaProgress[] {
	return report.areas.filter(
		(a) => a.counts.total > 0 && a.percentComplete < 1,
	);
}

/**
 * Convenience helper: same idea for cross-area flows. Returns flows
 * that have at least one assertion and are not 100% complete.
 */
export function unfinishedFlows(
	report: ContractProgressReport,
): ContractAreaProgress[] {
	return report.flows.filter(
		(f) => f.counts.total > 0 && f.percentComplete < 1,
	);
}

/**
 * Type guard for narrowing area arrays from external sources (e.g.
 * tests that build areas inline). Surface for the renderer in the
 * follow-up PR.
 */
export function isContractArea(value: unknown): value is ContractArea {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return typeof v.name === "string" && Array.isArray(v.assertions);
}
