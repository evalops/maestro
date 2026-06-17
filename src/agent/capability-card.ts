/**
 * Model Capability Cards
 *
 * For an EvalOps-shaped router, each candidate model carries a capability
 * card: a structured record of strengths, weaknesses, and per-task
 * score examples drawn from real eval runs. The classifier consults
 * the cards when ranking candidates for the current turn.
 *
 * ## What a card encodes
 *
 *   strengths   — task categories where the model performs well
 *                 ("standard server/infra", "git archaeology",
 *                 "constraint satisfaction")
 *   weaknesses  — task categories where the model is known to fail
 *                 ("COBOL business logic", "x86-64 assembly",
 *                 "byte-identical output preservation")
 *   scoreExamples — paired (task, score) anchors from eval runs.
 *                 The classifier looks for the closest match and
 *                 borrows that score as its prior.
 *   capabilities  — boolean toggles for hard-reject signals
 *                 (images: not_supported → must score 0.0 on any
 *                 task that requires image input).
 *
 * ## What this module is and isn't
 *
 * Pure data + typed accessors + a simple matcher. No LLM calls, no
 * classifier wiring; the router consumer in part 2 of #2663 hands
 * cards to the classifier prompt and uses the helpers here to find
 * the closest score example.
 */

/** A scored eval task used as an anchor in the card. */
export interface ScoreExample {
	/** Task description as it appears in the card prompt. */
	task: string;
	/**
	 * Predicted first-attempt success rate on this task, in [0, 1].
	 * 1.0 reserved for near-certain success.
	 */
	score: number;
	/** Optional short rationale shown alongside the score. */
	reason?: string;
}

/** Boolean capability toggles the router uses for hard-reject paths. */
export interface ModelCapabilities {
	/**
	 * Image input support: "full" passes through, "basic" is acceptable
	 * for simple multimodal tasks, "not_supported" forces a 0.0 score
	 * on any task that requires image input.
	 */
	images?: "full" | "basic" | "not_supported";
	/** Whether the model supports tool/function calling. */
	toolCalling?: boolean;
	/** Whether the model produces reliable structured (JSON-mode) output. */
	structuredOutput?: boolean;
}

/** Per-model card. One per candidate the router can pick from. */
export interface CapabilityCard {
	/** Model identifier (e.g. "claude-opus-4-7"). */
	modelId: string;
	/** Stable display name for UI / logs. */
	displayName: string;
	/** Card schema version for forward-compatible migrations. */
	version: number;
	/** ISO 8601 last update timestamp. */
	updatedAt: string;
	/** Boolean capability toggles. */
	capabilities: ModelCapabilities;
	/** Task categories where the model performs well. */
	strengths: string[];
	/** Task categories where the model is known to fail. */
	weaknesses: string[];
	/** Scored eval task anchors used by the classifier. */
	scoreExamples: ScoreExample[];
}

/** Schema version emitted by `makeCapabilityCard`. */
export const CAPABILITY_CARD_VERSION = 1;

export type CapabilityCardInput = Omit<CapabilityCard, "version">;

const IMAGE_CAPABILITY_VALUES = ["full", "basic", "not_supported"] as const;

function isImageCapabilityValue(
	value: unknown,
): value is NonNullable<ModelCapabilities["images"]> {
	return IMAGE_CAPABILITY_VALUES.includes(
		value as NonNullable<ModelCapabilities["images"]>,
	);
}

function getImageSupportBucket(
	value: unknown,
): "full" | "basic" | "not_supported" | "unknown" {
	return isImageCapabilityValue(value) ? value : "unknown";
}

/** Result of validateCapabilityCard — pass or a structured fail. */
export type CapabilityCardValidation =
	| { ok: true; card: CapabilityCard }
	| { ok: false; reasons: string[] };

/**
 * Validate and normalize a card. Trims string fields, drops empty
 * entries from strengths/weaknesses, and reports every problem in one
 * pass so callers can render an actionable error rather than fix one
 * thing at a time.
 */
