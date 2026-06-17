/**
 * AgentNote markdown renderer
 *
 * Builds on the git-ai-note primitive (part 1 of #2666, merged as
 * #2676) and the merge helper (#2692). Pure renderer that turns an
 * `AgentNote` into a human-readable markdown block — suitable for:
 *
 *   - `git log` / `git show` display when the agent attached the note
 *     to a commit (`git notes show <ref>` returns the canonical JSON
 *     block; reviewers want this human view alongside it)
 *   - PR comments where the agent posts its note for review
 *   - the orchestrator's UI surface
 *
 * Pure function over the record type. No git invocation, no I/O.
 */

import type { AgentNote, AgentNoteFollowUp } from "./git-ai-note.js";
import { renderInlineCode } from "./markdown-render-utils.js";

export interface RenderAgentNoteOptions {
	/** Include the provenance block (model id, session id, version, timestamp). Defaults to true. */
	includeProvenance?: boolean;
	/**
	 * Heading depth offset. `0` (default) makes the top-level heading
	 * an H3. Bump to splice into a larger document under H2 or H1
	 * sections. Clamped to [0, 4].
	 */
	headingDepthOffset?: number;
}

/**
 * Render one AgentNote as a markdown block. Output starts with a
 * heading derived from the commit sha so reviewers can spot which
 * commit the note covers without context.
 */
export function renderAgentNote(
	note: AgentNote,
	options: RenderAgentNoteOptions = {},
): string {
	const includeProvenance = options.includeProvenance ?? true;
	const offset = clampOffset(options.headingDepthOffset ?? 0);
	const h = (level: number) => "#".repeat(Math.min(level + offset, 6));

	const lines: string[] = [];
	lines.push(
		`${h(3)} Agent note — ${renderInlineCode(note.commitSha.slice(0, 7))}`,
	);
	lines.push("");
	const trimmedIntent = note.intent.trim();
	// The `_(unspecified)_` placeholder is a static markdown literal —
	// passing it through escapeMd would render it as visible
	// underscores rather than italics. Skip escaping for the
	// placeholder; escape user-supplied intents normally.
	const intentBody = trimmedIntent
		? escapeMd(trimmedIntent)
		: "_(unspecified)_";
	lines.push(`**Intent:** ${intentBody}`);

	if (note.evidence.length > 0) {
		lines.push("");
		lines.push("**Evidence:**");
		lines.push("");
		for (const item of note.evidence) {
			lines.push(`- ${escapeMd(item)}`);
		}
	}

	if (note.followUps.length > 0) {
		lines.push("");
		lines.push("**Follow-ups:**");
		lines.push("");
		for (const f of note.followUps) {
			lines.push(`- ${renderFollowUp(f)}`);
		}
	}

	if (includeProvenance) {
		const provLines: string[] = [];
		if (note.provenance.modelId) {
			provLines.push(`model ${renderInlineCode(note.provenance.modelId)}`);
		}
		if (note.provenance.sessionId) {
			provLines.push(`session ${renderInlineCode(note.provenance.sessionId)}`);
		}
		if (note.provenance.agentVersion) {
			provLines.push(`agent ${renderInlineCode(note.provenance.agentVersion)}`);
		}
		// Escape `createdAt` too — the field is user/agent-supplied so a
		// caller passing a multiline value or one containing markdown
		// metacharacters would otherwise break the italicized footer.
		provLines.push(`at ${escapeMd(note.provenance.createdAt)}`);
		lines.push("");
		lines.push(`_${provLines.join(" · ")}_`);
	}

	return lines.join("\n");
}

/**
 * Render a list of notes (sorted by `provenance.createdAt` descending
 * — most recent first) as a single document. Useful when the orchestrator
 * shows every note attached to a single commit.
 */
export function renderAgentNotes(
	notes: readonly AgentNote[],
	options: RenderAgentNoteOptions = {},
): string {
	if (notes.length === 0) {
		return "_No agent notes._";
	}
	const sorted = [...notes].sort((a, b) => {
		if (a.provenance.createdAt === b.provenance.createdAt) return 0;
		return a.provenance.createdAt < b.provenance.createdAt ? 1 : -1;
	});
	return sorted.map((n) => renderAgentNote(n, options)).join("\n\n---\n\n");
}

function renderFollowUp(followUp: AgentNoteFollowUp): string {
	const badge =
		followUp.severity === "risk"
			? "**[RISK]** "
			: followUp.severity === "watch"
				? "**[WATCH]** "
				: "";
	const detail = followUp.detail ? ` — ${escapeMd(followUp.detail)}` : "";
	return `${badge}${escapeMd(followUp.title)}${detail}`;
}

function clampOffset(value: number): number {
	if (!Number.isFinite(value)) return 0;
	if (value < 0) return 0;
	if (value > 4) return 4;
	return Math.floor(value);
}

/**
 * Escape characters that would otherwise break the surrounding
 * markdown when user-supplied content is interpolated inline. We
 * collapse line breaks to a single space so a multiline intent or
 * evidence string can't introduce headings, lists, or horizontal
 * rules into the rendered block.
 */
function escapeMd(input: string): string {
	return input
		.replace(/\\/g, "\\\\")
		.replace(/`/g, "\\`")
		.replace(/_/g, "\\_")
		.replace(/\*/g, "\\*")
		.replace(/\r?\n|\r/g, " ");
}
