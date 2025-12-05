/**
 * Cost Tracker - Track API usage and costs per channel
 *
 * Records token usage from Anthropic API responses and calculates
 * estimated costs. Data is persisted to channel directories.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Claude Sonnet 4 pricing (as of 2024)
// https://www.anthropic.com/pricing
const PRICING = {
	"claude-sonnet-4-20250514": {
		inputPerMillion: 3.0,
		outputPerMillion: 15.0,
		cacheWritePerMillion: 3.75,
		cacheReadPerMillion: 0.3,
	},
	// Default fallback
	default: {
		inputPerMillion: 3.0,
		outputPerMillion: 15.0,
		cacheWritePerMillion: 3.75,
		cacheReadPerMillion: 0.3,
	},
};

export interface UsageRecord {
	timestamp: string;
	model: string;
	inputTokens: number;
	outputTokens: number;
	cacheWriteTokens?: number;
	cacheReadTokens?: number;
	estimatedCost: number;
}

export interface ChannelUsage {
	channelId: string;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheWriteTokens: number;
	totalCacheReadTokens: number;
	totalCost: number;
	requestCount: number;
	lastUpdated: string;
}

export interface UsageSummary {
	today: ChannelUsage;
	allTime: ChannelUsage;
}

export class CostTracker {
	private workingDir: string;

	constructor(workingDir: string) {
		this.workingDir = workingDir;
	}

	/**
	 * Record usage from an API response
	 */
	record(
		channelId: string,
		usage: {
			model: string;
			inputTokens: number;
			outputTokens: number;
			cacheWriteTokens?: number;
			cacheReadTokens?: number;
		},
	): UsageRecord {
		const pricing =
			PRICING[usage.model as keyof typeof PRICING] || PRICING.default;

		const inputCost = (usage.inputTokens / 1_000_000) * pricing.inputPerMillion;
		const outputCost =
			(usage.outputTokens / 1_000_000) * pricing.outputPerMillion;
		const cacheWriteCost =
			((usage.cacheWriteTokens || 0) / 1_000_000) *
			pricing.cacheWritePerMillion;
		const cacheReadCost =
			((usage.cacheReadTokens || 0) / 1_000_000) * pricing.cacheReadPerMillion;

		const estimatedCost =
			inputCost + outputCost + cacheWriteCost + cacheReadCost;

		const record: UsageRecord = {
			timestamp: new Date().toISOString(),
			model: usage.model,
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			cacheWriteTokens: usage.cacheWriteTokens,
			cacheReadTokens: usage.cacheReadTokens,
			estimatedCost,
		};

		// Append to usage log
		this.appendUsageLog(channelId, record);

		return record;
	}

	/**
	 * Get usage summary for a channel
	 */
	getSummary(channelId: string): UsageSummary {
		const records = this.loadUsageLog(channelId);
		const today = new Date().toISOString().split("T")[0];

		const todayRecords = records.filter((r) => r.timestamp.startsWith(today));

		return {
			today: this.aggregate(channelId, todayRecords),
			allTime: this.aggregate(channelId, records),
		};
	}

	/**
	 * Format usage summary for display
	 */
	formatSummary(summary: UsageSummary): string {
		const formatCost = (cost: number) => `$${cost.toFixed(4)}`;
		const formatTokens = (n: number) =>
			n > 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

		const lines: string[] = [];

		lines.push("*Usage Summary*");
		lines.push("");
		lines.push("_Today:_");
		lines.push(
			`  Requests: ${summary.today.requestCount} | Cost: ${formatCost(summary.today.totalCost)}`,
		);
		lines.push(
			`  Tokens: ${formatTokens(summary.today.totalInputTokens)} in / ${formatTokens(summary.today.totalOutputTokens)} out`,
		);

		lines.push("");
		lines.push("_All Time:_");
		lines.push(
			`  Requests: ${summary.allTime.requestCount} | Cost: ${formatCost(summary.allTime.totalCost)}`,
		);
		lines.push(
			`  Tokens: ${formatTokens(summary.allTime.totalInputTokens)} in / ${formatTokens(summary.allTime.totalOutputTokens)} out`,
		);

		return lines.join("\n");
	}

	private aggregate(channelId: string, records: UsageRecord[]): ChannelUsage {
		const result: ChannelUsage = {
			channelId,
			totalInputTokens: 0,
			totalOutputTokens: 0,
			totalCacheWriteTokens: 0,
			totalCacheReadTokens: 0,
			totalCost: 0,
			requestCount: records.length,
			lastUpdated: new Date().toISOString(),
		};

		for (const record of records) {
			result.totalInputTokens += record.inputTokens;
			result.totalOutputTokens += record.outputTokens;
			result.totalCacheWriteTokens += record.cacheWriteTokens || 0;
			result.totalCacheReadTokens += record.cacheReadTokens || 0;
			result.totalCost += record.estimatedCost;
		}

		return result;
	}

	private getUsageLogPath(channelId: string): string {
		return join(this.workingDir, channelId, "usage.jsonl");
	}

	private loadUsageLog(channelId: string): UsageRecord[] {
		const path = this.getUsageLogPath(channelId);
		if (!existsSync(path)) {
			return [];
		}

		const records: UsageRecord[] = [];
		const content = readFileSync(path, "utf-8");

		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				records.push(JSON.parse(line));
			} catch {
				// Skip malformed lines
			}
		}

		return records;
	}

	private appendUsageLog(channelId: string, record: UsageRecord): void {
		const path = this.getUsageLogPath(channelId);
		const line = `${JSON.stringify(record)}\n`;

		try {
			writeFileSync(path, line, { flag: "a" });
		} catch {
			// Directory may not exist yet, ignore
		}
	}
}
