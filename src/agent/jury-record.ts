/**
 * Heterogeneous Multi-Pass Jury — per-finding canonical record
 *
 * A high-stakes audit (security review, migration safety check,
 * spec-compliance scan) decomposes into a numbered pass pipeline. At
 * each pass, multiple jurors — each running on a different model
 * family — vote on each candidate finding. The orchestrator
 * accumulates verdicts into a single canonical record per finding;
 * synthesis rules promote, demote, or enrich the finding before the
 * next pass.
 *
 * ## Pass pipeline
 *
 *   0 — Lieutenant enumeration: produce a wide, over-inclusive seed
 *       list of candidate findings. False positives are FINE; false
 *       negatives are NOT.
 *   1 — Line-anchor verification: confirm the cited file:line at the
 *       pinned commit matches the claimed pattern. CONFIRMED |
 *       DISPUTED | NEEDS-CONTEXT.
 *   2 — Vendor prior-art screen: tag with CVE / GHSA / advisory
 *       matches. REMAINS-NOVEL | DEMOTE-DUPLICATE | SIBLING-OF-PRIOR
 *       | DEMOTE-KBD.
 *   3 — Deep prior-art screen: enrich with academic / blog / talk
 *       references. Does not promote/demote.
 *   4 — Dataflow & reachability.
 *   5 — Exploit construction.
 *   8 — Adversarial red-team disprove: a sub-worker on a different
 *       model family attempts to break the finding.
 *
 * ## Synthesis rules
 *
 *   UNANIMOUS  — for CRITICAL severity findings: all jurors must
 *                agree to promote; any single demote demotes.
 *   MAJORITY   — for HIGH / MEDIUM / LOW severity: a majority verdict
 *                promotes or demotes.
 *
 * ## Anti-collusion
 *
 * Each finding tracks the model family of every juror that touched
 * it. The orchestrator enforces that Pass 1 jurors, the Pass 4 tracer,
 * and the Pass 8 red-teamer are on distinct families so correlated
 * single-model failures don't propagate downstream.
 *
 * ## What this module is and isn't
 *
 * Pure types + synthesis helpers + the canonical record builder. No
 * LLM calls, no orchestrator loop; the runner consumer in part 2 of
 * #2668 dispatches juror tasks and updates the canonical record from
 * juror verdicts.
 */

/** The pipeline's pass identifiers. */
export type JuryPassId = 0 | 1 | 2 | 3 | 4 | 5 | 8;

/** Severity tier — drives the synthesis rule chosen at each pass. */
export type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";

/**
 * Per-juror classifications by pass. Pass 0 doesn't take a verdict;
 * jurors here just propose findings to add. Later passes carry the
 * classifications below.
 */
export type Pass1Verdict = "CONFIRMED" | "DISPUTED" | "NEEDS-CONTEXT";
export type Pass2Verdict =
	| "REMAINS-NOVEL"
	| "DEMOTE-DUPLICATE"
	| "SIBLING-OF-PRIOR"
	| "DEMOTE-KBD";
export type Pass8Verdict =
	| "RED-TEAM-SURVIVED"
	| "RED-TEAM-DISPROVED"
	| "RED-TEAM-INCONCLUSIVE";

/** A single juror's stamp on a finding at a specific pass. */
export interface JurorVerdict {
	pass: JuryPassId;
	/** Stable juror id (e.g. "claude-opus-4-7-juror-a"). */
	jurorId: string;
	/** Model family (e.g. "anthropic", "openai", "google"). */
	modelFamily: string;
	/** Free-form classification — actual value depends on the pass. */
	classification: string;
	/** Optional short rationale shown alongside the classification. */
	reason?: string;
	/** ISO 8601 timestamp the verdict was recorded. */
	stampedAt: string;
}

/** Where in the codebase the finding points. */
export interface FindingLocation {
	/** Repo-relative file path. */
	file: string;
	/** 1-based line number (inclusive). */
	line: number;
	/** Pinned commit SHA the cite applies to. */
	commitSha: string;
}

