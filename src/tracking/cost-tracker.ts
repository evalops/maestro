import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseJsonOr } from "../utils/json.js";

/**
 * Cost tracking for API usage
 * Stores usage data locally in ~/.composer/usage.json
 */

const USAGE_FILE = join(homedir(), ".composer", "usage.json");

export interface UsageEntry {
	timestamp: number; // Unix timestamp
	provider: string;
	model: string;
	tokensInput: number;
	tokensOutput: number;
	tokensCacheRead?: number;
	tokensCacheWrite?: number;
	cost: number; // in USD
}

export interface UsageTokenTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

export interface UsageSummary {
	totalCost: number;
	totalRequests: number;
	totalTokens: number;
	/** Detailed token breakdown; keeps legacy totalTokens as aggregate. */
	tokensDetailed: UsageTokenTotals;
	byProvider: Record<
		string,
		{
			cost: number;
			requests: number;
			tokens: number;
			tokensDetailed: UsageTokenTotals;
		}
	>;
	byModel: Record<
		string,
		{
			cost: number;
			requests: number;
			tokens: number;
			tokensDetailed: UsageTokenTotals;
		}
	>;
}

/**
 * Load usage data from disk
 */
function loadUsage(): UsageEntry[] {
	try {
		if (!existsSync(USAGE_FILE)) {
			return [];
		}

		const data = readFileSync(USAGE_FILE, "utf-8");
		return parseJsonOr<UsageEntry[]>(data, []);
	} catch (error) {
		console.warn("[Cost Tracking] Failed to load usage data:", error);
		return [];
	}
}

/**
 * Save usage data to disk
 */
function saveUsage(entries: UsageEntry[]): void {
	try {
		const dir = join(homedir(), ".composer");
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		writeFileSync(USAGE_FILE, JSON.stringify(entries, null, 2));
	} catch (error) {
		console.warn("[Cost Tracking] Failed to save usage data:", error);
	}
}

/**
 * Track a single API call
 */
export function trackUsage(entry: Omit<UsageEntry, "timestamp">): void {
	const entries = loadUsage();

	entries.push({
		...entry,
		timestamp: Date.now(),
	});

	// Keep only last 10,000 entries (prevent file from growing too large)
	if (entries.length > 10000) {
		entries.splice(0, entries.length - 10000);
	}

	saveUsage(entries);
}

/**
 * Get usage summary for a time period
 */
export function getUsageSummary(options?: {
	since?: number; // Unix timestamp
	until?: number; // Unix timestamp
	provider?: string;
	model?: string;
}): UsageSummary {
	const entries = loadUsage();

	// Filter entries
	const filtered = entries.filter((entry) => {
		if (options?.since && entry.timestamp < options.since) return false;
		if (options?.until && entry.timestamp > options.until) return false;
		if (options?.provider && entry.provider !== options.provider) return false;
		if (options?.model && entry.model !== options.model) return false;
		return true;
	});

	// Calculate summary
	const summary: UsageSummary = {
		totalCost: 0,
		totalRequests: filtered.length,
		totalTokens: 0,
		tokensDetailed: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
		byProvider: {},
		byModel: {},
	};

	for (const entry of filtered) {
		const tokensInput = entry.tokensInput;
		const tokensOutput = entry.tokensOutput;
		const tokensCacheRead = entry.tokensCacheRead || 0;
		const tokensCacheWrite = entry.tokensCacheWrite || 0;
		const tokens =
			tokensInput + tokensOutput + tokensCacheRead + tokensCacheWrite;

		summary.totalCost += entry.cost;
		summary.totalTokens += tokens;
		summary.tokensDetailed.input += tokensInput;
		summary.tokensDetailed.output += tokensOutput;
		summary.tokensDetailed.cacheRead += tokensCacheRead;
		summary.tokensDetailed.cacheWrite += tokensCacheWrite;
		summary.tokensDetailed.total += tokens;

		// By provider
		if (!summary.byProvider[entry.provider]) {
			summary.byProvider[entry.provider] = {
				cost: 0,
				requests: 0,
				tokens: 0,
				tokensDetailed: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
				},
			};
		}
		summary.byProvider[entry.provider].cost += entry.cost;
		summary.byProvider[entry.provider].requests += 1;
		summary.byProvider[entry.provider].tokens += tokens;
		const providerTokens = summary.byProvider[entry.provider].tokensDetailed;
		providerTokens.input += tokensInput;
		providerTokens.output += tokensOutput;
		providerTokens.cacheRead += tokensCacheRead;
		providerTokens.cacheWrite += tokensCacheWrite;
		providerTokens.total += tokens;

		// By model
		const modelKey = `${entry.provider}/${entry.model}`;
		if (!summary.byModel[modelKey]) {
			summary.byModel[modelKey] = {
				cost: 0,
				requests: 0,
				tokens: 0,
				tokensDetailed: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
				},
			};
		}
		summary.byModel[modelKey].cost += entry.cost;
		summary.byModel[modelKey].requests += 1;
		summary.byModel[modelKey].tokens += tokens;
		const modelTokens = summary.byModel[modelKey].tokensDetailed;
		modelTokens.input += tokensInput;
		modelTokens.output += tokensOutput;
		modelTokens.cacheRead += tokensCacheRead;
		modelTokens.cacheWrite += tokensCacheWrite;
		modelTokens.total += tokens;
	}

	return summary;
}

/**
 * Clear all usage data
 */
export function clearUsage(): void {
	saveUsage([]);
}

/**
 * Get usage file path
 */
export function getUsageFilePath(): string {
	return USAGE_FILE;
}

