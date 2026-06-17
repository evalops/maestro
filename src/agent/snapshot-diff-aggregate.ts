/**
 * Snapshot diff aggregator
 *
 * Builds on the session snapshot manifest primitive (part 1 of #2657,
 * merged as #2679), the diff helper (part 2, merged as #2694), and
 * the diff renderer (#2699). Pure helper that combines a sequence of
 * per-boundary diffs into one cumulative diff — the *net effect*
 * across the range, not turn-by-turn.
 *
 * Used by:
 *   - the orchestrator UI for "what changed across the last 5 turns?"
 *   - PR summaries when the agent compresses a long session into a
 *     single "diff since start" view
 *   - audit logs that want to compare a session-start boundary to a
 *     session-end boundary without re-snapshotting every file
 *
 * Pure function over the diff type. No I/O. The aggregator works by
 * walking diffs in order and folding each into the running net:
 *
 *   - a file added → stays added
 *   - a file added then removed → cancels out
 *   - a file changed then removed → counts as removed
 *   - a file removed then re-added with a new hash → changed
 *   - a file changed multiple times → keeps the earliest fromSha and
 *     latest toSha
 */

import type {
	BoundarySnapshotDiff,
	ChangedFile,
	SingleSidedFile,
} from "./snapshot-manifest-diff.js";

/** Per-path running state used during aggregation. */
type RunningEntry =
	| {
			status: "added";
			sha: string;
			size: number;
	  }
	| {
			status: "removed";
			sha: string;
			size: number;
	  }
	| {
			status: "changed";
			fromSha: string;
			toSha: string;
			fromSize: number;
			toSize: number;
	  };

/**
 * Combine `diffs` (in chronological order, oldest first) into a
 * single cumulative diff. Returns the same `BoundarySnapshotDiff`
 * shape so the renderer and the summarizer can consume it without
 * caring whether it came from a single diff or an aggregate.
 *
 * `unchanged` is always empty in the output — callers asking for
 * "what changed across this range" don't need a list of every
 * untouched file, and including them would conflict with how
 * aggregation handles changed-then-unchanged sequences anyway.
 */
export function aggregateBoundarySnapshotDiffs(
	diffs: readonly BoundarySnapshotDiff[],
): BoundarySnapshotDiff {
	const running = new Map<string, RunningEntry>();
	for (const diff of diffs) {
		for (const file of diff.added) {
			applyAdded(running, file);
		}
		for (const file of diff.removed) {
			applyRemoved(running, file);
		}
		for (const file of diff.changed) {
			applyChanged(running, file);
		}
	}

	const added: SingleSidedFile[] = [];
	const removed: SingleSidedFile[] = [];
	const changed: ChangedFile[] = [];
	for (const [path, entry] of running) {
		if (entry.status === "added") {
			added.push({ path, contentSha256: entry.sha, size: entry.size });
		} else if (entry.status === "removed") {
			removed.push({ path, contentSha256: entry.sha, size: entry.size });
		} else {
			changed.push({
				path,
				fromSha: entry.fromSha,
				toSha: entry.toSha,
				fromSize: entry.fromSize,
				toSize: entry.toSize,
			});
		}
	}

	added.sort(byPath);
	removed.sort(byPath);
	changed.sort(byPath);

	return {
		added,
		removed,
		changed,
		unchanged: [],
	};
}

function applyAdded(
	running: Map<string, RunningEntry>,
	file: SingleSidedFile,
): void {
	const current = running.get(file.path);
	if (!current) {
		running.set(file.path, {
			status: "added",
			sha: file.contentSha256,
			size: file.size,
		});
		return;
	}
	if (current.status === "removed") {
		// Removed → added: collapses to a `changed` if the content
		// differs from what was there before, or cancels out when it
		// matches.
		if (current.sha === file.contentSha256) {
			running.delete(file.path);
		} else {
			running.set(file.path, {
				status: "changed",
				fromSha: current.sha,
				toSha: file.contentSha256,
				fromSize: current.size,
				toSize: file.size,
			});
		}
		return;
	}
	// Adding the same path again over an existing add or change is a
	// no-op for the running state; the latest sha + size win.
	if (current.status === "added") {
		running.set(file.path, {
			status: "added",
			sha: file.contentSha256,
			size: file.size,
		});
		return;
	}
	running.set(file.path, {
		status: "changed",
		fromSha: current.fromSha,
		toSha: file.contentSha256,
		fromSize: current.fromSize,
		toSize: file.size,
	});
}

function applyRemoved(
	running: Map<string, RunningEntry>,
	file: SingleSidedFile,
): void {
	const current = running.get(file.path);
	if (!current) {
		running.set(file.path, {
			status: "removed",
			sha: file.contentSha256,
			size: file.size,
		});
		return;
	}
	if (current.status === "added") {
		// Added then removed: cancels out, the path was never in the
		// net diff.
		running.delete(file.path);
		return;
	}
	if (current.status === "changed") {
		// Changed then removed: net effect is "removed", anchored at
		// the original (pre-change) content so consumers see what
		// the user "had" before the range.
		running.set(file.path, {
			status: "removed",
			sha: current.fromSha,
			size: current.fromSize,
		});
		return;
	}
	// Two removes shouldn't happen in a valid diff sequence (the path
	// is already gone), but treat the second as the authoritative one.
	running.set(file.path, {
		status: "removed",
		sha: file.contentSha256,
		size: file.size,
	});
}

function applyChanged(
	running: Map<string, RunningEntry>,
	file: ChangedFile,
): void {
	const current = running.get(file.path);
	if (!current) {
		running.set(file.path, {
			status: "changed",
			fromSha: file.fromSha,
			toSha: file.toSha,
			fromSize: file.fromSize,
			toSize: file.toSize,
		});
		return;
	}
	if (current.status === "added") {
		// Added then changed: still an add, but with the new content.
		running.set(file.path, {
			status: "added",
			sha: file.toSha,
			size: file.toSize,
		});
		return;
	}
	if (current.status === "removed") {
		// Removed then changed shouldn't happen in a well-formed diff
		// sequence (you can't change a deleted file), but treat as a
		// re-add → leaves a changed-from-the-original-to-the-new
		// state.
		if (current.sha === file.toSha) {
			running.delete(file.path);
			return;
		}
		running.set(file.path, {
			status: "changed",
			fromSha: current.sha,
			toSha: file.toSha,
			fromSize: current.size,
			toSize: file.toSize,
		});
		return;
	}
	// Already changed: keep the earliest fromSha (so the aggregate
	// describes the entire range) and the latest toSha.
	if (file.toSha === current.fromSha) {
		// Reverted back to start: cancels out.
		running.delete(file.path);
		return;
	}
	running.set(file.path, {
		status: "changed",
		fromSha: current.fromSha,
		toSha: file.toSha,
		fromSize: current.fromSize,
		toSize: file.toSize,
	});
}

function byPath<T extends { path: string }>(a: T, b: T): number {
	if (a.path === b.path) return 0;
	return a.path < b.path ? -1 : 1;
}