/** Prior art reference added by Pass 2 / Pass 3. */
export interface PriorArtRef {
	/** Canonical id (CVE-2024-xxxx, GHSA-xxxx, blog url). */
	id: string;
	/** Source bucket. */
	kind:
		| "cve"
		| "ghsa"
		| "hackerone"
		| "vendor-advisory"
		| "academic-paper"
		| "blog-post"
		| "talk"
		| "other";
	/** One-line description / title. */
	summary: string;
}

/** Canonical per-finding record. */
export interface JuryFindingRecord {
	/** Stable finding id (orchestrator-assigned, never recycled). */
	id: string;
	/** Schema version. */
	version: number;
	/** Audit area the finding belongs to (auth, ssrf, deserialization, ...). */
	area: string;
	/** Short human-readable title. */
	title: string;
	/** Severity tier (drives synthesis). */
	proposedSeverity: FindingSeverity;
	/** Where the finding points. */
	location: FindingLocation;
	/** 5–10 lines of code around the cited line. */
	codeQuote: string;
	/** All verdicts recorded against this finding, in stamp order. */
	verdicts: JurorVerdict[];
	/** Prior art added by Pass 2. */
	priorArt: PriorArtRef[];
	/** Prior art added by Pass 3 (research breadcrumbs). */
	priorArtDeep: PriorArtRef[];
	/** Current overall state. */
	state: FindingState;
	/** ISO 8601 timestamp the finding was first proposed (Pass 0). */
	proposedAt: string;
	/** ISO 8601 timestamp of the most recent state change. */
	updatedAt: string;
}

/**
 * Coarse finding state after synthesis. Drives whether the finding
 * proceeds to the next pass.
 */
export type FindingState =
	| "proposed" // Pass 0 only — not yet judged.
	| "promoted" // Survived the latest pass; eligible for the next pass.
	| "demoted" // Demoted by a pass; out of the funnel.
	| "needs-context" // Pass 1 couldn't classify; trigger recursion.
	| "red-team-survived"; // Pass 8 didn't break it; highest confidence tier.

export const JURY_RECORD_VERSION = 1;

/**
 * Default audit areas the orchestrator uses when scope = auto. The
 * list is intentionally over-inclusive — Pass 0 explicitly biases
 * toward false positives; downstream passes filter.
 */
export const DEFAULT_AUDIT_AREAS: readonly string[] = [
	"authentication",
	"authorization",
	"session-management",
	"cryptography",
	"storage",
	"ipc-rpc",
	"api-surface",
	"deserialization",
	"templating",
	"parser-surface",
	"ffi",
	"subprocess",
	"path-handling",
	"ssrf",
	"csrf-cors",
	"content-security",
	"audit-trails",
	"error-handling",
	"concurrency",
	"memory-safety",
	"supply-chain",
	"iac",
	"ci-cd",
	"secrets-management",
	"time-clock",
	"rate-limiting",
	"multi-tenant-isolation",
	"llm-prompt-construction",
	"llm-output-handling",
	"llm-agency-tool-permissions",
	"llm-consumption-bounds",
];

/** Build a fresh finding record from a Pass 0 proposal. */
export function makeFindingRecord(input: {
	id: string;
	area: string;
	title: string;
	proposedSeverity: FindingSeverity;
	location: FindingLocation;
	codeQuote: string;
	proposedAt: string;
}): JuryFindingRecord {
	if (!input.id.trim()) {
		throw new Error("finding id is required");
	}
	if (!input.area.trim()) {
		throw new Error("finding area is required");
	}
	if (!input.title.trim()) {
		throw new Error("finding title is required");
	}
	if (input.location.line < 1) {
		throw new Error("finding location.line must be >= 1");
	}
	return {
		id: input.id,
		version: JURY_RECORD_VERSION,
		area: input.area,
		title: input.title,
		proposedSeverity: input.proposedSeverity,
		location: input.location,
		codeQuote: input.codeQuote,
		verdicts: [],
		priorArt: [],
		priorArtDeep: [],
		state: "proposed",
		proposedAt: input.proposedAt,
		updatedAt: input.proposedAt,
	};
}

