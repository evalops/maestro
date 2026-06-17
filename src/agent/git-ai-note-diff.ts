/**
 * AgentNote diff helper
 *
 * Builds on the git-ai-note primitive (part 1 of #2666, merged as
 * #2676). Pure helper that computes a structured changelog between
 * two versions of an `AgentNote` so the orchestrator UI, audit log,
 * and PR comment renderer can show "what changed when the note was
 * amended" without each surface re-deriving the comparison.
 *
 * The diff is field-level. For string fields (intent, commitSha,
 * provenance.modelId, etc) we emit a single `{ before, after }`
 * record per field that changed. For the list-shaped fields
 * (evidence, followUps) we emit `added` / `removed` lists keyed on
 * the natural identity of each entry (the string itself for
 * evidence, `title` for follow-ups so reviewers can rename a
 * follow-up's body without it counting as a remove+add).
 *
 * Pure function. No I/O.
 */

import type {
	AgentNote,
	AgentNoteFollowUp,
	AgentNoteProvenance,
} from "./git-ai-note.js";

export interface FieldChange<T> {
	before: T | undefined;
	after: T | undefined;
}

export interface FollowUpChange {
	title: string;
	before?: AgentNoteFollowUp;
	after?: AgentNoteFollowUp;
}

export interface AgentNoteDiff {
	/** True when the two notes are byte-equal at every diffed field. */
	unchanged: boolean;
	commitSha?: FieldChange<string>;
	intent?: FieldChange<string>;
	evidence: { added: string[]; removed: string[] };
	followUps: {
		added: AgentNoteFollowUp[];
		removed: AgentNoteFollowUp[];
		changed: FollowUpChange[];
	};
	provenance: {
		modelId?: FieldChange<string>;
		sessionId?: FieldChange<string>;
		agentVersion?: FieldChange<string>;
		createdAt?: FieldChange<string>;
	};
	version?: FieldChange<number>;
}

/**
 * Compute the structured diff between `before` and `after`. Pass
 * `undefined` for `before` when `after` is a freshly-created note —
 * the diff will surface every field as an addition.
 */
export function diffAgentNotes(
	before: AgentNote | undefined,
	after: AgentNote | undefined,
): AgentNoteDiff {
	if (!before && !after) {
		return emptyDiff();
	}
	const diff = emptyDiff();
	const a = after;
	const b = before;

	const aCommitSha = a?.commitSha;
	const bCommitSha = b?.commitSha;
	if (aCommitSha !== bCommitSha) {
		diff.commitSha = { before: bCommitSha, after: aCommitSha };
	}

	const aIntent = a?.intent;
	const bIntent = b?.intent;
	if (aIntent !== bIntent) {
		diff.intent = { before: bIntent, after: aIntent };
	}

	const aVersion = a?.version;
	const bVersion = b?.version;
	if (aVersion !== bVersion) {
		diff.version = { before: bVersion, after: aVersion };
	}

	diff.evidence = diffStringList(b?.evidence ?? [], a?.evidence ?? []);
	diff.followUps = diffFollowUps(b?.followUps ?? [], a?.followUps ?? []);
	diff.provenance = diffProvenance(b?.provenance, a?.provenance);

	diff.unchanged = isNoOpDiff(diff);
	return diff;
}

function diffStringList(
	before: readonly string[],
	after: readonly string[],
): { added: string[]; removed: string[] } {
	const beforeRemaining = countStrings(before);
	const added: string[] = [];
	for (const item of after) {
		const priorCount = beforeRemaining.get(item) ?? 0;
		if (priorCount > 0) {
			beforeRemaining.set(item, priorCount - 1);
		} else {
			added.push(item);
		}
	}
	const afterRemaining = countStrings(after);
	const removed: string[] = [];
	for (const item of before) {
		const afterCount = afterRemaining.get(item) ?? 0;
		if (afterCount > 0) {
			afterRemaining.set(item, afterCount - 1);
		} else {
			removed.push(item);
		}
	}
	return { added, removed };
}

function countStrings(items: readonly string[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const item of items) {
		counts.set(item, (counts.get(item) ?? 0) + 1);
	}
	return counts;
}