export function validateCapabilityCard(
	input: CapabilityCardInput,
): CapabilityCardValidation {
	const reasons: string[] = [];
	const modelId = typeof input.modelId === "string" ? input.modelId.trim() : "";
	if (typeof input.modelId !== "string") {
		reasons.push("modelId must be a string");
	}
	if (!modelId) {
		reasons.push("modelId is required");
	}
	const displayName =
		typeof input.displayName === "string" ? input.displayName.trim() : "";
	if (typeof input.displayName !== "string") {
		reasons.push("displayName must be a string");
	}
	if (!displayName) {
		reasons.push("displayName is required");
	}
	const updatedAt =
		typeof input.updatedAt === "string" ? input.updatedAt.trim() : "";
	if (typeof input.updatedAt !== "string") {
		// Match the wording of `modelId` / `displayName` so callers
		// fixing a wrong-typed `updatedAt` know it's a type error, not a
		// missing-field error.
		reasons.push("updatedAt must be a string");
	}
	if (!updatedAt) {
		reasons.push("updatedAt is required");
	}
	if (!Array.isArray(input.strengths)) {
		reasons.push("strengths must be an array");
	} else {
		for (let i = 0; i < input.strengths.length; i += 1) {
			if (typeof input.strengths[i] !== "string") {
				reasons.push(`strengths[${i}] must be a string`);
			}
		}
	}
	if (!Array.isArray(input.weaknesses)) {
		reasons.push("weaknesses must be an array");
	} else {
		for (let i = 0; i < input.weaknesses.length; i += 1) {
			if (typeof input.weaknesses[i] !== "string") {
				reasons.push(`weaknesses[${i}] must be a string`);
			}
		}
	}
	if (
		input.capabilities !== undefined &&
		(input.capabilities === null ||
			typeof input.capabilities !== "object" ||
			Array.isArray(input.capabilities))
	) {
		reasons.push("capabilities must be an object");
	}
	if (
		input.capabilities?.images !== undefined &&
		!isImageCapabilityValue(input.capabilities.images)
	) {
		reasons.push(
			'capabilities.images must be "full", "basic", or "not_supported"',
		);
	}
	if (
		input.capabilities?.toolCalling !== undefined &&
		typeof input.capabilities.toolCalling !== "boolean"
	) {
		reasons.push("capabilities.toolCalling must be a boolean");
	}
	if (
		input.capabilities?.structuredOutput !== undefined &&
		typeof input.capabilities.structuredOutput !== "boolean"
	) {
		reasons.push("capabilities.structuredOutput must be a boolean");
	}
	if (!Array.isArray(input.scoreExamples)) {
		reasons.push("scoreExamples must be an array");
	}
	if (Array.isArray(input.scoreExamples)) {
		for (let i = 0; i < input.scoreExamples.length; i += 1) {
			const ex = input.scoreExamples[i];
			if (!ex || typeof ex !== "object") {
				reasons.push(`scoreExamples[${i}] must be an object`);
				continue;
			}
			if (typeof ex.task !== "string" || !ex.task.trim()) {
				reasons.push(`scoreExamples[${i}].task is required`);
			}
			if (
				typeof ex.score !== "number" ||
				!Number.isFinite(ex.score) ||
				ex.score < 0 ||
				ex.score > 1
			) {
				reasons.push(`scoreExamples[${i}].score must be a number in [0, 1]`);
			}
		}
	}
	if (reasons.length > 0) {
		return { ok: false, reasons };
	}

	const card: CapabilityCard = {
		modelId: modelId as string,
		displayName: displayName as string,
		version: CAPABILITY_CARD_VERSION,
		updatedAt,
		capabilities: { ...input.capabilities },
		strengths: input.strengths.map((s) => s.trim()).filter((s) => s.length > 0),
		weaknesses: input.weaknesses
			.map((w) => w.trim())
			.filter((w) => w.length > 0),
		scoreExamples: input.scoreExamples.map((ex) => {
			const trimmedReason =
				typeof ex.reason === "string" ? ex.reason.trim() : undefined;
			return {
				task: ex.task.trim(),
				score: ex.score,
				...(trimmedReason ? { reason: trimmedReason } : {}),
			};
		}),
	};
	return { ok: true, card };
}

