/**
 * Session Snapshot Manifest — types + eviction policy
 *
 * Maestro's existing checkpoints/ and undo/ machinery store file
 * snapshots ad hoc. This module unifies them on a single shape: tie
 * snapshots to *message boundaries* — every user→assistant turn gets
 * an indexed snapshot — and treat the index itself as the rewind/fork
 * coordinate. This is the data layer; the disk-backed manifest manager
 * rides on a follow-up PR.
 *
 * ## What a boundary records
 *
 *   - File snapshots taken just before the assistant turn started.
 *   - File creations and deletions performed during the turn.
 *   - The boundary's totalSize (lazily computed) for eviction budgets.
 *   - The boundary's createdAt timestamp.
 *
 * `rewind <N>` restores the workspace to the file state captured at
 * boundary N. `fork <N>` creates a new session branched from boundary
 * N with the same file state.
 *
 * ## Eviction policy
 *
 * Manifests grow without bound on long sessions. Eviction is driven by
 * a size budget (bytes across all retained boundaries) and a floor (a
 * minimum count of recent boundaries to keep regardless of size).
 * `evictedBoundaryCount` advances each time a boundary is evicted, so
 * `oldestAvailableBoundaryIndex = evictedBoundaryCount` and external
 * indices stay meaningful across eviction.
 *
 * ## What this module is and isn't
 *
 * Types + pure planners (which boundaries would be evicted given a
 * policy, what's the boundary count after applying eviction). No I/O,
 * no actual file snapshots, no on-disk JSON format — those ride in a
 * follow-up PR that consumes this shape.
 */

/** A single file's contents at the boundary. */
export interface FileSnapshot {
	/** Repo-relative path. */
	path: string;
	/** SHA-256 of the contents at snapshot time. */
	contentSha256: string;
	/** Size in bytes (used for eviction budget). */
	size: number;
}

/** A file the turn created (no snapshot needed; restoration deletes it). */
export interface FileCreation {
	path: string;
}

/** A file the turn deleted (snapshot is in the boundary preceding this one). */
export interface FileDeletion {
	path: string;
}

/**
 * One indexed entry per user→assistant turn. The agent loads the
 * boundary on rewind/fork to reconstruct the workspace state at that
 * point in the conversation.
 */
export interface MessageBoundarySnapshot {
	/**
	 * Monotonic 0-based index. Stays stable across eviction; if eviction
	 * advances `oldestAvailableBoundaryIndex` to 5, boundary 5 is still
	 * the 6th boundary that was ever taken — it just sits at array[0]
	 * once the older entries are dropped.
	 */
	index: number;
	/** ISO 8601 timestamp the boundary was captured. */
	createdAt: string;
	/** Files snapshotted just before the assistant turn ran. */
	files: FileSnapshot[];
	/** Files the turn created. */
	creations: FileCreation[];
	/** Files the turn deleted. */
	deletions: FileDeletion[];
	/**
	 * Sum of `files[*].size`. Lazily computed by `withTotalSize` or
	 * supplied by the caller.
	 */
	totalSize?: number;
}

/**
 * Top-level manifest data shape — what gets serialized to disk.
 */
export interface SessionSnapshotManifestData {
	/** Session this manifest belongs to. */
	sessionId: string;
	/** Schema version. */
	version: number;
	/** ISO 8601 timestamp. */
	createdAt: string;
	/** ISO 8601 timestamp of the most recent boundary. */
	lastAccessedAt: string;
	/**
	 * Boundaries in append order. The first entry's index equals
	 * `oldestAvailableBoundaryIndex`; the last entry's index equals
	 * `oldestAvailableBoundaryIndex + boundaries.length - 1`.
	 */
	boundaries: MessageBoundarySnapshot[];
	/**
	 * Lowest boundary index still present in `boundaries`. Older
	 * boundaries have been evicted and are not recoverable.
	 */
	oldestAvailableBoundaryIndex: number;
	/** How many boundaries have been evicted. Monotonic. */
	evictedBoundaryCount: number;
}

/** Schema version emitted by `createSessionSnapshotManifest`. */
export const SESSION_SNAPSHOT_MANIFEST_VERSION = 1;

/**
 * Policy for eviction planning.
 *
 *   maxBytes  — never exceed this many bytes across retained boundaries.
 *               Eviction starts from the oldest and stops once the
 *               budget is back in range OR `minBoundaries` would be
 *               violated.
 *   minBoundaries — never drop below this many recent boundaries even
 *               if the byte budget is exceeded. The boundary index
 *               distance from the head matters more than the byte
 *               count when the user might want to rewind.
 */
export interface SnapshotEvictionPolicy {
	maxBytes: number;
	minBoundaries: number;
}

/**
 * Create a fresh manifest seed. Call once per session; subsequent
 * boundaries are added with `appendBoundary`.
 */
export function createSessionSnapshotManifest(
	sessionId: string,
	now: string = new Date().toISOString(),
): SessionSnapshotManifestData {
	if (!sessionId.trim()) {
		throw new Error("sessionId is required");
	}
	return {
		sessionId,
		version: SESSION_SNAPSHOT_MANIFEST_VERSION,
		createdAt: now,
		lastAccessedAt: now,
		boundaries: [],
		oldestAvailableBoundaryIndex: 0,
		evictedBoundaryCount: 0,
	};
}