function diffFollowUps(
	before: readonly AgentNoteFollowUp[],
	after: readonly AgentNoteFollowUp[],
): {
	added: AgentNoteFollowUp[];
	removed: AgentNoteFollowUp[];
	changed: FollowUpChange[];
} {
	const beforeByTitle = groupFollowUpsByTitle(before);
	const afterByTitle = groupFollowUpsByTitle(after);
	const titles = new Set([...beforeByTitle.keys(), ...afterByTitle.keys()]);

	const added: Array<{ index: number; followUp: AgentNoteFollowUp }> = [];
	const removed: Array<{ index: number; followUp: AgentNoteFollowUp }> = [];
	const changed: Array<{ index: number; change: FollowUpChange }> = [];
	for (const title of titles) {
		const beforeGroup = beforeByTitle.get(title) ?? [];
		const afterGroup = afterByTitle.get(title) ?? [];
		const matchedBefore = new Set<number>();
		const matchedAfter = new Set<number>();

		// Prefer exact matches first so duplicate titles do not turn a
		// keep+remove into a spurious "changed" entry.
		for (let afterIndex = 0; afterIndex < afterGroup.length; afterIndex += 1) {
			const next = afterGroup[afterIndex];
			if (!next) continue;
			const priorIndex = beforeGroup.findIndex(
				(candidate, index) =>
					!matchedBefore.has(index) &&
					followUpsEqual(candidate.followUp, next.followUp),
			);
			if (priorIndex === -1) continue;
			matchedBefore.add(priorIndex);
			matchedAfter.add(afterIndex);
		}

		const unmatchedBefore = beforeGroup.filter(
			(_, index) => !matchedBefore.has(index),
		);
		const unmatchedAfter = afterGroup.filter(
			(_, index) => !matchedAfter.has(index),
		);
		const canPairUnmatchedAsChanged =
			matchedBefore.size > 0 ||
			unmatchedBefore.length === unmatchedAfter.length;

		const pairedEntries = canPairUnmatchedAsChanged
			? pairFollowUpsByCost(unmatchedBefore, unmatchedAfter)
			: [];
		const pairedBefore = new Set(
			pairedEntries.map((entry) => entry.before.index),
		);
		const pairedAfter = new Set(
			pairedEntries.map((entry) => entry.after.index),
		);

		if (canPairUnmatchedAsChanged) {
			for (const entry of pairedEntries) {
				const { before: prior, after: next } = entry;
				if (followUpsEqual(prior.followUp, next.followUp)) continue;
				changed.push({
					index: next.index,
					change: { title, before: prior.followUp, after: next.followUp },
				});
			}
		}
		for (const next of unmatchedAfter) {
			if (pairedAfter.has(next.index)) continue;
			added.push(next);
		}
		for (const prior of unmatchedBefore) {
			if (pairedBefore.has(prior.index)) continue;
			removed.push(prior);
		}
	}
	return {
		added: added
			.sort((a, b) => a.index - b.index)
			.map((entry) => entry.followUp),
		removed: removed
			.sort((a, b) => a.index - b.index)
			.map((entry) => entry.followUp),
		changed: changed
			.sort((a, b) => a.index - b.index)
			.map((entry) => entry.change),
	};
}

type IndexedFollowUp = {
	index: number;
	followUp: AgentNoteFollowUp;
};

function pairFollowUpsByCost(
	before: readonly IndexedFollowUp[],
	after: readonly IndexedFollowUp[],
): Array<{ before: IndexedFollowUp; after: IndexedFollowUp }> {
	if (before.length === 0 || after.length === 0) return [];

	if (before.length >= after.length) {
		const beforeIndexes = chooseBestPairingIndexes(before, after);
		return beforeIndexes.map((beforeIndex, afterIndex) => ({
			before: before[beforeIndex]!,
			after: after[afterIndex]!,
		}));
	}

	const afterIndexes = chooseBestPairingIndexes(after, before);
	return afterIndexes.map((afterIndex, beforeIndex) => ({
		before: before[beforeIndex]!,
		after: after[afterIndex]!,
	}));
}

