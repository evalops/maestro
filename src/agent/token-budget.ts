const SHORTHAND_START_RE = /^\s*\+(\d+(?:\.\d+)?)\s*(k|m|b)\b/i;
const SHORTHAND_END_RE = /\s\+(\d+(?:\.\d+)?)\s*(k|m|b)\s*[.!?]?\s*$/i;
const VERBOSE_RE = /\b(?:use|spend)\s+(\d+(?:\.\d+)?)\s*(k|m|b)\s*tokens?\b/i;

const MULTIPLIERS: Record<string, number> = {
	k: 1_000,
	m: 1_000_000,
	b: 1_000_000_000,
};

const COMPLETION_THRESHOLD = 0.9;
const DIMINISHING_THRESHOLD_TOKENS = 500;
const DIMINISHING_MIN_CONTINUATIONS = 3;

function parseBudgetMatch(value: string, suffix: string): number {
	return Number.parseFloat(value) * MULTIPLIERS[suffix.toLowerCase()]!;
}

export function parseTokenBudget(text: string): number | null {
	const startMatch = text.match(SHORTHAND_START_RE);
	if (startMatch) {
		return parseBudgetMatch(startMatch[1]!, startMatch[2]!);
	}

	const endMatch = text.match(SHORTHAND_END_RE);
	if (endMatch) {
		return parseBudgetMatch(endMatch[1]!, endMatch[2]!);
	}

	const verboseMatch = text.match(VERBOSE_RE);
	if (verboseMatch) {
		return parseBudgetMatch(verboseMatch[1]!, verboseMatch[2]!);
	}

	return null;
}

export interface TokenBudgetTracker {
	continuationCount: number;
	lastDeltaTokens: number;
	lastTurnOutputTokens: number;
	startedAt: number;
}

export function createTokenBudgetTracker(): TokenBudgetTracker {
	return {
		continuationCount: 0,
		lastDeltaTokens: 0,
		lastTurnOutputTokens: 0,
		startedAt: Date.now(),
	};
}

type ContinueDecision = {
	action: "continue";
	continuationPrompt: string;
	continuationCount: number;
	pct: number;
	turnOutputTokens: number;
	budget: number;
};

type StopDecision = {
	action: "stop";
	completion: {
		continuationCount: number;
		pct: number;
		turnOutputTokens: number;
		budget: number;
		diminishingReturns: boolean;
		durationMs: number;
	} | null;
};

export type TokenBudgetDecision = ContinueDecision | StopDecision;

export function getBudgetContinuationPrompt(
	pct: number,
	turnOutputTokens: number,
	budget: number,
): string {
	const formatter = new Intl.NumberFormat("en-US");
	return `Stopped at ${pct}% of token target (${formatter.format(turnOutputTokens)} / ${formatter.format(budget)}). Keep working - do not summarize.`;
}

export function checkTokenBudget(
	tracker: TokenBudgetTracker,
	budget: number | null,
	turnOutputTokens: number,
): TokenBudgetDecision {
	if (budget === null || budget <= 0) {
		return { action: "stop", completion: null };
	}

	// Compaction can remove earlier assistant turns from local message history.
	// Keep token-budget progress monotonic so automatic continuations do not
	// regress and loop forever after a recovery compact.
	const effectiveTurnOutputTokens = Math.max(
		turnOutputTokens,
		tracker.lastTurnOutputTokens,
	);
	const pct = Math.round((effectiveTurnOutputTokens / budget) * 100);
	const deltaSinceLastCheck =
		effectiveTurnOutputTokens - tracker.lastTurnOutputTokens;
	const isDiminishing =
		tracker.continuationCount >= DIMINISHING_MIN_CONTINUATIONS &&
		deltaSinceLastCheck < DIMINISHING_THRESHOLD_TOKENS &&
		tracker.lastDeltaTokens < DIMINISHING_THRESHOLD_TOKENS;

	if (
		!isDiminishing &&
		effectiveTurnOutputTokens < budget * COMPLETION_THRESHOLD
	) {
		tracker.continuationCount += 1;
		tracker.lastDeltaTokens = deltaSinceLastCheck;
		tracker.lastTurnOutputTokens = effectiveTurnOutputTokens;
		return {
			action: "continue",
			continuationPrompt: getBudgetContinuationPrompt(
				pct,
				effectiveTurnOutputTokens,
				budget,
			),
			continuationCount: tracker.continuationCount,
			pct,
			turnOutputTokens: effectiveTurnOutputTokens,
			budget,
		};
	}

	if (isDiminishing || tracker.continuationCount > 0) {
		return {
			action: "stop",
			completion: {
				continuationCount: tracker.continuationCount,
				pct,
				turnOutputTokens: effectiveTurnOutputTokens,
				budget,
				diminishingReturns: isDiminishing,
				durationMs: Date.now() - tracker.startedAt,
			},
		};
	}

	return { action: "stop", completion: null };
}
