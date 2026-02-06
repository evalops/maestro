/**
 * Session Cost Tracker
 *
 * Tracks API costs in real-time and enforces budget limits to prevent
 * runaway spending. Essential for autonomous agent operations.
 *
 * ## Features
 *
 * - Real-time cost tracking per provider/model
 * - Session budget limits with soft/hard thresholds
 * - Cost alerts and warnings
 * - Detailed breakdown by tool/operation
 *
 * ## Usage
 *
 * ```typescript
 * import { costTracker } from "./cost-tracker.js";
 *
 * // Set session budget
 * costTracker.setBudget({ hardLimit: 5.00, softLimit: 4.00 });
 *
 * // Record usage
 * costTracker.recordUsage({
 *   provider: "anthropic",
 *   model: "claude-sonnet-4-20250514",
 *   inputTokens: 1000,
 *   outputTokens: 500,
 *   cachedTokens: 200,
 * });
 *
 * // Check if under budget
 * if (!costTracker.isUnderBudget()) {
 *   throw new Error("Session budget exceeded");
 * }
 * ```
 */

import { createLogger } from "../utils/logger.js";

const logger = createLogger("telemetry:cost-tracker");

/**
 * Pricing per million tokens (as of Jan 2025)
 * Prices in USD
 */
interface ModelPricing {
	inputPerMillion: number;
	outputPerMillion: number;
	cachedInputPerMillion?: number;
}

/**
 * Known model pricing
 * Update periodically as pricing changes
 */
const MODEL_PRICING: Record<string, ModelPricing> = {
	// Anthropic Claude 4
	"claude-sonnet-4-20250514": {
		inputPerMillion: 3,
		outputPerMillion: 15,
		cachedInputPerMillion: 0.3,
	},
	"claude-opus-4-20250514": {
		inputPerMillion: 15,
		outputPerMillion: 75,
		cachedInputPerMillion: 1.5,
	},
	"claude-opus-4-5-20251101": {
		inputPerMillion: 5,
		outputPerMillion: 25,
		cachedInputPerMillion: 0.5,
	},
	"claude-opus-4-6": {
		inputPerMillion: 5,
		outputPerMillion: 25,
		cachedInputPerMillion: 0.5,
	},

	// Anthropic Claude 3.5
	"claude-3-5-sonnet-20241022": {
		inputPerMillion: 3,
		outputPerMillion: 15,
		cachedInputPerMillion: 0.3,
	},
	"claude-3-5-haiku-20241022": {
		inputPerMillion: 0.8,
		outputPerMillion: 4,
		cachedInputPerMillion: 0.08,
	},

	// Anthropic Claude 3
	"claude-3-opus-20240229": {
		inputPerMillion: 15,
		outputPerMillion: 75,
		cachedInputPerMillion: 1.5,
	},
	"claude-3-sonnet-20240229": {
		inputPerMillion: 3,
		outputPerMillion: 15,
		cachedInputPerMillion: 0.3,
	},
	"claude-3-haiku-20240307": {
		inputPerMillion: 0.25,
		outputPerMillion: 1.25,
		cachedInputPerMillion: 0.025,
	},

	// OpenAI GPT-4
	"gpt-4-turbo": { inputPerMillion: 10, outputPerMillion: 30 },
	"gpt-4-turbo-preview": { inputPerMillion: 10, outputPerMillion: 30 },
	"gpt-4o": { inputPerMillion: 5, outputPerMillion: 15 },
	"gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
	"gpt-4": { inputPerMillion: 30, outputPerMillion: 60 },

	// OpenAI o1
	o1: { inputPerMillion: 15, outputPerMillion: 60 },
	"o1-mini": { inputPerMillion: 3, outputPerMillion: 12 },
	"o1-preview": { inputPerMillion: 15, outputPerMillion: 60 },
	"o3-mini": { inputPerMillion: 1.1, outputPerMillion: 4.4 },

	// Google Gemini
	"gemini-1.5-pro": { inputPerMillion: 1.25, outputPerMillion: 5 },
	"gemini-1.5-flash": { inputPerMillion: 0.075, outputPerMillion: 0.3 },
	"gemini-2.0-flash": { inputPerMillion: 0.1, outputPerMillion: 0.4 },

	// DeepSeek
	"deepseek-chat": { inputPerMillion: 0.14, outputPerMillion: 0.28 },
	"deepseek-r1": { inputPerMillion: 0.55, outputPerMillion: 2.19 },
	"deepseek-reasoner": { inputPerMillion: 0.55, outputPerMillion: 2.19 },
};

