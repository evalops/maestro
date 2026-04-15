import chalk from "chalk";
import {
	badge,
	contextualBadge,
	muted,
	sectionHeading,
	themePalette,
	separator as themedSeparator,
} from "../../style/theme.js";
import { clearUsage, getUsageSummary } from "../../tracking/cost-tracker.js";

/**
 * Handle `maestro cost` command (default: today)
 */
export async function handleCostSummary(period?: string): Promise<void> {
	let since: number | undefined;
	let until: number | undefined;
	let label = "Total";

	const now = Date.now();
	const oneDayMs = 24 * 60 * 60 * 1000;

	switch (period) {
		case "today":
			since = new Date().setHours(0, 0, 0, 0);
			label = "Today";
			break;
		case "yesterday": {
			const yesterday = new Date();
			yesterday.setDate(yesterday.getDate() - 1);
			since = yesterday.setHours(0, 0, 0, 0);
			until = new Date().setHours(0, 0, 0, 0);
			label = "Yesterday";
			break;
		}
		case "week":
		case "7d":
			since = now - 7 * oneDayMs;
			label = "Last 7 Days";
			break;
		case "month":
		case "30d":
			since = now - 30 * oneDayMs;
			label = "Last 30 Days";
			break;
		default:
			label = "All Time";
			break;
	}

	const summary = getUsageSummary({ since, until });

	console.log(sectionHeading(`Cost Summary (${label})`));

	if (summary.totalRequests === 0) {
		console.log(muted("No usage data found.\n"));
		return;
	}

	// Overall summary
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
	console.log();

	// By provider
	if (Object.keys(summary.byProvider).length > 0) {
		console.log(badge("By Provider", undefined, "info"));
		const providers = Object.entries(summary.byProvider).sort(
			(a, b) => b[1].cost - a[1].cost,
		);

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

	// By model
	if (Object.keys(summary.byModel).length > 1) {
		console.log(badge("Top Models", undefined, "info"));
		const models = Object.entries(summary.byModel)
			.sort((a, b) => b[1].cost - a[1].cost)
			.slice(0, 10); // Top 10

		for (const [model, data] of models) {
			const detail = [
				badge("req", data.requests.toString(), "info"),
				badge("cost", `$${data.cost.toFixed(4)}`, "warn"),
			];
			console.log(
				`  ${chalk.dim(model.padEnd(32))} ${detail.join(themedSeparator())}`,
			);
		}

		if (Object.keys(summary.byModel).length > 10) {
			console.log(
				muted(
					`  ... and ${Object.keys(summary.byModel).length - 10} more models`,
				),
			);
		}
		console.log();
	}
}

/**
 * Handle `maestro cost clear` command
 */
export async function handleCostClear(): Promise<void> {
	console.log(sectionHeading("Clear Usage Data"));
	const readline = await import("node:readline/promises");
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	const confirm = await rl.question(
		chalk.yellow("Are you sure you want to clear all usage data? (y/N): "),
	);

	rl.close();

	if (confirm.toLowerCase() === "y") {
		clearUsage();
		console.log(`\n${badge("Usage data cleared", undefined, "success")}\n`);
	} else {
		console.log(muted("\nCancelled.\n"));
	}
}

/**
 * Handle `maestro cost breakdown` command
 */
export async function handleCostBreakdown(): Promise<void> {
	const summary = getUsageSummary();

	console.log(sectionHeading("Detailed Cost Breakdown"));

	if (summary.totalRequests === 0) {
		console.log(muted("No usage data found.\n"));
		return;
	}

	const providers = Object.entries(summary.byProvider).sort(
		(a, b) => b[1].cost - a[1].cost,
	);

	console.log(badge("Providers", undefined, "info"));
	for (const [provider, data] of providers) {
		const share = summary.totalCost ? (data.cost / summary.totalCost) * 100 : 0;
		const metrics = [
			badge("req", data.requests.toString(), "info"),
			badge("tok", formatTokens(data.tokens), "info"),
			badge("cost", `$${data.cost.toFixed(4)}`, "warn"),
			contextualBadge("share", share, { warn: 30, danger: 50 }),
		];
		console.log(
			`  ${chalk.cyan(provider.padEnd(16))} ${metrics.join(themedSeparator())}`,
		);
	}

	console.log();
	console.log(
		`  ${badge("Total requests", summary.totalRequests.toLocaleString(), "info")} ${themedSeparator()} ${badge("Total tokens", summary.totalTokens.toLocaleString(), "info")} ${themedSeparator()} ${badge("Total cost", `$${summary.totalCost.toFixed(4)}`, "warn")}`,
	);
	console.log();
}

/**
 * Format token count with K/M suffix
 */
function formatTokens(tokens: number): string {
	if (tokens < 1000) return tokens.toString();
	if (tokens < 1000000) return `${(tokens / 1000).toFixed(1)}K`;
	return `${(tokens / 1000000).toFixed(1)}M`;
}
