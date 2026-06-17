/**
 * Git AI Notes — primitive layer
 *
 * Agents attach commentary to commits as git notes (refs/notes/maestro/*).
 * Notes are distributed by git itself (`git push <remote> refs/notes/*`)
 * so the agent's reasoning rides alongside the code in the repo's own
 * history; anyone with the repo can fetch the notes the same way they
 * fetch refs.
 *
 * ## What lives in a note
 *
 * Each note captures the *durable* parts of what the agent did:
 *
 *   - Intent: what the agent set out to do, in one or two sentences.
 *   - Evidence: how the agent verified the change (tests passing,
 *     manual run, observed behavior).
 *   - Risks: known limitations, regressions to watch, follow-up work.
 *   - Provenance: model id, agent version, session id, ISO timestamp.
 *
 * Anything ephemeral (intermediate tool calls, retries, scratch
 * reasoning) belongs in session logs, not in the note. Notes are a
 * commit-shaped artifact; treat them like commit messages.
 *
 * ## What this module is and isn't
 *
 * Pure data shape + serializer + parser. No git invocation. No daemon.
 * The follow-up PRs (`maestro git-ai install`, `maestro git-ai push`)
 * consume `buildAgentNote` to render the text they hand to
 * `git notes add -F -`.
 *
 * ## Wire format
 *
 * Notes are markdown-rendered for human review and JSON-fenced for
 * round-trip parse. A trailing fenced code block holds the canonical
 * JSON; everything above it is the rendered prose. `parseAgentNote`
 * reads only the JSON block, so prose edits don't break round-trip but
 * also don't change the canonical record.
 */

/** Per-session schema version for forward-compatible note migrations. */
export const AGENT_NOTE_SCHEMA_VERSION = 1;

/** Fenced JSON marker for the canonical record at the tail of a note. */
const NOTE_JSON_FENCE_OPEN = "```json maestro-note";
const NOTE_JSON_FENCE_CLOSE = "```";

/**
 * Single follow-up item the agent wants future readers (human or
 * agent) to know about.
 */
export interface AgentNoteFollowUp {
	/** Short label for the follow-up. */
	title: string;
	/** Optional longer description / pointer to where to pick this up. */
	detail?: string;
	/** Optional severity hint: 'risk' surfaces when listing high-priority items. */
	severity?: "info" | "watch" | "risk";
}

/** Provenance fields that pin a note to a specific agent run. */
export interface AgentNoteProvenance {
	/** Model the agent was running on (e.g. "claude-opus-4-7"). */
	modelId?: string;
	/** Maestro session that produced the note. */
	sessionId?: string;
	/** Maestro version string. */
	agentVersion?: string;
	/** ISO 8601 timestamp the note was created. */
	createdAt: string;
}

/** Authoritative note shape — what serializes to the canonical JSON block. */
export interface AgentNote {
	/** Schema version. */
	version: number;
	/**
	 * Commit the note will be attached to. Recorded in the body so notes
	 * are still meaningful if extracted from git and shipped elsewhere.
	 */
	commitSha: string;
	/** What the agent set out to do (1–2 sentences). */
	intent: string;
	/**
	 * Evidence the change works: test names that passed, manual
	 * verification steps, observed behavior. Each entry is a single
	 * proof point.
	 */
	evidence: string[];
	/** Follow-up items / risks / known gaps. */
	followUps: AgentNoteFollowUp[];
	/** Provenance pin. */
	provenance: AgentNoteProvenance;
}

/** Input shape for buildAgentNote — drops `version`, fills it in. */
export interface AgentNoteInput {
	commitSha: string;
	intent: string;
	evidence?: string[];
	followUps?: AgentNoteFollowUp[];
	provenance: AgentNoteProvenance;
}

/** Result of parseAgentNote — successful parse or a structured failure. */
export type AgentNoteParseResult =
	| { ok: true; note: AgentNote }
	| { ok: false; reason: AgentNoteParseReason };

export type AgentNoteParseReason =
	| "no-fenced-json"
	| "invalid-json"
	| "missing-required-field"
	| "unsupported-version";

/**
 * Validate input and produce a fully-typed note. Throws on missing
 * required fields with a message that points at the offending field;
 * caller fixes the input rather than getting a half-rendered note.
 */
export function makeAgentNote(input: AgentNoteInput): AgentNote {
	const commitSha = input.commitSha?.trim();
	if (!commitSha) {
		throw new Error("commitSha is required");
	}
	if (!/^[0-9a-f]{7,64}$/i.test(commitSha)) {
		throw new Error(
			`commitSha "${commitSha}" must be 7-64 hex characters (got ${commitSha.length})`,
		);
	}
	const intent = input.intent?.trim();
	if (!intent) {
		throw new Error("intent is required");
	}
	if (intent.length > 2000) {
		throw new Error("intent must be 2000 characters or fewer");
	}
	if (!input.provenance) {
		throw new Error("provenance is required");
	}
	if (!input.provenance.createdAt) {
		throw new Error("provenance.createdAt is required");
	}
	const evidence = (input.evidence ?? [])
		.map((e) => e.trim())
		.filter((e) => e.length > 0);
	const followUps = (input.followUps ?? []).map(normalizeFollowUp);
	return {
		version: AGENT_NOTE_SCHEMA_VERSION,
		commitSha,
		intent,
		evidence,
		followUps,
		provenance: {
			modelId: trimOrUndefined(input.provenance.modelId),
			sessionId: trimOrUndefined(input.provenance.sessionId),
			agentVersion: trimOrUndefined(input.provenance.agentVersion),
			createdAt: input.provenance.createdAt,
		},
	};
}