function chooseBestPairingIndexes(
	longer: readonly IndexedFollowUp[],
	shorter: readonly IndexedFollowUp[],
): number[] {
	const costs = Array.from({ length: longer.length + 1 }, () =>
		Array.from({ length: shorter.length + 1 }, () => Number.POSITIVE_INFINITY),
	);

	for (let longerIndex = 0; longerIndex <= longer.length; longerIndex += 1) {
		costs[longerIndex]![0] = 0;
	}

	for (let longerIndex = 1; longerIndex <= longer.length; longerIndex += 1) {
		const longerEntry = longer[longerIndex - 1];
		if (!longerEntry) continue;
		for (
			let shorterIndex = 1;
			shorterIndex <= Math.min(longerIndex, shorter.length);
			shorterIndex += 1
		) {
			const shorterEntry = shorter[shorterIndex - 1];
			if (!shorterEntry) continue;
			const skipLonger = costs[longerIndex - 1]?.[shorterIndex];
			const pairEntries =
				(costs[longerIndex - 1]?.[shorterIndex - 1] ??
					Number.POSITIVE_INFINITY) +
				followUpPairingCost(longerEntry.followUp, shorterEntry.followUp);
			costs[longerIndex]![shorterIndex] = Math.min(
				skipLonger ?? Number.POSITIVE_INFINITY,
				pairEntries,
			);
		}
	}

	const pairs: number[] = [];
	let longerIndex = longer.length;
	let shorterIndex = shorter.length;
	while (shorterIndex > 0 && longerIndex > 0) {
		const longerEntry = longer[longerIndex - 1];
		const shorterEntry = shorter[shorterIndex - 1];
		const pairEntries =
			(costs[longerIndex - 1]?.[shorterIndex - 1] ?? Number.POSITIVE_INFINITY) +
			(longerEntry && shorterEntry
				? followUpPairingCost(longerEntry.followUp, shorterEntry.followUp)
				: Number.POSITIVE_INFINITY);
		if (
			longerEntry &&
			shorterEntry &&
			costs[longerIndex]?.[shorterIndex] === pairEntries
		) {
			pairs.unshift(longerIndex - 1);
			longerIndex -= 1;
			shorterIndex -= 1;
			continue;
		}
		longerIndex -= 1;
	}

	return pairs;
}

function groupFollowUpsByTitle(
	followUps: readonly AgentNoteFollowUp[],
): Map<string, Array<{ index: number; followUp: AgentNoteFollowUp }>> {
	const groups = new Map<
		string,
		Array<{ index: number; followUp: AgentNoteFollowUp }>
	>();
	for (const [index, followUp] of followUps.entries()) {
		const title = effectiveTitle(followUp);
		const existing = groups.get(title);
		const entry = { index, followUp };
		if (existing) {
			existing.push(entry);
		} else {
			groups.set(title, [entry]);
		}
	}
	return groups;
}

function followUpPairingCost(
	a: AgentNoteFollowUp,
	b: AgentNoteFollowUp,
): number {
	return (
		stringEditDistance(effectiveDetail(a) ?? "", effectiveDetail(b) ?? "") +
		(effectiveSeverity(a) === effectiveSeverity(b) ? 0 : 1)
	);
}

function diffProvenance(
	before: AgentNoteProvenance | undefined,
	after: AgentNoteProvenance | undefined,
): AgentNoteDiff["provenance"] {
	const result: AgentNoteDiff["provenance"] = {};
	const fields = ["modelId", "sessionId", "agentVersion", "createdAt"] as const;
	for (const field of fields) {
		const bVal = before?.[field];
		const aVal = after?.[field];
		if (bVal !== aVal) {
			result[field] = { before: bVal, after: aVal };
		}
	}
	return result;
}

function followUpsEqual(a: AgentNoteFollowUp, b: AgentNoteFollowUp): boolean {
	// makeAgentNote normalizes a missing severity to "info"; a parsed
	// note keeps it absent. Treat the two as the same so diffing a
	// parsed note against a freshly-built one doesn't flag every
	// follow-up as "changed".
	return (
		effectiveTitle(a) === effectiveTitle(b) &&
		effectiveDetail(a) === effectiveDetail(b) &&
		effectiveSeverity(a) === effectiveSeverity(b)
	);
}

