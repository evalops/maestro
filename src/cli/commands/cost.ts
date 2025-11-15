import chalk from "chalk";
import { getUsageSummary, clearUsage, getUsageFilePath } from "../../tracking/cost-tracker.js";

/**
 * Handle `composer cost` command (default: today)
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
		case "yesterday":
			const yesterday = new Date();
			yesterday.setDate(yesterday.getDate() - 1);
			since = yesterday.setHours(0, 0, 0, 0);
			until = new Date().setHours(0, 0, 0, 0);
			label = "Yesterday";
			break;
		case "week":
		case "7d":
			since = now - (7 * oneDayMs);
			label = "Last 7 Days";
			break;
		case "month":
		case "30d":
			since = now - (30 * oneDayMs);
			label = "Last 30 Days";
			break;
		case "all":
		default:
			label = "All Time";
			break;
	}
	
	const summary = getUsageSummary({ since, until });
	
	console.log(chalk.bold(`\n💰 Cost Summary (${label})\n`));
	
	if (summary.totalRequests === 0) {
		console.log(chalk.dim("No usage data found.\n"));
		return;
	}
	
	// Overall summary
	console.log(chalk.bold("Overview:"));
	console.log(`  Requests: ${chalk.cyan(summary.totalRequests.toLocaleString())}`);
	console.log(`  Tokens: ${chalk.cyan(summary.totalTokens.toLocaleString())}`);
	console.log(`  Cost: ${chalk.green(`$${summary.totalCost.toFixed(4)}`)}\n`);
	
	// By provider
	if (Object.keys(summary.byProvider).length > 0) {
		console.log(chalk.bold("By Provider:"));
		const providers = Object.entries(summary.byProvider)
			.sort((a, b) => b[1].cost - a[1].cost);
		
		for (const [provider, data] of providers) {
			console.log(`  ${chalk.cyan(provider.padEnd(20))} ${data.requests.toString().padStart(5)} requests  ${formatTokens(data.tokens).padStart(10)}  ${chalk.green(`$${data.cost.toFixed(4)}`)}`);
		}
		console.log();
	}
	
	// By model
	if (Object.keys(summary.byModel).length > 1) {
		console.log(chalk.bold("By Model:"));
		const models = Object.entries(summary.byModel)
			.sort((a, b) => b[1].cost - a[1].cost)
			.slice(0, 10); // Top 10
		
		for (const [model, data] of models) {
			console.log(`  ${chalk.dim(model.padEnd(35))} ${data.requests.toString().padStart(5)} requests  ${chalk.green(`$${data.cost.toFixed(4)}`)}`);
		}
		
		if (Object.keys(summary.byModel).length > 10) {
			console.log(chalk.dim(`  ... and ${Object.keys(summary.byModel).length - 10} more models`));
		}
		console.log();
	}
}

/**
 * Handle `composer cost clear` command
 */
export async function handleCostClear(): Promise<void> {
	const readline = await import("node:readline/promises");
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	
	const confirm = await rl.question(
		chalk.yellow("Are you sure you want to clear all usage data? (y/N): ")
	);
	
	rl.close();
	
	if (confirm.toLowerCase() === 'y') {
		clearUsage();
		console.log(chalk.green("\n✓ Usage data cleared\n"));
	} else {
		console.log(chalk.dim("\nCancelled.\n"));
	}
}

/**
 * Handle `composer cost breakdown` command
 */
export async function handleCostBreakdown(): Promise<void> {
	const summary = getUsageSummary();
	
	console.log(chalk.bold("\n📊 Detailed Cost Breakdown\n"));
	
	if (summary.totalRequests === 0) {
		console.log(chalk.dim("No usage data found.\n"));
		return;
	}
	
	// Table header
	console.log(chalk.bold("Provider       │ Requests │ Tokens    │ Cost"));
	console.log("━".repeat(60));
	
	// By provider
	const providers = Object.entries(summary.byProvider)
		.sort((a, b) => b[1].cost - a[1].cost);
	
	for (const [provider, data] of providers) {
		const providerStr = provider.padEnd(14);
		const requestsStr = data.requests.toString().padStart(8);
		const tokensStr = formatTokens(data.tokens).padStart(9);
		const costStr = `$${data.cost.toFixed(4)}`;
		
		console.log(`${chalk.cyan(providerStr)} │ ${requestsStr} │ ${tokensStr} │ ${chalk.green(costStr)}`);
	}
	
	console.log("━".repeat(60));
	console.log(
		`${chalk.bold("Total".padEnd(14))} │ ${summary.totalRequests.toString().padStart(8)} │ ${formatTokens(summary.totalTokens).padStart(9)} │ ${chalk.green(`$${summary.totalCost.toFixed(4)}`)}`
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
