import chalk from "chalk";
import {
	badge,
	contextualBadge,
	muted,
	sectionHeading,
	separator as themedSeparator,
} from "../../style/theme.js";
import {
	type UsageEntry,
	type UsageFilterOptions,
	exportUsageToCSV,
	exportUsageToJSON,
	getUsageEntries,
	getUsageSummary,
} from "../../tracking/cost-tracker.js";

interface StatsOptions {
	sessionId?: string;
	format?: string;
}

interface TimeRange {
	since?: number;
	until?: number;
	label: string;
}

export async function handleStatsCommand(
	period?: string,
	options: StatsOptions = {},
): Promise<void> {
	const range = resolveStatsRange(period, Boolean(options.sessionId));
	const filters: UsageFilterOptions = {
		since: range.since,
		until: range.until,
		sessionId: options.sessionId,
	};

	if (options.format === "json") {
		console.log(exportUsageToJSON({ ...filters, pretty: true }));
		return;
	}
	if (options.format === "csv") {
		console.log(exportUsageToCSV(filters));
		return;
	}

	const summary = getUsageSummary(filters);
	const entries = getUsageEntries(filters);
	const title = options.sessionId
		? `Usage Stats (${range.label}, Session ${options.sessionId})`
		: `Usage Stats (${range.label})`;

	console.log(sectionHeading(title));

	if (summary.totalRequests === 0) {
		console.log(muted("No usage data found.\n"));
		return;
	}

	console.log(badge("Overview", undefined, "info"));
	console.log(
		`  ${badge("Requests", summary.totalRequests.toLocaleString(), "info")}`,
	);
	console.log(
		`  ${badge("Tokens", summary.totalTokens.toLocaleString(), "info")}`,
	);
	console.log(`  ${badge("Cost", `$${summary.totalCost.toFixed(4)}`, "warn")}`);
	const avgTokens = summary.totalTokens / summary.totalRequests;
	console.log(
		`  ${contextualBadge("Avg tokens", avgTokens, { warn: 4000, danger: 8000, unit: "" })}`,
	);
	console.log(
		`  ${muted("Input / output / cache")}: ${formatTokens(summary.tokensDetailed.input)} / ${formatTokens(summary.tokensDetailed.output)} / ${formatTokens(summary.tokensDetailed.cacheRead + summary.tokensDetailed.cacheWrite)}`,
	);

	const activityRange = getActivityRange(entries);
	if (activityRange) {
		console.log(`  ${muted("Activity")}: ${activityRange}`);
	}
	console.log();

	renderProviderBreakdown(summary.byProvider);
	renderModelBreakdown(summary.byModel);

	if (!options.sessionId) {
		renderSessionBreakdown(entries);
	}
}

function resolveStatsRange(
	period: string | undefined,
	hasSession: boolean,
): TimeRange {
	const now = Date.now();
	const oneDayMs = 24 * 60 * 60 * 1000;
	const defaultPeriod = hasSession ? "all" : "week";

	switch (period ?? defaultPeriod) {
		case "today":
			return {
				since: new Date().setHours(0, 0, 0, 0),
				label: "Today",
			};
		case "yesterday": {
			const yesterday = new Date();
			yesterday.setDate(yesterday.getDate() - 1);
			return {
				since: yesterday.setHours(0, 0, 0, 0),
				until: new Date().setHours(0, 0, 0, 0),
				label: "Yesterday",
			};
		}
		case "month":
		case "30d":
			return {
				since: now - 30 * oneDayMs,
				label: "Last 30 Days",
			};
		case "week":
		case "7d":
			return {
				since: now - 7 * oneDayMs,
				label: "Last 7 Days",
			};
	}
	return { label: "All Time" };
}

function renderProviderBreakdown(
	byProvider: ReturnType<typeof getUsageSummary>["byProvider"],
) {
	const providers = Object.entries(byProvider).sort(
		(a, b) => b[1].cost - a[1].cost,
	);
	if (providers.length === 0) return;

	console.log(badge("By Provider", undefined, "info"));
	for (const [provider, data] of providers) {
		const metrics = [
			badge("req", data.requests.toString(), "info"),
			badge("tok", formatTokens(data.tokens), "info"),
			badge("cost", `$${data.cost.toFixed(4)}`, "warn"),
		];
		console.log(
			`  ${chalk.cyan(provider.padEnd(16))} ${metrics.join(themedSeparator())}`,
		);
	}
	console.log();
}

function renderModelBreakdown(
	byModel: ReturnType<typeof getUsageSummary>["byModel"],
) {
	const models = Object.entries(byModel)
		.sort((a, b) => b[1].cost - a[1].cost)
		.slice(0, 10);
	if (models.length === 0) return;

	console.log(badge("Top Models", undefined, "info"));
	for (const [model, data] of models) {
		const metrics = [
			badge("req", data.requests.toString(), "info"),
			badge("tok", formatTokens(data.tokens), "info"),
			badge("cost", `$${data.cost.toFixed(4)}`, "warn"),
		];
		console.log(
			`  ${chalk.dim(model.padEnd(32))} ${metrics.join(themedSeparator())}`,
		);
	}
	console.log();
}

function renderSessionBreakdown(entries: UsageEntry[]) {
	const sessions = aggregateSessions(entries);
	if (sessions.length === 0) return;

	console.log(badge("Top Sessions", undefined, "info"));
	for (const session of sessions.slice(0, 10)) {
		const metrics = [
			badge("req", session.requests.toString(), "info"),
			badge("tok", formatTokens(session.tokens), "info"),
			badge("cost", `$${session.cost.toFixed(4)}`, "warn"),
		];
		console.log(
			`  ${chalk.dim(session.sessionId.padEnd(32))} ${metrics.join(themedSeparator())}`,
		);
	}
	console.log();
}

function aggregateSessions(entries: UsageEntry[]) {
	const grouped = new Map<
		string,
		{ sessionId: string; requests: number; tokens: number; cost: number }
	>();

	for (const entry of entries) {
		if (!entry.sessionId) continue;
		const current = grouped.get(entry.sessionId) ?? {
			sessionId: entry.sessionId,
			requests: 0,
			tokens: 0,
			cost: 0,
		};
		current.requests += 1;
		current.tokens += totalTokens(entry);
		current.cost += entry.cost;
		grouped.set(entry.sessionId, current);
	}

	return [...grouped.values()].sort((a, b) => b.cost - a.cost);
}

function getActivityRange(entries: UsageEntry[]): string | null {
	if (entries.length === 0) return null;
	const timestamps = entries.map((entry) => entry.timestamp);
	const first = new Date(Math.min(...timestamps)).toISOString();
	const last = new Date(Math.max(...timestamps)).toISOString();
	return first === last ? first : `${first} to ${last}`;
}

function totalTokens(entry: UsageEntry): number {
	return (
		entry.tokensInput +
		entry.tokensOutput +
		(entry.tokensCacheRead ?? 0) +
		(entry.tokensCacheWrite ?? 0)
	);
}

function formatTokens(tokens: number): string {
	if (tokens < 1000) return tokens.toString();
	if (tokens < 1000000) return `${(tokens / 1000).toFixed(1)}K`;
	return `${(tokens / 1000000).toFixed(1)}M`;
}
