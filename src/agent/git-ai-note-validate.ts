/**
 * AgentNote pre-publish validator
 *
 * Builds on the git-ai-note primitive (part 1 of #2666, merged as
 * #2676), the merge helper (#2692), and the markdown renderer
 * (#2693). Pure pre-publish validator: catches malformed or low-value
 * notes before they're written to git notes / posted to PRs.
 *
 * The primitive's `makeAgentNote` already rejects fully-broken inputs
 * (empty intent, blank commit SHA). This validator runs the softer
 * quality checks the orchestrator wants to enforce at publish time:
 *
 *   - intent is at least 8 characters of substantive content
 *   - evidence has at least one entry when intent claims a non-trivial
 *     change (avoids the "trust me, it works" anti-pattern)
 *   - follow-ups marked `severity: "risk"` carry a `detail` so the
 *     reviewer knows what to actually do
 *   - commit SHA matches the 7-64 hex shape git uses
 *
 * No I/O. Returns a structured `AgentNoteValidationResult` instead of
 * throwing, so callers can render the reasons inline rather than
 * needing to catch.
 */

import type { AgentNote, AgentNoteFollowUp } from "./git-ai-note.js";

/** Result of `validateAgentNote`. */
export type AgentNoteValidationResult =
	| { ok: true }
	| { ok: false; reasons: string[] };

/** Knobs for `validateAgentNote`. */
export interface ValidateAgentNoteOptions {
	/**
	 * Minimum intent length, in trimmed characters. Defaults to 8 —
	 * enough to avoid one-word intents like "fix" but lenient enough
	 * to accept "Add login.".
	 */
	minIntentLength?: number;
	/**
	 * When true, require at least one evidence entry. Defaults to
	 * `true` — the orchestrator should know what the agent verified.
	 * Set false for transient checkpoint notes that haven't run
	 * verification yet.
	 */
	requireEvidence?: boolean;
}

const SHA_PATTERN = /^[0-9a-fA-F]{7,64}$/;

/**
 * Validate `note` against the pre-publish quality bar. Returns a
 * structured result with every failing reason populated so callers
 * can show them inline rather than discovering them one at a time.
 */
export function validateAgentNote(
	note: AgentNote,
	options: ValidateAgentNoteOptions = {},
): AgentNoteValidationResult {
	const minIntentLength = options.minIntentLength ?? 8;
	if (minIntentLength < 0 || !Number.isInteger(minIntentLength)) {
		throw new Error(
			`validateAgentNote: minIntentLength must be a non-negative integer, got ${minIntentLength}`,
		);
	}
	const requireEvidence = options.requireEvidence ?? true;
	const reasons: string[] = [];

	const trimmedIntent = note.intent.trim();
	if (trimmedIntent.length < minIntentLength) {
		reasons.push(
			`intent must be at least ${minIntentLength} characters (got ${trimmedIntent.length})`,
		);
	}

	if (requireEvidence && note.evidence.length === 0) {
		reasons.push(
			"evidence must include at least one entry (set requireEvidence: false to skip)",
		);
	}
	const blankEvidence = note.evidence.filter(
		(e) => typeof e !== "string" || !e.trim(),
	).length;
	if (blankEvidence > 0) {
		reasons.push(
			`evidence has ${blankEvidence} blank entr${blankEvidence === 1 ? "y" : "ies"}`,
		);
	}

	for (let i = 0; i < note.followUps.length; i += 1) {
		const followUp = note.followUps[i] as unknown;
		if (!followUp || typeof followUp !== "object") {
			reasons.push(`followUps[${i}] must be an object`);
			continue;
		}
		const candidate = followUp as AgentNoteFollowUp;
		if (typeof candidate.title !== "string" || !candidate.title.trim()) {
			reasons.push(`followUps[${i}] is missing a title`);
		}
		if (
			candidate.severity === "risk" &&
			(typeof candidate.detail !== "string" || !candidate.detail.trim())
		) {
			reasons.push(
				`followUps[${i}] is marked risk severity but has no detail (reviewers can't act on it)`,
			);
		}
	}

	if (!SHA_PATTERN.test(note.commitSha)) {
		reasons.push(
			`commitSha must be a 7–64 hex string (got "${note.commitSha}")`,
		);
	}

	if (!note.provenance.createdAt.trim()) {
		reasons.push("provenance.createdAt is required");
	}

	if (reasons.length === 0) {
		return { ok: true };
	}
	return { ok: false, reasons };
}

/**
 * Convenience: filter a list of notes to those that pass validation.
 * Useful when batching a renderer over multiple checkpoint notes.
 */
export function partitionValidAgentNotes(
	notes: readonly AgentNote[],
	options: ValidateAgentNoteOptions = {},
): {
	valid: AgentNote[];
	invalid: { note: AgentNote; reasons: string[] }[];
} {
	const valid: AgentNote[] = [];
	const invalid: { note: AgentNote; reasons: string[] }[] = [];
	for (const note of notes) {
		const result = validateAgentNote(note, options);
		if (result.ok) {
			valid.push(note);
		} else {
			invalid.push({ note, reasons: result.reasons });
		}
	}
	return { valid, invalid };
}
