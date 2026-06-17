/**
 * Snapshot manifest pruning policy
 *
 * Builds on the session snapshot manifest (part 1 of #2657, merged
 * as #2679) and its byte-budget `planEviction` helper. Pure
 * decision-layer that combines multiple pruning signals — byte
 * budget, age limit, boundary count limit, pinned indices — into a
 * single `PruningPlan` the manifest's `applyEvictionPlan` can
 * consume.
 *
 * Why a separate module:
 *   `planEviction` answers "given a byte budget, how many old
 *   boundaries do we drop?" and nothing else. Real callers want
 *   "keep at most 100 boundaries, drop anything older than 24h,
 *   never drop boundaries the user pinned, but also stay under 500
 *   MB". Composing those rules every site is repetitive and easy to
 *   get wrong.
 *
 * Pure function. No I/O.
 */

import type { SessionSnapshotManifestData } from "./snapshot-manifest.js";

/**
 * Rules that decide which boundaries to evict. All fields are
 * optional; an empty policy is a no-op. Multiple fields combine with
 * "the most aggressive rule wins" — the number of boundaries pruned
 * is the maximum any single rule would prune, subject to the pinned
 * + minimum-retention guards.
 */
export interface SnapshotPruningPolicy {
	/** Drop boundaries to bring totalBytes ≤ maxBytes. */
	maxBytes?: number;
	/** Drop boundaries whose `createdAt` is older than `now - maxAgeMs`. */
	maxAgeMs?: number;
	/** Cap the retained boundary count at this number. */
	maxBoundaries?: number;
	/**
	 * Never drop below this many boundaries even if other rules say
	 * "more". Defaults to 1 so callers don't accidentally empty the
	 * manifest.
	 */
	minBoundaries?: number;
	/**
	 * Boundary indices the caller wants to keep regardless of policy
	 * (e.g. the boundary the user is about to rewind to). Pruning
	 * stops at the oldest pinned boundary.
	 */
	pinnedIndices?: readonly number[];
}

export interface PruningPlan {
	/** Number of oldest boundaries to drop. */
	dropCount: number;
	/** Which rule(s) triggered the drop; useful for telemetry / UI. */
	reasons: PruningReason[];
}

export type PruningReason =
	| "bytes-over-budget"
	| "age-over-limit"
	| "count-over-limit"
	| "pinned-floor"
	| "min-boundaries-floor";

/**
 * Decide how many oldest boundaries to evict from `manifest` to
 * satisfy `policy`. Returns the drop count + the rule(s) that drove
 * the decision.
 */
export function planPruning(
	manifest: SessionSnapshotManifestData,
	policy: SnapshotPruningPolicy,
	nowIso: string = new Date().toISOString(),
): PruningPlan {
	const reasons = new Set<PruningReason>();
	const boundaries = manifest.boundaries;
	if (boundaries.length === 0) {
		return { dropCount: 0, reasons: [] };
	}
	const minBoundaries = Math.max(1, policy.minBoundaries ?? 1);
	const pinned = new Set(policy.pinnedIndices ?? []);

	// Each rule independently computes "drop the first N boundaries"
	// then we take the max so multiple violated rules don't have to
	// be applied serially.
	let proposedDrop = 0;

	if (typeof policy.maxBytes === "number") {
		const sizes = boundaries.map(boundaryBytes);
		const maxBytes = Math.max(0, policy.maxBytes);
		let totalBytes = sizes.reduce((a, b) => a + b, 0);
		let drop = 0;
		while (drop < sizes.length && totalBytes > maxBytes) {
			totalBytes -= sizes[drop] ?? 0;
			drop += 1;
		}
		if (drop > proposedDrop) {
			proposedDrop = drop;
			reasons.add("bytes-over-budget");
		} else if (drop > 0) {
			reasons.add("bytes-over-budget");
		}
	}

	if (typeof policy.maxAgeMs === "number") {
		const cutoff = parseIsoMillis(nowIso) - Math.max(0, policy.maxAgeMs);
		let drop = 0;
		for (const boundary of boundaries) {
			const created = parseIsoMillis(boundary.createdAt);
			if (created >= cutoff) break;
			drop += 1;
		}
		if (drop > proposedDrop) {
			proposedDrop = drop;
			reasons.add("age-over-limit");
		} else if (drop > 0) {
			reasons.add("age-over-limit");
		}
	}

	if (typeof policy.maxBoundaries === "number") {
		const drop = Math.max(
			0,
			boundaries.length - Math.max(0, policy.maxBoundaries),
		);
		if (drop > proposedDrop) {
			proposedDrop = drop;
			reasons.add("count-over-limit");
		} else if (drop > 0) {
			reasons.add("count-over-limit");
		}
	}

	// Floor #1: never drop below minBoundaries.
	const minFloor = Math.max(0, boundaries.length - minBoundaries);
	if (proposedDrop > minFloor) {
		proposedDrop = minFloor;
		reasons.add("min-boundaries-floor");
	}

	// Floor #2: never drop a pinned boundary or anything before it.
	if (pinned.size > 0) {
		let pinnedCeiling = proposedDrop;
		for (let i = 0; i < boundaries.length && i < proposedDrop; i += 1) {
			const boundary = boundaries[i];
			if (!boundary) break;
			if (pinned.has(boundary.index)) {
				pinnedCeiling = i;
				break;
			}
		}
		if (pinnedCeiling < proposedDrop) {
			proposedDrop = pinnedCeiling;
			reasons.add("pinned-floor");
		}
	}

	return {
		dropCount: proposedDrop,
		reasons: reasonsInOrder(reasons),
	};
}

/**
 * True when the policy would prune at least one boundary right now.
 * Convenience for "should I run pruning?" gates that don't need the
 * full plan.
 */
export function pruningRequired(
	manifest: SessionSnapshotManifestData,
	policy: SnapshotPruningPolicy,
	nowIso?: string,
): boolean {
	return planPruning(manifest, policy, nowIso).dropCount > 0;
}

function boundaryBytes(
	boundary: SessionSnapshotManifestData["boundaries"][0],
): number {
	if (typeof boundary.totalSize === "number") return boundary.totalSize;
	return boundary.files.reduce((s, f) => s + f.size, 0);
}

function parseIsoMillis(iso: string): number {
	const value = Date.parse(iso);
	return Number.isFinite(value) ? value : 0;
}

function reasonsInOrder(reasons: Set<PruningReason>): PruningReason[] {
	const order: PruningReason[] = [
		"bytes-over-budget",
		"age-over-limit",
		"count-over-limit",
		"min-boundaries-floor",
		"pinned-floor",
	];
	return order.filter((r) => reasons.has(r));
}
