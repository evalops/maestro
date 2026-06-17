/**
 * Snapshot manifest rewind plan
 *
 * Builds on the session snapshot manifest primitive (part 1 of #2657,
 * merged as #2679) and the diff helper (#2694). Given a target
 * boundary index, compute the ordered file operations that would
 * restore the workspace to the state at that boundary.
 *
 * The plan is purely declarative — it says *what* to do, not how. A
 * later PR will hand the plan to a content-addressed store and walk
 * it (writing files by sha, deleting paths, etc).
 *
 * Operations are emitted in a safe order so a naive caller can
 * execute them without dependency-tracking:
 *
 *   1. `delete` — every file that exists "now" (after the latest
 *      boundary) but shouldn't exist at the target. Doing these
 *      first means the writes that follow can't trip filesystem
 *      conflicts.
 *   2. `restore` — every file that exists at the target and either
 *      doesn't exist now or has a different content hash. The
 *      `contentSha256` points the executor at the right blob.
 *
 * Throws when the target index is out of range or has been evicted.
 * Pure function over the manifest type.
 */

import type {
	FileSnapshot,
	MessageBoundarySnapshot,
	SessionSnapshotManifestData,
} from "./snapshot-manifest.js";

/** One step in the rewind plan. */
export type RewindOp = RewindRestoreOp | RewindDeleteOp;

/** Write the named file with the contents identified by `contentSha256`. */
export interface RewindRestoreOp {
	kind: "restore";
	path: string;
	contentSha256: string;
	/** Decompressed byte length of the file the executor is responsible for. */
	size: number;
}

/** Delete the named file from the workspace. */
export interface RewindDeleteOp {
	kind: "delete";
	path: string;
}

/** Output of `planRewind`. */
export interface RewindPlan {
	/** Boundary the workspace will land at after the ops execute. */
	targetIndex: number;
	/** Boundary the workspace currently reflects (the latest in `boundaries`). */
	fromIndex: number;
	/** Ordered operations the executor walks. */
	ops: RewindOp[];
	/** Counters mirroring the op list for label / metrics use. */
	summary: {
		restoreCount: number;
		deleteCount: number;
		bytesRestored: number;
	};
}

/**
 * Compute the rewind plan to move the workspace from the manifest's
 * latest boundary back to `targetIndex`.
 *
 * Throws when:
 *   - `boundaries` is empty (nothing to rewind from / to)
 *   - `targetIndex` is older than `oldestAvailableBoundaryIndex`
 *     (evicted — content no longer addressable)
 *   - `targetIndex` is newer than the latest stored boundary
 *
 * If `targetIndex` equals the latest boundary the plan is empty only
 * when the latest turn made no file creations/deletions.
 */
export function planRewind(
	manifest: SessionSnapshotManifestData,
	targetIndex: number,
): RewindPlan {
	if (manifest.boundaries.length === 0) {
		throw new Error("planRewind: manifest has no boundaries");
	}
	const latest = manifest.boundaries[manifest.boundaries.length - 1];
	// Use the manifest's own eviction field — not boundaries[0].index —
	// so the eviction guard agrees with `findBoundaryByIndex` in
	// snapshot-manifest.ts. Eviction can advance
	// oldestAvailableBoundaryIndex past boundaries[0].index briefly
	// (e.g. mid-trim); the manifest field is the authoritative
	// reference.
	const oldestAvailable = manifest.oldestAvailableBoundaryIndex;
	if (!latest) {
		throw new Error("planRewind: manifest has no boundaries");
	}
	if (targetIndex < oldestAvailable) {
		throw new Error(
			`planRewind: target boundary ${targetIndex} has been evicted (oldest available is ${oldestAvailable})`,
		);
	}
	if (targetIndex > latest.index) {
		throw new Error(
			`planRewind: target boundary ${targetIndex} is newer than the latest stored boundary (${latest.index})`,
		);
	}
	const targetOffset = manifest.boundaries.findIndex(
		(b) => b.index === targetIndex,
	);
	const target =
		targetOffset >= 0 ? manifest.boundaries[targetOffset] : undefined;
	if (!target) {
		// Defensive — boundaries are dense within the kept range so
		// the find should always succeed.
		throw new Error(
			`planRewind: target boundary ${targetIndex} not found in manifest`,
		);
	}

	const currentByPath = indexCurrentWorkspaceByPath(latest);
	const targetByPath = indexTargetWorkspaceByPath(
		target,
		manifest.boundaries[targetOffset + 1],
	);

	const deletes: RewindDeleteOp[] = [];
	for (const [path] of currentByPath) {
		if (!targetByPath.has(path)) {
			deletes.push({ kind: "delete", path });
		}
	}
	deletes.sort(byPath);

	const restores: RewindRestoreOp[] = [];
	for (const [path, file] of targetByPath) {
		if (!file) {
			continue;
		}
		const current = currentByPath.get(path);
		if (!current || current.contentSha256 !== file.contentSha256) {
			restores.push({
				kind: "restore",
				path,
				contentSha256: file.contentSha256,
				size: file.size,
			});
		}
	}
	restores.sort(byPath);

	const ops: RewindOp[] = [...deletes, ...restores];
	const bytesRestored = restores.reduce((n, r) => n + r.size, 0);

	return {
		targetIndex,
		fromIndex: latest.index,
		ops,
		summary: {
			restoreCount: restores.length,
			deleteCount: deletes.length,
			bytesRestored,
		},
	};
}

