import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

export interface UsageSummary {
	totalCost: number;
	totalRequests: number;
	totalTokens: number;
	byProvider: Record<
		string,
		{
			cost: number;
			requests: number;
			tokens: number;
		}
	>;
	byModel: Record<
		string,
		{
			cost: number;
			requests: number;
			tokens: number;
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
		return JSON.parse(data) as UsageEntry[];
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
		byProvider: {},
		byModel: {},
	};

	for (const entry of filtered) {
		const tokens =
			entry.tokensInput +
			entry.tokensOutput +
			(entry.tokensCacheRead || 0) +
			(entry.tokensCacheWrite || 0);

		summary.totalCost += entry.cost;
		summary.totalTokens += tokens;

		// By provider
		if (!summary.byProvider[entry.provider]) {
			summary.byProvider[entry.provider] = { cost: 0, requests: 0, tokens: 0 };
		}
		summary.byProvider[entry.provider].cost += entry.cost;
		summary.byProvider[entry.provider].requests += 1;
		summary.byProvider[entry.provider].tokens += tokens;

		// By model
		const modelKey = `${entry.provider}/${entry.model}`;
		if (!summary.byModel[modelKey]) {
			summary.byModel[modelKey] = { cost: 0, requests: 0, tokens: 0 };
		}
		summary.byModel[modelKey].cost += entry.cost;
		summary.byModel[modelKey].requests += 1;
		summary.byModel[modelKey].tokens += tokens;
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