/**
 * Sum `files[*].size` into `totalSize`. Idempotent — re-computes
 * every call so callers don't have to track whether the input was
 * already sized.
 */
export function withTotalSize(
	boundary: MessageBoundarySnapshot,
): MessageBoundarySnapshot {
	const totalSize = boundary.files.reduce((sum, f) => sum + f.size, 0);
	return { ...boundary, totalSize };
}

/**
 * Append a new boundary to the manifest. The boundary's `index` is
 * assigned automatically; callers should not set it. Returns a new
 * manifest; the input is not mutated.
 *
 * Throws if the boundary's caller-supplied index is set to anything
 * other than the next slot — that's a caller bug we want to surface
 * loudly rather than silently overwrite.
 */
export function appendBoundary(
	manifest: SessionSnapshotManifestData,
	boundaryWithoutIndex: Omit<MessageBoundarySnapshot, "index">,
): SessionSnapshotManifestData {
	const last = manifest.boundaries[manifest.boundaries.length - 1];
	const lastIndex = last
		? last.index
		: manifest.oldestAvailableBoundaryIndex - 1;
	const nextIndex = lastIndex + 1;
	const sized = withTotalSize({
		...boundaryWithoutIndex,
		index: nextIndex,
	});
	return {
		...manifest,
		lastAccessedAt: sized.createdAt,
		boundaries: [...manifest.boundaries, sized],
	};
}

/** Sum the totalSize across retained boundaries. */
export function manifestTotalBytes(
	manifest: SessionSnapshotManifestData,
): number {
	let sum = 0;
	for (const b of manifest.boundaries) {
		sum += b.totalSize ?? b.files.reduce((s, f) => s + f.size, 0);
	}
	return sum;
}

/**
 * Plan how many boundaries to evict to bring the manifest back in
 * range with the policy. Returns the count to drop from the head
 * (oldest entries). Doesn't mutate; the caller applies the plan via
 * `applyEvictionPlan`.
 *
 * The plan respects `minBoundaries`: if dropping the next boundary
 * would leave fewer than `minBoundaries` retained, eviction stops
 * even if the byte budget is still violated.
 */
export function planEviction(
	manifest: SessionSnapshotManifestData,
	policy: SnapshotEvictionPolicy,
): number {
	const sizes = manifest.boundaries.map(
		(b) => b.totalSize ?? b.files.reduce((s, f) => s + f.size, 0),
	);
	const minBoundaries = Math.max(0, policy.minBoundaries);
	const maxBytes = Math.max(0, policy.maxBytes);

	let totalBytes = sizes.reduce((a, b) => a + b, 0);
	let toDrop = 0;
	while (
		toDrop < sizes.length &&
		totalBytes > maxBytes &&
		sizes.length - toDrop > minBoundaries
	) {
		const dropSize = sizes[toDrop] ?? 0;
		totalBytes -= dropSize;
		toDrop += 1;
	}
	return toDrop;
}

/**
 * Apply an eviction plan. Drops the oldest `count` boundaries and
 * advances `evictedBoundaryCount` / `oldestAvailableBoundaryIndex`
 * by the same amount. Boundary indices retained are unchanged so
 * external references (rewind 42) still mean the same boundary.
 */
export function applyEvictionPlan(
	manifest: SessionSnapshotManifestData,
	count: number,
): SessionSnapshotManifestData {
	if (count <= 0) {
		return manifest;
	}
	const clamped = Math.min(count, manifest.boundaries.length);
	const retained = manifest.boundaries.slice(clamped);
	return {
		...manifest,
		boundaries: retained,
		evictedBoundaryCount: manifest.evictedBoundaryCount + clamped,
		oldestAvailableBoundaryIndex:
			manifest.oldestAvailableBoundaryIndex + clamped,
	};
}

/**
 * Find a boundary by its stable index. Returns `undefined` if the
 * index has been evicted or never existed.
 */
export function findBoundaryByIndex(
	manifest: SessionSnapshotManifestData,
	index: number,
): MessageBoundarySnapshot | undefined {
	if (index < manifest.oldestAvailableBoundaryIndex) {
		return undefined;
	}
	const offset = index - manifest.oldestAvailableBoundaryIndex;
	return manifest.boundaries[offset];
}

/**
 * Summary stats for surface UI: how many boundaries are retained, how
 * many were evicted, the head/tail indices, and the current size.
 */
export function summarizeManifest(manifest: SessionSnapshotManifestData): {
	retained: number;
	evicted: number;
	totalBoundariesEver: number;
	oldestIndex: number;
	newestIndex: number | null;
	totalBytes: number;
} {
	const retained = manifest.boundaries.length;
	const evicted = manifest.evictedBoundaryCount;
	const newest = manifest.boundaries[retained - 1];
	const newestIndex = newest ? newest.index : null;
	return {
		retained,
		evicted,
		totalBoundariesEver: evicted + retained,
		oldestIndex: manifest.oldestAvailableBoundaryIndex,
		newestIndex,
		totalBytes: manifestTotalBytes(manifest),
	};
}