/**
 * True when the manifest can rewind to the given index (no eviction,
 * not in the future). Convenience predicate for UI guards.
 */
export function canRewindTo(
	manifest: SessionSnapshotManifestData,
	targetIndex: number,
): boolean {
	if (manifest.boundaries.length === 0) return false;
	const latest = manifest.boundaries[manifest.boundaries.length - 1];
	if (!latest) return false;
	return (
		targetIndex >= manifest.oldestAvailableBoundaryIndex &&
		targetIndex <= latest.index
	);
}

/**
 * Look up the boundary at `targetIndex`, returning `undefined` when
 * it's been evicted or doesn't exist. Useful when callers want to
 * inspect what they're about to rewind to before generating the plan.
 */
export function boundaryAt(
	manifest: SessionSnapshotManifestData,
	targetIndex: number,
): MessageBoundarySnapshot | undefined {
	// Honor the eviction guard so boundaryAt agrees with canRewindTo
	// + planRewind. Eviction can leave stale-but-retained entries in
	// the boundaries array whose index is below
	// oldestAvailableBoundaryIndex; rewinding to one would otherwise
	// throw at planRewind even though boundaryAt happily returns it.
	if (targetIndex < manifest.oldestAvailableBoundaryIndex) {
		return undefined;
	}
	return manifest.boundaries.find((b) => b.index === targetIndex);
}

function indexByPath(
	files: readonly FileSnapshot[],
): Map<string, FileSnapshot> {
	const map = new Map<string, FileSnapshot>();
	for (const file of files) {
		map.set(file.path, file);
	}
	return map;
}

function indexCurrentWorkspaceByPath(
	boundary: MessageBoundarySnapshot,
): Map<string, FileSnapshot | null> {
	// `boundary.files` is the pre-turn snapshot; the boundary schema
	// records creations + deletions for the turn but does NOT track
	// in-place edits. Any pre-turn file may have been modified during
	// the latest turn, so we can't trust its hash for the live
	// workspace state. Mark every surviving pre-turn file as `null`
	// (unknown content) so the rewind comparison always emits a
	// restore for paths the target keeps. Wasteful for untouched
	// files but safe — without this guard, a target whose `files`
	// happen to match the stale pre-turn hash would silently skip the
	// restore even though disk content differs.
	const map = new Map<string, FileSnapshot | null>();
	for (const file of boundary.files) {
		map.set(file.path, null);
	}
	for (const deletion of boundary.deletions) {
		map.delete(deletion.path);
	}
	for (const creation of boundary.creations) {
		// Creations have no post-turn hash captured either; same
		// "present with unknown contents" treatment.
		map.set(creation.path, null);
	}
	return map;
}

function indexTargetWorkspaceByPath(
	boundary: MessageBoundarySnapshot,
	nextBoundary?: MessageBoundarySnapshot,
): Map<string, FileSnapshot | null> {
	// `boundary.files` is the snapshot captured just before this turn
	// ran — that IS the rewind target this module commits to (NOT the
	// post-turn state). The boundary schema doesn't carry an
	// in-place-edits field, so we can't reconstruct post-turn content
	// without it; sticking with pre-turn keeps the contract honest
	// and matches the convention every existing caller already
	// assumes ("rewind to boundary N = restore boundary N's files
	// snapshot"). A future schema bump that adds `modifications` can
	// upgrade this to a true post-turn restore.
	const map = new Map<string, FileSnapshot | null>();
	const nextFilesByPath = nextBoundary
		? indexByPath(nextBoundary.files)
		: undefined;
	for (const file of boundary.files) {
		// Older targets can often recover the post-turn hash from the next
		// boundary's pre-turn snapshot while still keeping membership decisions
		// scoped to this boundary's own creations/deletions.
		map.set(file.path, nextFilesByPath?.get(file.path) ?? file);
	}
	for (const deletion of boundary.deletions) {
		map.delete(deletion.path);
	}
	for (const creation of boundary.creations) {
		// Target-side creations exist after the turn. When a successor boundary
		// is available, its pre-turn snapshot carries the created file's hash.
		map.set(creation.path, nextFilesByPath?.get(creation.path) ?? null);
	}
	return map;
}

function byPath<T extends { path: string }>(a: T, b: T): number {
	if (a.path === b.path) return 0;
	return a.path < b.path ? -1 : 1;
}