/** Append a juror verdict to the record. Returns a new record (no mutation). */
export function appendVerdict(
	record: JuryFindingRecord,
	verdict: JurorVerdict,
): JuryFindingRecord {
	return {
		...record,
		verdicts: [...record.verdicts, verdict],
		updatedAt: verdict.stampedAt,
	};
}

/** Append a prior-art reference (Pass 2). */
export function appendPriorArt(
	record: JuryFindingRecord,
	ref: PriorArtRef,
): JuryFindingRecord {
	return {
		...record,
		priorArt: [...record.priorArt, ref],
		updatedAt: new Date().toISOString(),
	};
}

/** Append a deep prior-art reference (Pass 3). */
export function appendPriorArtDeep(
	record: JuryFindingRecord,
	ref: PriorArtRef,
): JuryFindingRecord {
	return {
		...record,
		priorArtDeep: [...record.priorArtDeep, ref],
		updatedAt: new Date().toISOString(),
	};
}

/**
 * Return the set of model families that have voted on a given pass.
 * Used by the orchestrator to enforce family diversity across the
 * pipeline (Pass 1 jurors, Pass 4 tracer, Pass 8 red-teamer must each
 * be on a distinct family).
 */
export function modelFamiliesAtPass(
	record: JuryFindingRecord,
	pass: JuryPassId,
): Set<string> {
	const families = new Set<string>();
	for (const v of record.verdicts) {
		if (v.pass === pass) {
			families.add(v.modelFamily);
		}
	}
	return families;
}

/**
 * Choose a synthesis rule based on severity. CRITICAL findings require
 * unanimous juror agreement to promote; HIGH/MEDIUM/LOW use a majority
 * vote. INFO is informational only — passes without a synthesis check.
 */
export function synthesisRuleFor(
	severity: FindingSeverity,
): "unanimous" | "majority" | "informational" {
	if (severity === "critical") return "unanimous";
	if (severity === "info") return "informational";
	return "majority";
}

/**
 * Apply Pass 1 synthesis: given the Pass 1 verdicts on a finding,
 * return the next state. Promotes if CONFIRMED meets the synthesis
 * rule; demotes if DISPUTED meets the rule; otherwise needs-context.
 */
