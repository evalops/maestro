/**
 * Validation contract diff
 *
 * Builds on the validation contract primitive (part 1 of #2669,
 * merged as #2673) and the progress reporter (part 2, #2688). Given
 * two contracts, return a structured diff: which assertions were
 * added, removed, modified (description or status changed), or
 * moved to a different area.
 *
 * Used by:
 *   - PR review when someone edits a contract: reviewers need to see
 *     what changed without diffing the JSON by hand
 *   - the orchestrator UI when comparing "what's in the contract now"
 *     vs "what was claimed by the feature manifest"
 *   - audit / regression analysis ("did this contract change between
 *     v1.0 and v1.1?")
 *
 * Pure function over the contract type. No I/O.
 */

import type {
	Assertion,
	AssertionStatus,
	ContractArea,
	CrossAreaFlow,
	ValidationContract,
} from "./validation-contract.js";

/** An assertion that exists in both contracts and changed in some way. */
export interface ModifiedAssertion {
	id: string;
	/** Surface (area name or flow name) the assertion sits in. */
	surface: string;
	/** Field that changed; only populated fields are set. */
	descriptionChanged?: { from: string; to: string };
	statusChanged?: { from: AssertionStatus; to: AssertionStatus };
	evidenceChanged?: { from: string | undefined; to: string | undefined };
	movedToSurface?: { from: string; to: string };
}

/** An assertion that exists in only one of the two contracts. */
export interface SingleSidedAssertion {
	id: string;
	/** Surface (area name or flow name) the assertion sits in. */
	surface: string;
	description: string;
	status: AssertionStatus;
}

/** Result of `diffContracts`. */
export interface ContractDiff {
	added: SingleSidedAssertion[];
	removed: SingleSidedAssertion[];
	modified: ModifiedAssertion[];
	/**
	 * Aggregate counters so callers can show "5 added, 3 removed, 12
	 * modified" labels without re-counting.
	 */
	summary: {
		addedCount: number;
		removedCount: number;
		modifiedCount: number;
	};
}

/**
 * Compute the assertion-level diff between two contracts. Output
 * lists are sorted by assertion id ascending so diffs are stable
 * regardless of input ordering.
 */
export function diffContracts(
	from: ValidationContract,
	to: ValidationContract,
): ContractDiff {
	const fromIndex = indexAssertions(from);
	const toIndex = indexAssertions(to);

	const added: SingleSidedAssertion[] = [];
	const removed: SingleSidedAssertion[] = [];
	const modified: ModifiedAssertion[] = [];

	for (const [id, fromEntry] of fromIndex) {
		const toEntry = toIndex.get(id);
		if (!toEntry) {
			removed.push({
				id,
				surface: fromEntry.surface,
				description: fromEntry.assertion.description,
				status: fromEntry.assertion.status,
			});
			continue;
		}
		const mod = compareAssertion(id, fromEntry, toEntry);
		if (mod) modified.push(mod);
	}
	for (const [id, toEntry] of toIndex) {
		if (!fromIndex.has(id)) {
			added.push({
				id,
				surface: toEntry.surface,
				description: toEntry.assertion.description,
				status: toEntry.assertion.status,
			});
		}
	}

	added.sort(byId);
	removed.sort(byId);
	modified.sort(byId);

	return {
		added,
		removed,
		modified,
		summary: {
			addedCount: added.length,
			removedCount: removed.length,
			modifiedCount: modified.length,
		},
	};
}

/**
 * True when the two contracts have identical assertion sets +
 * descriptions + statuses + evidence + surface placement. Convenient
 * shortcut around `diffContracts` returning empty lists.
 */
export function contractsEqual(
	from: ValidationContract,
	to: ValidationContract,
): boolean {
	const diff = diffContracts(from, to);
	return (
		diff.added.length === 0 &&
		diff.removed.length === 0 &&
		diff.modified.length === 0
	);
}

interface IndexedAssertion {
	assertion: Assertion;
	surface: string;
	/** Internal placement key so same-named surfaces still compare distinctly. */
	placement: string;
}

function indexAssertions(
	contract: ValidationContract,
): Map<string, IndexedAssertion> {
	const map = new Map<string, IndexedAssertion>();
	const areaPlacements = new Map<string, number>();
	for (const area of contract.areas) {
		addArea(map, area, nextSurfaceOccurrence(areaPlacements, area.name));
	}
	const flowPlacements = new Map<string, number>();
	for (const flow of contract.crossAreaFlows) {
		addFlow(map, flow, nextSurfaceOccurrence(flowPlacements, flow.name));
	}
	return map;
}

function addArea(
	map: Map<string, IndexedAssertion>,
	area: ContractArea,
	occurrence: number,
): void {
	for (const assertion of area.assertions) {
		if (!map.has(assertion.id)) {
			map.set(assertion.id, {
				assertion,
				surface: area.name,
				placement: surfacePlacement("area", area.name, occurrence),
			});
		}
	}
}

function addFlow(
	map: Map<string, IndexedAssertion>,
	flow: CrossAreaFlow,
	occurrence: number,
): void {
	for (const assertion of flow.assertions) {
		if (!map.has(assertion.id)) {
			map.set(assertion.id, {
				assertion,
				surface: flow.name,
				placement: surfacePlacement("flow", flow.name, occurrence),
			});
		}
	}
}

function nextSurfaceOccurrence(
	placements: Map<string, number>,
	surfaceName: string,
): number {
	const occurrence = placements.get(surfaceName) ?? 0;
	placements.set(surfaceName, occurrence + 1);
	return occurrence;
}

function surfacePlacement(
	kind: "area" | "flow",
	surfaceName: string,
	occurrence: number,
): string {
	return `${kind}:${surfaceName}:${occurrence}`;
}

function compareAssertion(
	id: string,
	fromEntry: IndexedAssertion,
	toEntry: IndexedAssertion,
): ModifiedAssertion | null {
	const from = fromEntry.assertion;
	const to = toEntry.assertion;
	const changes: ModifiedAssertion = {
		id,
		surface: toEntry.surface,
	};
	let touched = false;
	if (from.description !== to.description) {
		changes.descriptionChanged = {
			from: from.description,
			to: to.description,
		};
		touched = true;
	}
	if (from.status !== to.status) {
		changes.statusChanged = { from: from.status, to: to.status };
		touched = true;
	}
	if (from.evidence !== to.evidence) {
		changes.evidenceChanged = { from: from.evidence, to: to.evidence };
		touched = true;
	}
	if (fromEntry.placement !== toEntry.placement) {
		changes.movedToSurface = {
			from: fromEntry.surface,
			to: toEntry.surface,
		};
		touched = true;
	}
	return touched ? changes : null;
}

function byId(a: { id: string }, b: { id: string }): number {
	if (a.id === b.id) return 0;
	return a.id < b.id ? -1 : 1;
}