function normalizeFollowUp(entry: AgentNoteFollowUp): AgentNoteFollowUp {
	const title = entry.title?.trim();
	if (!title) {
		throw new Error("follow-up title is required");
	}
	return {
		title,
		detail: trimOrUndefined(entry.detail),
		severity: entry.severity ?? "info",
	};
}

function trimOrUndefined(value: string | undefined): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Render a note as the text we hand to `git notes add -F -`. The body
 * is human-readable markdown; a trailing fenced JSON block holds the
 * canonical record. Round-trip parse reads only the JSON block, so
 * downstream prose edits don't change the record.
 */
export function buildAgentNote(input: AgentNoteInput): string {
	const note = makeAgentNote(input);
	const lines: string[] = [];
	lines.push(`# Maestro agent note for ${note.commitSha}`);
	lines.push("");
	lines.push("## Intent");
	lines.push("");
	lines.push(note.intent);
	lines.push("");
	if (note.evidence.length > 0) {
		lines.push("## Evidence");
		lines.push("");
		for (const item of note.evidence) {
			lines.push(`- ${item}`);
		}
		lines.push("");
	}
	if (note.followUps.length > 0) {
		lines.push("## Follow-ups");
		lines.push("");
		for (const fu of note.followUps) {
			const sev =
				fu.severity && fu.severity !== "info" ? ` (${fu.severity})` : "";
			lines.push(`- **${fu.title}**${sev}`);
			if (fu.detail) {
				lines.push(`  - ${fu.detail}`);
			}
		}
		lines.push("");
	}
	lines.push("## Provenance");
	lines.push("");
	const p = note.provenance;
	if (p.modelId) lines.push(`- Model: \`${p.modelId}\``);
	if (p.agentVersion) lines.push(`- Maestro: \`${p.agentVersion}\``);
	if (p.sessionId) lines.push(`- Session: \`${p.sessionId}\``);
	lines.push(`- Created: ${p.createdAt}`);
	lines.push("");
	lines.push(NOTE_JSON_FENCE_OPEN);
	lines.push(JSON.stringify(note, null, 2));
	lines.push(NOTE_JSON_FENCE_CLOSE);
	lines.push("");
	return lines.join("\n");
}

/**
 * Round-trip parse. Reads the trailing fenced JSON block; ignores any
 * prose edits above it. Returns a structured failure on a missing /
 * malformed block so callers can render an actionable error.
 */
export function parseAgentNote(noteText: string): AgentNoteParseResult {
	// Locate the fenced block by walking lines from the end. The opener and
	// closer must each be the only content on their line so user-supplied
	// content (intent, evidence, follow-ups) containing the literal fence
	// markers can't be mistaken for the real fence:
	//   JSON.stringify always wraps string values in quotes, so a value like
	//   "```json maestro-note" renders as `  "```json maestro-note"` — never
	//   as the bare marker.
	const lines = noteText.split("\n");
	let closeLine = -1;
	let openLine = -1;
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		const line = lines[i];
		if (line === undefined) continue;
		const trimmed = line.trim();
		if (closeLine === -1 && trimmed === NOTE_JSON_FENCE_CLOSE) {
			closeLine = i;
			continue;
		}
		if (closeLine !== -1 && trimmed === NOTE_JSON_FENCE_OPEN) {
			openLine = i;
			break;
		}
	}
	if (openLine === -1 || closeLine === -1 || closeLine <= openLine) {
		return { ok: false, reason: "no-fenced-json" };
	}
	const jsonText = lines
		.slice(openLine + 1, closeLine)
		.join("\n")
		.trim();
	let raw: unknown;
	try {
		raw = JSON.parse(jsonText);
	} catch {
		return { ok: false, reason: "invalid-json" };
	}
	if (!raw || typeof raw !== "object") {
		return { ok: false, reason: "missing-required-field" };
	}
	const candidate = raw as Partial<AgentNote>;
	if (typeof candidate.version !== "number") {
		return { ok: false, reason: "missing-required-field" };
	}
	if (candidate.version > AGENT_NOTE_SCHEMA_VERSION) {
		return { ok: false, reason: "unsupported-version" };
	}
	if (
		typeof candidate.commitSha !== "string" ||
		typeof candidate.intent !== "string" ||
		!Array.isArray(candidate.evidence) ||
		!Array.isArray(candidate.followUps) ||
		!candidate.provenance ||
		typeof candidate.provenance.createdAt !== "string"
	) {
		return { ok: false, reason: "missing-required-field" };
	}
	return { ok: true, note: candidate as AgentNote };
}

/**
 * Build the git notes ref for a maestro project. Project-local
 * namespacing keeps multi-project repos from colliding:
 *
 *   refs/notes/maestro/<projectId>/checkpoints
 *
 * The caller supplies the project id; for single-project repos this
 * can be the literal "default".
 */
export function gitAiNotesRef(
	projectId: string,
	channel: "checkpoints" | "reviews" | "deploys" = "checkpoints",
): string {
	const safeProjectId = projectId.trim();
	if (!/^[a-z0-9][a-z0-9._-]*$/i.test(safeProjectId)) {
		throw new Error(
			`projectId "${projectId}" must be alphanumeric with dots, dashes, or underscores`,
		);
	}
	return `refs/notes/maestro/${safeProjectId}/${channel}`;
}
