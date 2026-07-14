/**
 * Painter cost estimation and spend ceiling.
 *
 * Image generation is metered per-image and prices are not exposed on the API
 * response in a stable field, so pre-call gating needs a price table. We do
 * NOT ship fabricated prices: the default table is empty and the ceiling only
 * enforces when an operator configures both `MAESTRO_PAINTER_PRICE_TABLE` and
 * `MAESTRO_PAINTER_MAX_COST_CENTS`. When prices are unknown, the gate fails
 * OPEN (allows the call) and surfaces a reason, rather than blocking work on
 * missing data.
 *
 * Price table shape (JSON env): keyed by `${model}|${size}|${quality}` →
 * whole cents per image. A `*` wildcard is allowed for size and quality, e.g.
 * `{"gpt-image-2|*|high": 8}`. Lookups prefer the most specific key.
 *
 * @module services/image-providers/cost
 */

import { createLogger } from "../../utils/logger.js";

const logger = createLogger("painter:cost");

export interface CostInput {
	model: string;
	size?: string;
	quality?: string;
	n?: number;
}

export interface BudgetDecision {
	ok: boolean;
	/** True when a ceiling is configured and prices are known. */
	enforced: boolean;
	estimatedCents?: number;
	cumulativeCents: number;
	ceilingCents?: number;
	reason?: string;
}

export interface PriceTable {
	/** key `${model}|${size}|${quality}` → cents per image */
	[key: string]: number;
}

function priceTableFromEnv(): PriceTable {
	const raw = process.env.MAESTRO_PAINTER_PRICE_TABLE?.trim();
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const table: PriceTable = {};
			for (const [k, v] of Object.entries(parsed)) {
				if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
					table[k] = Math.floor(v);
				}
			}
			return table;
		}
		logger.warn("MAESTRO_PAINTER_PRICE_TABLE is not a JSON object; ignoring");
	} catch {
		logger.warn("MAESTRO_PAINTER_PRICE_TABLE is not valid JSON; ignoring");
	}
	return {};
}

function lookupCents(
	table: PriceTable,
	model: string,
	size: string,
	quality: string,
): number | undefined {
	const keys = [
		`${model}|${size}|${quality}`,
		`${model}|${size}|*`,
		`${model}|*|${quality}`,
		`${model}|*|*`,
	];
	for (const k of keys) {
		if (k in table) return table[k];
	}
	return undefined;
}

/**
 * Estimate the cost in whole cents for a single image-API request. Returns
 * `undefined` when no matching price is configured.
 */
export function estimateImageCost(input: CostInput): number | undefined {
	const table = getPriceTable();
	const size = (input.size ?? "auto").toString();
	const quality = (input.quality ?? "auto").toString();
	const per = lookupCents(table, input.model, size, quality);
	if (per === undefined) return undefined;
	return per * Math.max(1, input.n ?? 1);
}

/**
 * Cached parsed price table, invalidated when MAESTRO_PAINTER_PRICE_TABLE
 * changes. Env is immutable over a process lifetime in production, so this
 * JSON.parses at most once; tests that mutate the env still re-parse because
 * the cache key is the raw env string.
 */
let priceTableKey: string | undefined;
let priceTableCache: PriceTable = {};

function getPriceTable(): PriceTable {
	const key = process.env.MAESTRO_PAINTER_PRICE_TABLE;
	if (key !== priceTableKey) {
		priceTableCache = priceTableFromEnv();
		priceTableKey = key;
	}
	return priceTableCache;
}

/**
 * Process-level spend accumulator with an optional ceiling. Singleton so
 * multiple painter calls within one agent process share a budget. Reset
 * between sessions by the caller (or by process restart).
 */
export class PainterBudget {
	private spent = 0;

	/** Whole cents; undefined when no ceiling is configured. */
	readonly ceilingCents: number | undefined;

	constructor() {
		const raw = process.env.MAESTRO_PAINTER_MAX_COST_CENTS?.trim();
		if (raw) {
			const parsed = Number.parseInt(raw, 10);
			this.ceilingCents =
				Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
		}
	}

	reset(): void {
		this.spent = 0;
	}

	/**
	 * Release previously reserved cents, e.g. when the API call failed and the
	 * provider did not charge. Clamped at zero so a buggy caller can't go
	 * negative and effectively raise the ceiling.
	 */
	release(cents: number): void {
		if (cents > 0) this.spent = Math.max(0, this.spent - cents);
	}

	get cumulativeCents(): number {
		return this.spent;
	}

	/**
	 * Check the request against the ceiling and reserve the estimate when
	 * allowed. Fails open when the ceiling or prices are unknown.
	 */
	checkAndReserve(input: CostInput): BudgetDecision {
		const ceiling = this.ceilingCents;
		const estimate = estimateImageCost(input);

		if (ceiling === undefined) {
			return { ok: true, enforced: false, cumulativeCents: this.spent };
		}

		if (estimate === undefined) {
			return {
				ok: true,
				enforced: false,
				cumulativeCents: this.spent,
				ceilingCents: ceiling,
				reason:
					"cost ceiling set but no price configured for this model/size/quality; gate disabled",
			};
		}

		if (this.spent + estimate > ceiling) {
			return {
				ok: false,
				enforced: true,
				estimatedCents: estimate,
				cumulativeCents: this.spent,
				ceilingCents: ceiling,
				reason: `painter cost ceiling would be exceeded (${this.spent} + ${estimate} > ${ceiling} cents)`,
			};
		}

		this.spent += estimate;
		return {
			ok: true,
			enforced: true,
			estimatedCents: estimate,
			cumulativeCents: this.spent,
			ceilingCents: ceiling,
		};
	}
}

let singleton: PainterBudget | null = null;

/** Process-wide budget. Re-evaluates the ceiling env on first access only. */
export function getPainterBudget(): PainterBudget {
	if (!singleton) singleton = new PainterBudget();
	return singleton;
}

/** Test-only: discard the cached budget so env changes take effect. */
export function resetPainterBudgetSingleton(): void {
	singleton = null;
}