/** Throwing wrapper for callers that prefer exceptions over results. */
export function makeCapabilityCard(input: CapabilityCardInput): CapabilityCard {
	const result = validateCapabilityCard(input);
	if (!result.ok) {
		throw new Error(
			`Invalid capability card for "${input.modelId}": ${result.reasons.join("; ")}`,
		);
	}
	return result.card;
}

/** Look up a card by modelId from a collection. */
export function findCardByModelId(
	cards: readonly CapabilityCard[],
	modelId: string,
): CapabilityCard | undefined {
	return cards.find((c) => c.modelId === modelId);
}

/**
 * Hard-reject signal: returns true when the card has a capability that
 * forbids the candidate from attempting the task. The router scores
 * 0.0 for any candidate this returns true on; the candidate is
 * effectively excluded from selection.
 */
export function isHardRejected(
	card: CapabilityCard,
	requirements: { requiresImages?: boolean; requiresTools?: boolean },
): boolean {
	if (
		requirements.requiresImages &&
		card.capabilities.images === "not_supported"
	) {
		return true;
	}
	if (requirements.requiresTools && card.capabilities.toolCalling === false) {
		return true;
	}
	return false;
}

/**
 * Lightweight task match score: counts overlapping lowercased tokens
 * between the task and the example. Tokens shorter than 3 characters
 * are ignored. This is intentionally simple — the classifier LLM
 * does the real similarity work; this helper just biases prioritization
 * when callers want to surface the *most relevant* example to a user.
 */
export function tokenOverlap(taskA: string, taskB: string): number {
	const tokensOf = (s: string): Set<string> => {
		return new Set(
			s
				.toLowerCase()
				.split(/[^a-z0-9]+/)
				.filter((t) => t.length >= 3),
		);
	};
	const a = tokensOf(taskA);
	const b = tokensOf(taskB);
	let overlap = 0;
	for (const t of a) {
		if (b.has(t)) overlap += 1;
	}
	return overlap;
}

/**
 * Find the most token-similar score example for a task. Returns null
 * when the card has no examples or when nothing matches at all.
 */
export function findClosestScoreExample(
	card: CapabilityCard,
	task: string,
): ScoreExample | null {
	let best: ScoreExample | null = null;
	let bestOverlap = 0;
	for (const ex of card.scoreExamples) {
		const overlap = tokenOverlap(task, ex.task);
		if (overlap > bestOverlap) {
			best = ex;
			bestOverlap = overlap;
		}
	}
	return best;
}

/**
 * Quick stats helper for surface-level UI: counts cards per
 * image-support tier and per-score band.
 */
export function summarizeCards(cards: readonly CapabilityCard[]): {
	total: number;
	byImageSupport: Record<
		"full" | "basic" | "not_supported" | "unknown",
		number
	>;
	highScoreExamples: number;
	lowScoreExamples: number;
} {
	const byImageSupport: Record<
		"full" | "basic" | "not_supported" | "unknown",
		number
	> = {
		full: 0,
		basic: 0,
		not_supported: 0,
		unknown: 0,
	};
	let highScoreExamples = 0;
	let lowScoreExamples = 0;
	for (const c of cards) {
		const bucket = getImageSupportBucket(c.capabilities.images);
		byImageSupport[bucket] += 1;
		for (const ex of c.scoreExamples) {
			if (ex.score >= 0.9) highScoreExamples += 1;
			if (ex.score <= 0.2) lowScoreExamples += 1;
		}
	}
	return {
		total: cards.length,
		byImageSupport,
		highScoreExamples,
		lowScoreExamples,
	};
}