/**
 * Export usage data to CSV format
 */
export function exportUsageToCSV(options?: {
	since?: number;
	until?: number;
	provider?: string;
	model?: string;
}): string {
	const entries = loadUsage();

	// Filter entries
	const filtered = entries.filter((entry) => {
		if (options?.since && entry.timestamp < options.since) return false;
		if (options?.until && entry.timestamp > options.until) return false;
		if (options?.provider && entry.provider !== options.provider) return false;
		if (options?.model && entry.model !== options.model) return false;
		return true;
	});

	// CSV header
	const lines = [
		"Timestamp,Date,Provider,Model,Tokens Input,Tokens Output,Tokens Cache Read,Tokens Cache Write,Total Tokens,Cost (USD)",
	];

	// CSV rows
	for (const entry of filtered) {
		const date = new Date(entry.timestamp).toISOString();
		const totalTokens =
			entry.tokensInput +
			entry.tokensOutput +
			(entry.tokensCacheRead || 0) +
			(entry.tokensCacheWrite || 0);

		lines.push(
			[
				entry.timestamp,
				date,
				entry.provider,
				entry.model,
				entry.tokensInput,
				entry.tokensOutput,
				entry.tokensCacheRead || 0,
				entry.tokensCacheWrite || 0,
				totalTokens,
				entry.cost.toFixed(6),
			].join(","),
		);
	}

	return lines.join("\n");
}

/**
 * Export usage data to JSON format
 */
export function exportUsageToJSON(options?: {
	since?: number;
	until?: number;
	provider?: string;
	model?: string;
	pretty?: boolean;
}): string {
	const entries = loadUsage();

	// Filter entries
	const filtered = entries.filter((entry) => {
		if (options?.since && entry.timestamp < options.since) return false;
		if (options?.until && entry.timestamp > options.until) return false;
		if (options?.provider && entry.provider !== options.provider) return false;
		if (options?.model && entry.model !== options.model) return false;
		return true;
	});

	// Get summary
	const summary = getUsageSummary(options);

	const exportData = {
		exportedAt: new Date().toISOString(),
		filters: options || {},
		summary,
		entries: filtered.map((entry) => ({
			...entry,
			date: new Date(entry.timestamp).toISOString(),
			totalTokens:
				entry.tokensInput +
				entry.tokensOutput +
				(entry.tokensCacheRead || 0) +
				(entry.tokensCacheWrite || 0),
		})),
	};

	return options?.pretty
		? JSON.stringify(exportData, null, 2)
		: JSON.stringify(exportData);
}

/**
 * Compare usage across providers
 */
export interface ProviderComparison {
	provider: string;
	totalCost: number;
	totalRequests: number;
	totalTokens: number;
	avgCostPerRequest: number;
	avgCostPerToken: number;
	models: Record<
		string,
		{
			cost: number;
			requests: number;
			tokens: number;
		}
	>;
}

export function compareProviders(options?: {
	since?: number;
	until?: number;
}): ProviderComparison[] {
	const summary = getUsageSummary(options);
	const comparisons: ProviderComparison[] = [];

	for (const [provider, data] of Object.entries(summary.byProvider)) {
		// Get models for this provider
		const providerModels: Record<
			string,
			{ cost: number; requests: number; tokens: number }
		> = {};
		for (const [modelKey, modelData] of Object.entries(summary.byModel)) {
			if (modelKey.startsWith(`${provider}/`)) {
				const modelName = modelKey.split("/")[1];
				providerModels[modelName] = modelData;
			}
		}

		comparisons.push({
			provider,
			totalCost: data.cost,
			totalRequests: data.requests,
			totalTokens: data.tokens,
			avgCostPerRequest: data.requests > 0 ? data.cost / data.requests : 0,
			avgCostPerToken: data.tokens > 0 ? data.cost / data.tokens : 0,
			models: providerModels,
		});
	}

	// Sort by total cost descending
	return comparisons.sort((a, b) => b.totalCost - a.totalCost);
}

/**
 * Get usage trends over time
 */
export interface UsageTrend {
	date: string; // ISO date string (YYYY-MM-DD)
	cost: number;
	requests: number;
	tokens: number;
}

export function getUsageTrends(options: {
	since: number;
	until: number;
	granularity: "day" | "week" | "month";
}): UsageTrend[] {
	const entries = loadUsage().filter(
		(entry) =>
			entry.timestamp >= options.since && entry.timestamp <= options.until,
	);

	const grouped = new Map<
		string,
		{ cost: number; requests: number; tokens: number }
	>();

	for (const entry of entries) {
		const date = new Date(entry.timestamp);
		let key: string;

		switch (options.granularity) {
			case "day":
				key = date.toISOString().split("T")[0];
				break;
			case "week": {
				const weekStart = new Date(date);
				weekStart.setDate(date.getDate() - date.getDay());
				key = weekStart.toISOString().split("T")[0];
				break;
			}
			case "month":
				key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-01`;
				break;
		}

		const existing = grouped.get(key) || { cost: 0, requests: 0, tokens: 0 };
		const tokens =
			entry.tokensInput +
			entry.tokensOutput +
			(entry.tokensCacheRead || 0) +
			(entry.tokensCacheWrite || 0);

		grouped.set(key, {
			cost: existing.cost + entry.cost,
			requests: existing.requests + 1,
			tokens: existing.tokens + tokens,
		});
	}

	return Array.from(grouped.entries())
		.map(([date, data]) => ({ date, ...data }))
		.sort((a, b) => a.date.localeCompare(b.date));
}
