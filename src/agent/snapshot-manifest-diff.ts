/**
 * Snapshot manifest diff helper
 *
 * Builds on the session snapshot manifest primitive (part 1 of #2657,
 * merged as #2679). Given two `MessageBoundarySnapshot`s, return a
 * structured diff: which files changed content, which were added,
 * which were removed, which are unchanged.
 *
 * Used by:
 *   - the orchestrator UI to show "what did this turn touch?"
 *   - the rewind preview ("what's about to change if you go back?")
 *   - the audit log (so reviewers can see deltas per boundary)
 *
 * Pure function over the snapshot type. No content fetching, no I/O.
 * Comparison is by `contentSha256` so two snapshots with identical
 * bytes but different metadata still compare as equal.
 */

import type {
	FileSnapshot,
	MessageBoundarySnapshot,
} from "./snapshot-manifest.js";

/** One entry in the diff for a file present in both snapshots. */
export interface ChangedFile {
	path: string;
	/** Content hash in the `from` snapshot. */
	fromSha: string;
	/** Content hash in the `to` snapshot. */
	toSha: string;
	/** Size in the `from` snapshot, in bytes. */
	fromSize: number;
	/** Size in the `to` snapshot, in bytes. */
	toSize: number;
}

/** One entry in the diff for a file present in only one snapshot. */
export interface SingleSidedFile {
	path: string;
	contentSha256: string;
	size: number;
}

/** Result of `diffBoundarySnapshots`. */
export interface BoundarySnapshotDiff {
	/** Files present in `to` but not `from`. */
	added: SingleSidedFile[];
	/** Files present in `from` but not `to`. */
	removed: SingleSidedFile[];
	/** Files present in both, with different content hashes. */
	changed: ChangedFile[];
	/** Files present in both, with identical content hashes. */
	unchanged: SingleSidedFile[];
}

/** Options for `diffBoundarySnapshots`. */
export interface DiffOptions {
	/** Include `unchanged` entries in the result. Defaults to `false` to keep diffs small. */
	includeUnchanged?: boolean;
}

/**
 * Compute the file-level diff between two snapshots. Comparison is
 * by `contentSha256` so two snapshots that hold identical content but
 * different sizes (shouldn't happen but the primitive doesn't
 * enforce) still match.
 *
 * The output lists are sorted by `path` ascending so diffs are stable
 * regardless of input ordering.
 */
export function diffBoundarySnapshots(
	from: MessageBoundarySnapshot,
	to: MessageBoundarySnapshot,
	options: DiffOptions = {},
): BoundarySnapshotDiff {
	const fromByPath = indexByPath(from.files);
	const toByPath = indexByPath(to.files);

	const added: SingleSidedFile[] = [];
	const removed: SingleSidedFile[] = [];
	const changed: ChangedFile[] = [];
	const unchanged: SingleSidedFile[] = [];

	for (const file of from.files) {
		const next = toByPath.get(file.path);
		if (!next) {
			removed.push(toSingleSided(file));
		} else if (next.contentSha256 !== file.contentSha256) {
			changed.push({
				path: file.path,
				fromSha: file.contentSha256,
				toSha: next.contentSha256,
				fromSize: file.size,
				toSize: next.size,
			});
		} else if (options.includeUnchanged) {
			unchanged.push(toSingleSided(file));
		}
	}
	for (const file of to.files) {
		if (!fromByPath.has(file.path)) {
			added.push(toSingleSided(file));
		}
	}

	added.sort(byPath);
	removed.sort(byPath);
	changed.sort(byPath);
	unchanged.sort(byPath);

	return { added, removed, changed, unchanged };
}

/**
 * Summarize a diff into byte / file counts. Useful for "120 KB
 * changed across 5 files" labels in the UI.
 */
export function summarizeDiff(diff: BoundarySnapshotDiff): {
	addedFiles: number;
	removedFiles: number;
	changedFiles: number;
	bytesAdded: number;
	bytesRemoved: number;
	bytesChanged: number;
} {
	const bytesAdded = diff.added.reduce((n, f) => n + f.size, 0);
	const bytesRemoved = diff.removed.reduce((n, f) => n + f.size, 0);
	// For changed files we count the net delta in bytes so a 100 KB →
	// 50 KB shrink shows as `bytesChanged = -50_000` (callers can
	// `Math.abs` it for display, but the signed total is the most
	// informative single number).
	const bytesChanged = diff.changed.reduce(
		(n, f) => n + (f.toSize - f.fromSize),
		0,
	);
	return {
		addedFiles: diff.added.length,
		removedFiles: diff.removed.length,
		changedFiles: diff.changed.length,
		bytesAdded,
		bytesRemoved,
		bytesChanged,
	};
}

/**
 * True when the two snapshots have identical file sets and content
 * hashes — equivalent to `diff.added + removed + changed all empty`.
 */
export function snapshotsEqual(
	from: MessageBoundarySnapshot,
	to: MessageBoundarySnapshot,
): boolean {
	// Index both sides and compare on the unique path sets so
	// duplicate path entries in one side can't mask a path that exists
	// only in the other (e.g. from = [a, a], to = [a, b] would pass a
	// naive length-check + one-sided walk even though `b` is a true
	// add per `diffBoundarySnapshots`).
	const fromByPath = indexByPath(from.files);
	const toByPath = indexByPath(to.files);
	if (fromByPath.size !== toByPath.size) return false;
	for (const [path, file] of fromByPath) {
		const next = toByPath.get(path);
		if (!next || next.contentSha256 !== file.contentSha256) return false;
	}
	return true;
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

function toSingleSided(file: FileSnapshot): SingleSidedFile {
	return {
		path: file.path,
		contentSha256: file.contentSha256,
		size: file.size,
	};
}

function byPath<T extends { path: string }>(a: T, b: T): number {
	if (a.path === b.path) return 0;
	return a.path < b.path ? -1 : 1;
}