/**
 * Default pricing for unknown models (conservative estimate)
 */
const DEFAULT_PRICING: ModelPricing = {
	inputPerMillion: 5,
	outputPerMillion: 15,
};

/**
 * Usage record for a single API call
 */
export interface UsageRecord {
	/** Provider name */
	provider: string;
	/** Model ID */
	model: string;
	/** Input tokens */
	inputTokens: number;
	/** Output tokens */
	outputTokens: number;
	/** Cached input tokens (if applicable) */
	cachedTokens?: number;
	/** Tool that triggered this usage (optional) */
	tool?: string;
	/** Timestamp */
	timestamp?: number;
}

/**
 * Budget configuration
 */
export interface BudgetConfig {
	/** Hard limit - operations blocked when exceeded */
	hardLimit?: number;
	/** Soft limit - warnings issued when exceeded */
	softLimit?: number;
	/** Per-request limit */
	perRequestLimit?: number;
	/** Alert callback when limits approached/exceeded */
	onAlert?: (alert: BudgetAlert) => void;
}

/**
 * Budget alert types
 */
export type BudgetAlertType =
	| "soft_limit_approaching"
	| "soft_limit_exceeded"
	| "hard_limit_approaching"
	| "hard_limit_exceeded"
	| "per_request_exceeded";

/**
 * Budget alert
 */
export interface BudgetAlert {
	type: BudgetAlertType;
	currentCost: number;
	limit: number;
	message: string;
}

/**
 * Cost breakdown by category
 */
export interface CostBreakdown {
	byProvider: Record<string, number>;
	byModel: Record<string, number>;
	byTool: Record<string, number>;
	inputCost: number;
	outputCost: number;
	cachedSavings: number;
}

/**
 * Session cost tracker
 */
class CostTracker {
	private records: UsageRecord[] = [];
	private budget: BudgetConfig = {};
	private alertsSent = new Set<string>();

	/**
	 * Set budget limits for the session
	 */
	setBudget(config: BudgetConfig): void {
		this.budget = config;
		this.alertsSent.clear();
		logger.info("Budget set", {
			hardLimit: config.hardLimit,
			softLimit: config.softLimit,
			perRequestLimit: config.perRequestLimit,
		});
	}

	/**
	 * Record API usage
	 */
	recordUsage(usage: UsageRecord): number {
		const record = {
			...usage,
			timestamp: usage.timestamp ?? Date.now(),
		};

		this.records.push(record);

		const cost = this.calculateCost(record);

		// Check per-request limit
		if (this.budget.perRequestLimit && cost > this.budget.perRequestLimit) {
			this.sendAlert({
				type: "per_request_exceeded",
				currentCost: cost,
				limit: this.budget.perRequestLimit,
				message: `Single request cost $${cost.toFixed(4)} exceeds limit of $${this.budget.perRequestLimit.toFixed(2)}`,
			});
		}

		// Check session limits
		this.checkBudgetLimits();

		logger.debug("Usage recorded", {
			model: usage.model,
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			cost: cost.toFixed(4),
			totalCost: this.getTotalCost().toFixed(4),
		});

		return cost;
	}

