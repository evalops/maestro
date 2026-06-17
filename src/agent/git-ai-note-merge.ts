/**
 * AgentNote merge helper
 *
 * Builds on the git-ai-note primitive (part 1 of #2666, merged as
 * #2676). When two or more AgentNotes target the same commit (the
 * orchestrator handed the same commit to multiple agents, the
 * checkpoint runner re-emitted a note that conflicts with an earlier
 * one, etc), the git notes ref needs a single coherent payload.
 *
 * This module owns the merge:
 *
 *   - Concatenate intents with a separator so reviewers see what each
 *     agent set out to do.
 *   - Deduplicate evidence + follow-up entries (case-sensitive on
 *     title; preserves first-seen order so the resulting note reads
 *     naturally).
 *   - Take the latest provenance.createdAt; preserve the most-set
 *     model/session/agent-version fields.
 *   - Reject merges where the notes target different commits — that's
 *     always a caller bug, never the intended use.
 *
 * Pure data merge. No git CLI invocation, no I/O. Follow-up PRs wire
 * the actual `git notes append --strategy ours` path.
 */

import {
	AGENT_NOTE_SCHEMA_VERSION,
	type AgentNote,
	type AgentNoteFollowUp,
	type AgentNoteProvenance,
} from "./git-ai-note.js";

export interface MergeAgentNotesOptions {
	/**
	 * Separator inserted between concatenated `intent` strings. Defaults
	 * to `" · "` so the merged intent reads as a single line; pass `"\n"`
	 * for multi-line notes if the renderer can handle them.
	 */
	intentSeparator?: string;
}

/**
 * Merge two or more `AgentNote`s targeting the same commit. Throws on
 * an empty list or notes that target different commits.
 *
 * Output `version` is the higher of the input versions (so a merge
 * across a schema bump tags itself with the newer schema; callers
 * upgrading older notes should do that conversion first).
 */
export function mergeAgentNotes(
	notes: readonly AgentNote[],
	options: MergeAgentNotesOptions = {},
): AgentNote {
	if (notes.length === 0) {
		throw new Error("mergeAgentNotes: notes list must be non-empty");
	}
	const [first, ...rest] = notes;
	if (!first) {
		throw new Error("mergeAgentNotes: notes list must be non-empty");
	}
	// Compare SHAs case-insensitively. `makeAgentNote` already accepts
	// hex commits regardless of casing; two notes that differ only by
	// uppercase vs lowercase chars target the same revision and
	// shouldn't be rejected as mergeable.
	const commitSha = first.commitSha;
	const commitShaKey = normalizeCommitShaForComparison(commitSha);
	for (const note of rest) {
		if (normalizeCommitShaForComparison(note.commitSha) !== commitShaKey) {
			throw new Error(
				`mergeAgentNotes: every note must target the same commit (expected "${commitSha}", got "${note.commitSha}")`,
			);
		}
	}
	const intentSeparator = options.intentSeparator ?? " · ";
	const intents: string[] = [];
	const evidenceSeen = new Set<string>();
	const evidence: string[] = [];
	const followUpSeen = new Set<string>();
	const followUps: AgentNoteFollowUp[] = [];
	let highestVersion = 0;
	for (const note of notes) {
		const trimmedIntent = note.intent.trim();
		if (trimmedIntent) intents.push(trimmedIntent);
		for (const item of note.evidence) {
			const key = item.trim();
			if (!key || evidenceSeen.has(key)) continue;
			evidenceSeen.add(key);
			evidence.push(item);
		}
		for (const followUp of note.followUps) {
			const key = followUp.title.trim();
			if (!key || followUpSeen.has(key)) continue;
			followUpSeen.add(key);
			followUps.push(followUp);
		}
		if (note.version > highestVersion) {
			highestVersion = note.version;
		}
	}

	return {
		version: Math.max(highestVersion, AGENT_NOTE_SCHEMA_VERSION),
		commitSha,
		intent: dedupeIntents(intents).join(intentSeparator),
		evidence,
		followUps,
		provenance: mergeProvenance(notes.map((n) => n.provenance)),
	};
}

/**
 * Deduplicate intent strings while preserving order — two agents
 * stating identical intents shouldn't double up in the merged note.
 */
function dedupeIntents(intents: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const intent of intents) {
		const normalized = intent.replace(/\s+/g, " ").trim().toLowerCase();
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		out.push(intent);
	}
	return out;
}

/**
 * Pick the latest `createdAt`; preserve the most-set
 * model/session/agent-version fields by taking the last non-empty
 * value seen (so callers can pass the most-authoritative note last).
 */
function mergeProvenance(
	provs: readonly AgentNoteProvenance[],
): AgentNoteProvenance {
	let latestCreatedAt = provs[0]?.createdAt ?? new Date().toISOString();
	let modelId: string | undefined;
	let sessionId: string | undefined;
	let agentVersion: string | undefined;
	for (const p of provs) {
		if (p.createdAt > latestCreatedAt) {
			latestCreatedAt = p.createdAt;
		}
		const trimmedModelId = trimOrUndefined(p.modelId);
		if (trimmedModelId !== undefined) modelId = trimmedModelId;
		const trimmedSessionId = trimOrUndefined(p.sessionId);
		if (trimmedSessionId !== undefined) sessionId = trimmedSessionId;
		const trimmedAgentVersion = trimOrUndefined(p.agentVersion);
		if (trimmedAgentVersion !== undefined) agentVersion = trimmedAgentVersion;
	}
	const merged: AgentNoteProvenance = { createdAt: latestCreatedAt };
	if (modelId !== undefined) merged.modelId = modelId;
	if (sessionId !== undefined) merged.sessionId = sessionId;
	if (agentVersion !== undefined) merged.agentVersion = agentVersion;
	return merged;
}

/**
 * Convenience: true when the notes are mergeable (non-empty list AND
 * every note targets the same commit). Use this before calling
 * `mergeAgentNotes` to surface a friendlier error to the user
 * (`mergeAgentNotes` itself throws on the same condition).
 */
export function canMergeAgentNotes(notes: readonly AgentNote[]): boolean {
	if (notes.length === 0) return false;
	const first = notes[0];
	if (!first) return false;
	// Match the case-insensitive comparison `mergeAgentNotes` uses so
	// the predicate agrees with the throw.
	const commitShaKey = normalizeCommitShaForComparison(first.commitSha);
	return notes.every(
		(n) => normalizeCommitShaForComparison(n.commitSha) === commitShaKey,
	);
}

function normalizeCommitShaForComparison(commitSha: string): string {
	return commitSha.trim().toLowerCase();
}

function trimOrUndefined(value: string | undefined): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}