export function synthesizePass1(record: JuryFindingRecord): FindingState {
	// Verdicts are append-only; a juror that initially voted NEEDS-CONTEXT
	// and later re-voted CONFIRMED has two Pass 1 entries. Synthesis must
	// see only the latest verdict per juror — otherwise stale stamps
	// (NEEDS-CONTEXT, DISPUTED) block retries from progressing. This mirrors
	// the latest-wins rule in `synthesizePass8`.
	const latestByJuror = new Map<string, JurorVerdict>();
	for (const v of record.verdicts) {
		if (v.pass !== 1) continue;
		const prior = latestByJuror.get(v.jurorId);
		if (!prior || prior.stampedAt <= v.stampedAt) {
			latestByJuror.set(v.jurorId, v);
		}
	}
	const pass1 = Array.from(latestByJuror.values());
	if (pass1.length === 0) {
		return record.state;
	}
	const counts: Record<Pass1Verdict, number> = {
		CONFIRMED: 0,
		DISPUTED: 0,
		"NEEDS-CONTEXT": 0,
	};
	const validVerdicts: ReadonlySet<Pass1Verdict> = new Set([
		"CONFIRMED",
		"DISPUTED",
		"NEEDS-CONTEXT",
	]);
	const invalid: string[] = [];
	for (const v of pass1) {
		// Avoid the `in` operator here: 'toString' / 'constructor' / 'hasOwnProperty'
		// inherit from Object.prototype and would be classified as valid Pass 1
		// verdicts, silently inflating the majority count.
		if (validVerdicts.has(v.classification as Pass1Verdict)) {
			counts[v.classification as Pass1Verdict] += 1;
		} else {
			invalid.push(v.classification);
		}
	}
	// Unknown classifications skew counts silently — refuse to synthesize
	// rather than letting a stray verdict gerrymander the majority.
	if (invalid.length > 0) {
		throw new Error(
			`synthesizePass1: unknown Pass 1 classification(s) ${invalid
				.map((s) => `"${s}"`)
				.join(
					", ",
				)} on finding "${record.id}"; expected one of CONFIRMED / DISPUTED / NEEDS-CONTEXT`,
		);
	}
	if (counts["NEEDS-CONTEXT"] > 0) {
		return "needs-context";
	}
	const rule = synthesisRuleFor(record.proposedSeverity);
	if (rule === "unanimous") {
		return counts.CONFIRMED === pass1.length ? "promoted" : "demoted";
	}
	if (rule === "majority") {
		if (counts.CONFIRMED > counts.DISPUTED) {
			return "promoted";
		}
		if (counts.DISPUTED > counts.CONFIRMED) {
			return "demoted";
		}
		return "needs-context";
	}
	// informational — info-severity findings have no synthesis bar; once
	// Pass 1 verdicts arrive without a NEEDS-CONTEXT request they always
	// advance to the next pass.
	return "promoted";
}

/**
 * Apply Pass 8 synthesis using the latest red-team verdict on a finding.
 * SURVIVED → red-team-survived (highest confidence); DISPROVED →
 * demoted; INCONCLUSIVE leaves state as-is for orchestrator policy.
 */
export function synthesizePass8(record: JuryFindingRecord): FindingState {
	let pass8: JurorVerdict | undefined;
	for (let i = record.verdicts.length - 1; i >= 0; i -= 1) {
		const verdict = record.verdicts[i];
		if (verdict?.pass === 8) {
			pass8 = verdict;
			break;
		}
	}
	if (!pass8) {
		return record.state;
	}
	const c = pass8.classification as Pass8Verdict;
	if (c === "RED-TEAM-INCONCLUSIVE") return record.state;
	if (c === "RED-TEAM-SURVIVED") return "red-team-survived";
	if (c === "RED-TEAM-DISPROVED") return "demoted";
	throw new Error(
		`synthesizePass8: unknown Pass 8 classification "${pass8.classification}" on finding "${record.id}"; expected one of RED-TEAM-SURVIVED / RED-TEAM-DISPROVED / RED-TEAM-INCONCLUSIVE`,
	);
}

/**
 * Mark the record's state explicitly (the orchestrator calls this
 * after applying a synthesis rule). Returns a new record.
 */
export function withState(
	record: JuryFindingRecord,
	state: FindingState,
	now: string = new Date().toISOString(),
): JuryFindingRecord {
	return { ...record, state, updatedAt: now };
}

/**
 * Summary statistics across a collection of findings.
 */
export function summarizeFindings(records: readonly JuryFindingRecord[]): {
	total: number;
	byState: Record<FindingState, number>;
	bySeverity: Record<FindingSeverity, number>;
	byArea: Record<string, number>;
} {
	const byState: Record<FindingState, number> = {
		proposed: 0,
		promoted: 0,
		demoted: 0,
		"needs-context": 0,
		"red-team-survived": 0,
	};
	const bySeverity: Record<FindingSeverity, number> = {
		critical: 0,
		high: 0,
		medium: 0,
		low: 0,
		info: 0,
	};
	const byArea: Record<string, number> = {};
	for (const r of records) {
		byState[r.state] += 1;
		bySeverity[r.proposedSeverity] += 1;
		byArea[r.area] = (byArea[r.area] ?? 0) + 1;
	}
	return {
		total: records.length,
		byState,
		bySeverity,
		byArea,
	};
}
