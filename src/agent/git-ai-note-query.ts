/**
 * AgentNote query / filter helper
 *
 * Builds on the git-ai-note primitive (part 1 of #2666, merged as
 * #2676). Pure helper for slicing a collection of notes by the
 * criteria orchestrator UI + audit log actually use:
 *
 *   - commit SHA prefix (so an 8-char short SHA matches the full SHA)
 *   - intent substring (case-insensitive)
 *   - evidence path / fragment (case-insensitive)
 *   - follow-up severity (e.g. "show me every risk")
 *   - createdAt time window
 *   - model id / session id / agent version exact match
 *
 * Filters compose with AND semantics — every supplied predicate must
 * match. Omitted fields are wildcards. That keeps the call sites
 * declarative (`{ severity: "risk", sinceIso: ... }`) instead of
 * chaining .filter() across the codebase.
 *
 * Pure function. No I/O.
 */

import type { AgentNote, AgentNoteFollowUp } from "./git-ai-note.js";

/**
 * Query shape passed to `queryAgentNotes`. Every field is optional;
 * an empty query returns the input unchanged.
 */
export interface AgentNoteQuery {
	/** Match notes whose commit SHA starts with this prefix (case-insensitive). */
	commitShaPrefix?: string;
	/** Match notes whose intent contains this substring (case-insensitive). */
	intentContains?: string;
	/** Match notes with at least one evidence entry containing this fragment (case-insensitive). */
	evidenceContains?: string;
	/** Match notes that carry at least one follow-up at this severity. */
	hasFollowUpSeverity?: "info" | "watch" | "risk";
	/** Match notes whose provenance.createdAt >= sinceIso (lexicographic, ISO-8601). */
	sinceIso?: string;
	/** Match notes whose provenance.createdAt <= untilIso (lexicographic, ISO-8601). */
	untilIso?: string;
	/** Match notes whose provenance.modelId === modelId. */
	modelId?: string;
	/** Match notes whose provenance.sessionId === sessionId. */
	sessionId?: string;
	/** Match notes whose provenance.agentVersion === agentVersion. */
	agentVersion?: string;
}

/**
 * Filter a collection of notes by the predicates in `query`. Returns
 * the matching notes in input order. AND semantics: omit a field to
 * skip its predicate.
 */
export function queryAgentNotes(
	notes: readonly AgentNote[],
	query: AgentNoteQuery,
): AgentNote[] {
	const out: AgentNote[] = [];
	for (const note of notes) {
		if (matchesQuery(note, query)) out.push(note);
	}
	return out;
}

/**
 * AND-composed predicate: every supplied filter must match. Shared by
 * `queryAgentNotes` and `countAgentNotes` so badge-count call sites
 * don't pay an array allocation.
 */
function matchesQuery(note: AgentNote, query: AgentNoteQuery): boolean {
	const shaPrefix = query.commitShaPrefix?.trim().toLowerCase();
	if (shaPrefix !== undefined && shaPrefix.length > 0) {
		// Trim before matching so this stays consistent with how
		// groupAgentNotesByCommit buckets (trim + lowercase). Without
		// the trim, a query of " abc" would never match the same notes
		// that bucket under "abc".
		if (!note.commitSha.trim().toLowerCase().startsWith(shaPrefix)) {
			return false;
		}
	}
	const intentSubstring = query.intentContains?.trim().toLowerCase();
	if (intentSubstring !== undefined && intentSubstring.length > 0) {
		if (!note.intent.toLowerCase().includes(intentSubstring)) return false;
	}
	const evidenceSubstring = query.evidenceContains?.trim().toLowerCase();
	if (evidenceSubstring !== undefined && evidenceSubstring.length > 0) {
		if (
			!note.evidence.some((e) => e.toLowerCase().includes(evidenceSubstring))
		) {
			return false;
		}
	}
	const severity = query.hasFollowUpSeverity;
	if (severity !== undefined) {
		if (!note.followUps.some((f) => effectiveSeverity(f) === severity)) {
			return false;
		}
	}
	// Treat blank string bounds as wildcards (matches how blank
	// commitShaPrefix already behaves) so a caller can wire untilIso
	// to an empty form field without inadvertently filtering everything
	// out. We trim before the blank check so whitespace-only form
	// values ("   ") behave the same as cleared ones — `"createdAt" >
	// "   "` would otherwise reject every real ISO timestamp.
	if (isFilterActive(query.sinceIso)) {
		if (note.provenance.createdAt < query.sinceIso) return false;
	}
	if (isFilterActive(query.untilIso)) {
		if (note.provenance.createdAt > query.untilIso) return false;
	}
	// Treat blank provenance filters as wildcards too (same as the iso
	// bounds). makeAgentNote keeps those provenance fields as
	// `undefined`, so without this guard a cleared form field would
	// drop every note (undefined !== "").
	if (
		isFilterActive(query.modelId) &&
		note.provenance.modelId !== query.modelId
	) {
		return false;
	}
	if (
		isFilterActive(query.sessionId) &&
		note.provenance.sessionId !== query.sessionId
	) {
		return false;
	}
	if (
		isFilterActive(query.agentVersion) &&
		note.provenance.agentVersion !== query.agentVersion
	) {
		return false;
	}
	return true;
}

function isFilterActive(value: string | undefined): value is string {
	return value !== undefined && value.trim() !== "";
}

/**
 * Severity actually carried by a follow-up. Mirrors `makeAgentNote`'s
 * default of "info" when the field is absent, so query results stay
 * consistent across notes built via `makeAgentNote` and notes parsed
 * straight from JSON (where omitted fields stay omitted).
 */
function effectiveSeverity(
	followUp: AgentNoteFollowUp,
): "info" | "watch" | "risk" {
	return followUp.severity ?? "info";
}

/**
 * Count matches without allocating an array. Cheaper for "show me the
 * badge count" call sites that don't need the notes themselves.
 */
export function countAgentNotes(
	notes: readonly AgentNote[],
	query: AgentNoteQuery,
): number {
	let count = 0;
	for (const note of notes) {
		if (matchesQuery(note, query)) count += 1;
	}
	return count;
}

/**
 * Group matches by commit SHA (lowercase) so callers can list per
 * commit without re-walking. Buckets preserve input order. Returns an
 * empty map when nothing matches.
 */
export function groupAgentNotesByCommit(
	notes: readonly AgentNote[],
	query: AgentNoteQuery = {},
): Map<string, AgentNote[]> {
	const matches = queryAgentNotes(notes, query);
	const buckets = new Map<string, AgentNote[]>();
	for (const note of matches) {
		const key = note.commitSha.trim().toLowerCase();
		const bucket = buckets.get(key);
		if (bucket) {
			bucket.push(note);
		} else {
			buckets.set(key, [note]);
		}
	}
	return buckets;
}