	/**
	 * Calculate cost for a single usage record
	 */
	calculateCost(usage: UsageRecord): number {
		const pricing = this.getPricing(usage.model);

		const inputCost = (usage.inputTokens / 1_000_000) * pricing.inputPerMillion;
		const outputCost =
			(usage.outputTokens / 1_000_000) * pricing.outputPerMillion;

		// Cached tokens are charged at reduced rate
		let cachedCost = 0;
		if (usage.cachedTokens && pricing.cachedInputPerMillion) {
			cachedCost =
				(usage.cachedTokens / 1_000_000) * pricing.cachedInputPerMillion;
		}

		return inputCost + outputCost + cachedCost;
	}

	/**
	 * Get pricing for a model
	 */
	getPricing(modelId: string): ModelPricing {
		// Try exact match first
		if (MODEL_PRICING[modelId]) {
			return MODEL_PRICING[modelId]!;
		}

		// Try partial match
		const normalizedId = modelId.toLowerCase();
		for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
			if (
				normalizedId.includes(key.toLowerCase()) ||
				key.toLowerCase().includes(normalizedId)
			) {
				return pricing;
			}
		}

		logger.debug("Using default pricing for unknown model", { modelId });
		return DEFAULT_PRICING;
	}

	/**
	 * Get total cost for the session
	 */
	getTotalCost(): number {
		return this.records.reduce(
			(sum, record) => sum + this.calculateCost(record),
			0,
		);
	}

	/**
	 * Get detailed cost breakdown
	 */
	getBreakdown(): CostBreakdown {
		const breakdown: CostBreakdown = {
			byProvider: {},
			byModel: {},
			byTool: {},
			inputCost: 0,
			outputCost: 0,
			cachedSavings: 0,
		};

		for (const record of this.records) {
			const pricing = this.getPricing(record.model);
			const cost = this.calculateCost(record);

			// By provider
			breakdown.byProvider[record.provider] =
				(breakdown.byProvider[record.provider] || 0) + cost;

			// By model
			breakdown.byModel[record.model] =
				(breakdown.byModel[record.model] || 0) + cost;

			// By tool
			if (record.tool) {
				breakdown.byTool[record.tool] =
					(breakdown.byTool[record.tool] || 0) + cost;
			}

			// Input/output breakdown
			breakdown.inputCost +=
				(record.inputTokens / 1_000_000) * pricing.inputPerMillion;
			breakdown.outputCost +=
				(record.outputTokens / 1_000_000) * pricing.outputPerMillion;

			// Calculate savings from caching
			if (record.cachedTokens && pricing.cachedInputPerMillion) {
				const fullCost =
					(record.cachedTokens / 1_000_000) * pricing.inputPerMillion;
				const cachedCost =
					(record.cachedTokens / 1_000_000) * pricing.cachedInputPerMillion;
				breakdown.cachedSavings += fullCost - cachedCost;
			}
		}

		return breakdown;
	}

	/**
	 * Check if session is under budget
	 */
	isUnderBudget(): boolean {
		if (!this.budget.hardLimit) return true;
		return this.getTotalCost() < this.budget.hardLimit;
	}

	/**
	 * Get remaining budget
	 */
	getRemainingBudget(): number | null {
		if (!this.budget.hardLimit) return null;
		return Math.max(0, this.budget.hardLimit - this.getTotalCost());
	}

	/**
	 * Check budget limits and send alerts
	 */
	private checkBudgetLimits(): void {
		const totalCost = this.getTotalCost();

		// Hard limit
		if (this.budget.hardLimit) {
			if (totalCost >= this.budget.hardLimit) {
				this.sendAlert({
					type: "hard_limit_exceeded",
					currentCost: totalCost,
					limit: this.budget.hardLimit,
					message: `Session cost $${totalCost.toFixed(2)} exceeds hard limit of $${this.budget.hardLimit.toFixed(2)}`,
				});
			} else if (totalCost >= this.budget.hardLimit * 0.9) {
				this.sendAlert({
					type: "hard_limit_approaching",
					currentCost: totalCost,
					limit: this.budget.hardLimit,
					message: `Session cost $${totalCost.toFixed(2)} approaching hard limit of $${this.budget.hardLimit.toFixed(2)}`,
				});
			}
		}

		// Soft limit
		if (this.budget.softLimit) {
			if (totalCost >= this.budget.softLimit) {
				this.sendAlert({
					type: "soft_limit_exceeded",
					currentCost: totalCost,
					limit: this.budget.softLimit,
					message: `Session cost $${totalCost.toFixed(2)} exceeds soft limit of $${this.budget.softLimit.toFixed(2)}`,
				});
			} else if (totalCost >= this.budget.softLimit * 0.8) {
				this.sendAlert({
					type: "soft_limit_approaching",
					currentCost: totalCost,
					limit: this.budget.softLimit,
					message: `Session cost $${totalCost.toFixed(2)} approaching soft limit of $${this.budget.softLimit.toFixed(2)}`,
				});
			}
		}
	}

	/**
	 * Send a budget alert (once per type)
	 */
	private sendAlert(alert: BudgetAlert): void {
		if (this.alertsSent.has(alert.type)) return;

		this.alertsSent.add(alert.type);
		logger.warn(alert.message, {
			type: alert.type,
			currentCost: alert.currentCost,
			limit: alert.limit,
		});

		if (this.budget.onAlert) {
			this.budget.onAlert(alert);
		}
	}

	/**
	 * Get usage statistics
	 */
	getStats(): {
		totalCost: number;
		totalRequests: number;
		totalInputTokens: number;
		totalOutputTokens: number;
		totalCachedTokens: number;
		avgCostPerRequest: number;
	} {
		const totalInputTokens = this.records.reduce(
			(sum, r) => sum + r.inputTokens,
			0,
		);
		const totalOutputTokens = this.records.reduce(
			(sum, r) => sum + r.outputTokens,
			0,
		);
		const totalCachedTokens = this.records.reduce(
			(sum, r) => sum + (r.cachedTokens || 0),
			0,
		);
		const totalCost = this.getTotalCost();

		return {
			totalCost,
			totalRequests: this.records.length,
			totalInputTokens,
			totalOutputTokens,
			totalCachedTokens,
			avgCostPerRequest:
				this.records.length > 0 ? totalCost / this.records.length : 0,
		};
	}

	/**
	 * Format cost summary for display
	 */
	formatSummary(): string {
		const stats = this.getStats();
		const breakdown = this.getBreakdown();

		const lines = [
			`Session Cost: $${stats.totalCost.toFixed(4)}`,
			`Requests: ${stats.totalRequests}`,
			`Tokens: ${stats.totalInputTokens.toLocaleString()} in / ${stats.totalOutputTokens.toLocaleString()} out`,
		];

		if (stats.totalCachedTokens > 0) {
			lines.push(
				`Cached: ${stats.totalCachedTokens.toLocaleString()} tokens (saved $${breakdown.cachedSavings.toFixed(4)})`,
			);
		}

		if (this.budget.hardLimit) {
			const remaining = this.getRemainingBudget();
			lines.push(
				`Budget: $${remaining?.toFixed(2)} remaining of $${this.budget.hardLimit.toFixed(2)}`,
			);
		}

		return lines.join("\n");
	}

	/**
	 * Reset the tracker
	 */
	reset(): void {
		this.records = [];
		this.alertsSent.clear();
		logger.info("Cost tracker reset");
	}
}

/**
 * Global cost tracker instance
 */
export const costTracker = new CostTracker();

/**
 * Helper to estimate cost before making a request
 */
export function estimateCost(
	model: string,
	estimatedInputTokens: number,
	estimatedOutputTokens: number,
): number {
	return costTracker.calculateCost({
		provider: "unknown",
		model,
		inputTokens: estimatedInputTokens,
		outputTokens: estimatedOutputTokens,
	});
}