function effectiveTitle(followUp: AgentNoteFollowUp): string {
	return followUp.title.trim();
}

function effectiveDetail(followUp: AgentNoteFollowUp): string | undefined {
	const detail = followUp.detail?.trim();
	return detail ? detail : undefined;
}

function effectiveSeverity(
	followUp: AgentNoteFollowUp,
): "info" | "watch" | "risk" {
	return followUp.severity ?? "info";
}

function stringEditDistance(a: string, b: string): number {
	if (a === b) return 0;
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;

	const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
	const current = new Array<number>(b.length + 1).fill(0);

	for (let aIndex = 1; aIndex <= a.length; aIndex += 1) {
		current[0] = aIndex;
		for (let bIndex = 1; bIndex <= b.length; bIndex += 1) {
			const substitutionCost = a[aIndex - 1] === b[bIndex - 1] ? 0 : 1;
			current[bIndex] = Math.min(
				(current[bIndex - 1] ?? Number.POSITIVE_INFINITY) + 1,
				(previous[bIndex] ?? Number.POSITIVE_INFINITY) + 1,
				(previous[bIndex - 1] ?? Number.POSITIVE_INFINITY) + substitutionCost,
			);
		}
		for (let index = 0; index <= b.length; index += 1) {
			previous[index] = current[index] ?? Number.POSITIVE_INFINITY;
		}
	}

	return previous[b.length] ?? Number.POSITIVE_INFINITY;
}

function emptyDiff(): AgentNoteDiff {
	return {
		unchanged: true,
		evidence: { added: [], removed: [] },
		followUps: { added: [], removed: [], changed: [] },
		provenance: {},
	};
}

function isNoOpDiff(diff: AgentNoteDiff): boolean {
	if (diff.commitSha) return false;
	if (diff.intent) return false;
	if (diff.version) return false;
	if (diff.evidence.added.length > 0) return false;
	if (diff.evidence.removed.length > 0) return false;
	if (diff.followUps.added.length > 0) return false;
	if (diff.followUps.removed.length > 0) return false;
	if (diff.followUps.changed.length > 0) return false;
	if (Object.keys(diff.provenance).length > 0) return false;
	return true;
}

/**
 * Summarize a diff into a single "12 evidence added, 1 follow-up
 * removed" line for status bars and PR badges.
 */
export function summarizeAgentNoteDiff(diff: AgentNoteDiff): string {
	if (diff.unchanged) return "no changes";
	const parts: string[] = [];
	if (diff.intent) parts.push("intent changed");
	if (diff.commitSha) parts.push("commitSha changed");
	const evAdded = diff.evidence.added.length;
	const evRemoved = diff.evidence.removed.length;
	if (evAdded > 0)
		parts.push(`${evAdded} evidence ${plural("entry", evAdded)} added`);
	if (evRemoved > 0)
		parts.push(`${evRemoved} evidence ${plural("entry", evRemoved)} removed`);
	const fAdded = diff.followUps.added.length;
	const fRemoved = diff.followUps.removed.length;
	const fChanged = diff.followUps.changed.length;
	if (fAdded > 0) parts.push(`${fAdded} follow-${plural("up", fAdded)} added`);
	if (fRemoved > 0)
		parts.push(`${fRemoved} follow-${plural("up", fRemoved)} removed`);
	if (fChanged > 0)
		parts.push(`${fChanged} follow-${plural("up", fChanged)} changed`);
	const provFields = Object.keys(diff.provenance);
	if (provFields.length > 0) {
		parts.push(`provenance: ${provFields.sort().join(", ")}`);
	}
	if (diff.version) parts.push("version bumped");
	return parts.join(" · ") || "no changes";
}

function plural(singular: string, count: number): string {
	if (count === 1) return singular;
	if (singular === "up") return "ups";
	if (singular === "entry") return "entries";
	return `${singular}s`;
}
