/**
 * AgentNote commit indexer
 *
 * Builds on the git-ai-note primitive (part 1 of #2666, merged as
 * #2676) and the merge helper (#2692). Pure helper that indexes a
 * list of notes by commit SHA so callers (orchestrator UI,
 * `git log --notes` post-processor, audit log) can resolve "what
 * notes did the agent leave for commit X?" in one lookup.
 *
 * When multiple notes target the same commit, the indexer combines
 * them via `mergeAgentNotes` so the lookup always returns a single
 * coherent payload — matching how the git notes ref would render
 * after an append-with-merge.
 *
 * Pure function. No I/O.
 */

import { canMergeAgentNotes, mergeAgentNotes } from "./git-ai-note-merge.js";
import type { AgentNote } from "./git-ai-note.js";

/**
 * Result of `indexAgentNotesByCommit`. `byCommit` is keyed by the
 * trimmed lowercase canonical commit SHA so harmless casing/spacing
 * differences across notes collapse onto the same entry.
 */
export interface AgentNoteCommitIndex {
	/** Trimmed lowercase-keyed map of commit SHA → coherent note. */
	byCommit: Map<string, AgentNote>;
	/**
	 * Original notes that were dropped because their commit collided
	 * with another but couldn't be merged (different shape that
	 * `canMergeAgentNotes` rejects). Empty when every group merged
	 * cleanly.
	 */
	dropped: AgentNote[];
}

/**
 * Group notes by trimmed lowercase commit SHA and merge each group
 * via `mergeAgentNotes`. The returned map uses trimmed lowercase keys;
 * callers looking up by SHA should normalize their query first.
 */
export function indexAgentNotesByCommit(
	notes: readonly AgentNote[],
): AgentNoteCommitIndex {
	const groups = new Map<string, AgentNote[]>();
	for (const note of notes) {
		const key = normalizeCommitSha(note.commitSha);
		const bucket = groups.get(key);
		if (bucket) {
			bucket.push(note);
		} else {
			groups.set(key, [note]);
		}
	}
	const byCommit = new Map<string, AgentNote>();
	const dropped: AgentNote[] = [];
	for (const [key, bucket] of groups) {
		if (!canMergeAgentNotes(bucket)) {
			// Shouldn't normally happen — every note in a single bucket
			// shares its SHA, so canMergeAgentNotes returns true. Kept
			// for defensiveness; ship the bucket to `dropped` so the
			// caller can surface the inconsistency.
			dropped.push(...bucket);
			continue;
		}
		// Always normalize through mergeAgentNotes — even single-note
		// buckets so the lookup payload is shaped consistently with how
		// multi-note buckets render after an append-with-merge (blank
		// evidence stripped, schema version bumped, etc).
		byCommit.set(key, mergeAgentNotes(bucket));
	}
	return { byCommit, dropped };
}

/**
 * Look up the coherent note for `commitSha` in `index`. Case-
 * insensitive: matches how `mergeAgentNotes` already treats SHAs.
 */
export function findAgentNoteForCommit(
	index: AgentNoteCommitIndex,
	commitSha: string,
): AgentNote | undefined {
	if (typeof commitSha !== "string") return undefined;
	const key = normalizeCommitSha(commitSha);
	if (!key) return undefined;
	return index.byCommit.get(key);
}

function normalizeCommitSha(commitSha: string): string {
	return commitSha.trim().toLowerCase();
}

/**
 * Filter the index to commits whose SHA matches a predicate. Useful
 * when callers want "notes for everything in this branch" without
 * walking every commit themselves.
 */
export function filterAgentNoteIndex(
	index: AgentNoteCommitIndex,
	predicate: (commitSha: string) => boolean,
): AgentNoteCommitIndex {
	const byCommit = new Map<string, AgentNote>();
	for (const [key, note] of index.byCommit) {
		if (predicate(key)) {
			byCommit.set(key, note);
		}
	}
	return { byCommit, dropped: index.dropped };
}

/**
 * Convenience: count the indexed commits + total dropped notes for
 * a quick "12 commits annotated, 0 dropped" label.
 */
export function summarizeAgentNoteIndex(index: AgentNoteCommitIndex): {
	commitCount: number;
	droppedCount: number;
} {
	return {
		commitCount: index.byCommit.size,
		droppedCount: index.dropped.length,
	};
}
