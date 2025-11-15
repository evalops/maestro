import chalk from "chalk";
import {
	badge,
	contextualBadge,
	muted,
	separator as themedSeparator,
} from "../style/theme.js";
import { clearUsage, getUsageSummary } from "../tracking/cost-tracker.js";
import type { Container, TUI } from "../tui-lib/index.js";
import { Spacer, Text } from "../tui-lib/index.js";
import type { CommandExecutionContext } from "./commands/types.js";

type CostPeriod = {
	label: string;
	since?: number;
	until?: number;
};

interface CostViewOptions {
	chatContainer: Container;
	ui: TUI;
	showInfo: (message: string) => void;
	showError: (message: string) => void;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export class CostView {
	constructor(private readonly options: CostViewOptions) {}

	handleCostCommand(
		context: CommandExecutionContext<Record<string, unknown>>,
	): void {
		const tokens = context.argumentText
			.trim()
			.split(/\s+/)
			.filter((token) => token.length > 0);
		const action = tokens[0]?.toLowerCase();
		const remainder = action ? tokens.slice(1) : tokens;

		switch (action) {
			case "help":
				this.renderHelp();
				return;
			case "clear":
				this.handleClearCommand();
				return;
			case "breakdown":
				this.handleBreakdownCommand(remainder);
				return;
			default:
				this.handleSummaryCommand(action);
		}
	}

	private handleSummaryCommand(periodArg?: string): void {
		const period = this.resolvePeriod(periodArg);
		try {
			const summary = getUsageSummary({
				since: period.since,
				until: period.until,
			});
			this.renderSummary(summary, period.label);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Unable to load usage";
			this.options.showError(`Cost summary failed: ${message}`);
		}
	}

	private handleBreakdownCommand(args: string[]): void {
		const period = this.resolvePeriod(args[0]);
		try {
			const summary = getUsageSummary({
				since: period.since,
				until: period.until,
			});
			this.renderBreakdown(summary, period.label);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Unable to load usage";
			this.options.showError(`Cost breakdown failed: ${message}`);
		}
	}

	private handleClearCommand(): void {
		try {
			clearUsage();
			this.renderText(
				`${badge("Usage data cleared", undefined, "success")}\n${muted("Cost tracking has been reset.")}`,
			);
			this.options.showInfo("All cost-tracking data cleared.");
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Unable to clear usage";
			this.options.showError(`Failed to clear usage: ${message}`);
		}
	}

	private renderHelp(): void {
		const lines = [
			chalk.bold("/cost usage"),
			"/cost — show cost summary (all time)",
			"/cost today|yesterday|week|month — specify a time window",
			"/cost breakdown [period] — provider/model share details",
			"/cost clear — reset stored usage data",
			"/cost help — show this help",
		];
		this.renderText(lines.join("\n"));
	}

	private resolvePeriod(arg?: string): CostPeriod {
		const now = Date.now();
		if (!arg) {
			return { label: "All Time" };
		}
		const normalized = arg.toLowerCase();
		switch (normalized) {
			case "today": {
				const since = new Date().setHours(0, 0, 0, 0);
				return { label: "Today", since };
			}
			case "yesterday": {
				const yesterday = new Date();
				yesterday.setDate(yesterday.getDate() - 1);
				const since = yesterday.setHours(0, 0, 0, 0);
				const until = new Date().setHours(0, 0, 0, 0);
				return { label: "Yesterday", since, until };
			}
			case "week":
			case "7d":
				return { label: "Last 7 Days", since: now - 7 * ONE_DAY_MS };
			case "month":
			case "30d":
				return { label: "Last 30 Days", since: now - 30 * ONE_DAY_MS };
			default:
				this.options.showInfo(
					`Unknown period "${arg}". Showing all available data instead.`,
				);
				return { label: "All Time" };
		}
	}

	private renderSummary(
		summary: ReturnType<typeof getUsageSummary>,
		label: string,
	): void {
		if (summary.totalRequests === 0) {
			this.renderText(
				`${badge("💰 Cost Summary", label, "info")}\n${muted("No usage data found for this period.")}`,
			);
			return;
		}

		const sections = [
			badge("💰 Cost Summary", label, "info"),
			this.buildOverview(summary),
			this.buildProviderSection(summary),
			this.buildModelSection(summary),
		]
			.filter((section) => section.trim().length > 0)
			.join("\n\n");
		this.renderText(sections);
	}

	private buildOverview(summary: ReturnType<typeof getUsageSummary>): string {
		const costBadge = badge("Cost", `$${summary.totalCost.toFixed(4)}`, "warn");
		const tokensBadge = badge(
			"Tokens",
			summary.totalTokens.toLocaleString(),
			"info",
		);
		const requestBadge = badge(
			"Requests",
			summary.totalRequests.toLocaleString(),
			"info",
		);
		const avgTokens = summary.totalTokens / summary.totalRequests;
		const avgBadge = contextualBadge("Avg tokens", avgTokens, {
			warn: 4000,
			danger: 8000,
			unit: "",
		});
		return [
			badge("Overview", undefined, "info"),
			`  ${requestBadge}`,
			`  ${tokensBadge}`,
			`  ${costBadge}`,
			`  ${avgBadge}`,
		].join("\n");
	}

	private buildProviderSection(
		summary: ReturnType<typeof getUsageSummary>,
	): string {
		const entries = Object.entries(summary.byProvider);
		if (entries.length === 0) {
			return "";
		}
		const sorted = entries.sort((a, b) => b[1].cost - a[1].cost);
		const lines = sorted.map(([provider, data]) => {
			const metrics = [
				badge("req", data.requests.toString(), "info"),
				badge("tok", this.formatTokens(data.tokens), "info"),
				badge("cost", `$${data.cost.toFixed(4)}`, "warn"),
			];
			return `  ${chalk.cyan(provider.padEnd(16))} ${metrics.join(themedSeparator())}`;
		});
		return `${badge("By provider", undefined, "info")}\n${lines.join("\n")}`;
	}

	private buildModelSection(
		summary: ReturnType<typeof getUsageSummary>,
	): string {
		const entries = Object.entries(summary.byModel);
		if (entries.length <= 1) {
			return "";
		}
		const sorted = entries.sort((a, b) => b[1].cost - a[1].cost).slice(0, 5);
		const lines = sorted.map(([model, data]) => {
			const detail = [
				badge("req", data.requests.toString(), "info"),
				badge("cost", `$${data.cost.toFixed(4)}`, "warn"),
			];
			return `  ${chalk.dim(model.padEnd(32))} ${detail.join(themedSeparator())}`;
		});
		const remainder = entries.length - sorted.length;
		if (remainder > 0) {
			lines.push(muted(`  … and ${remainder} more models`));
		}
		return `${badge("Top models", undefined, "info")}\n${lines.join("\n")}`;
	}

	private renderText(content: string): void {
		this.options.chatContainer.addChild(new Spacer(1));
		this.options.chatContainer.addChild(new Text(content, 1, 0));
		this.options.ui.requestRender();
	}

	private renderBreakdown(
		summary: ReturnType<typeof getUsageSummary>,
		label: string,
	): void {
		if (summary.totalRequests === 0) {
			this.renderText(
				`${badge("📊 Cost Breakdown", label, "info")}\n${muted("No usage data found for this period.")}`,
			);
			return;
		}
		const providers = Object.entries(summary.byProvider).sort(
			(a, b) => b[1].cost - a[1].cost,
		);
		const lines = providers.map(([provider, data]) => {
			const share = summary.totalCost
				? (data.cost / summary.totalCost) * 100
				: 0;
			const metrics = [
				badge("req", data.requests.toString(), "info"),
				badge("tok", this.formatTokens(data.tokens), "info"),
				badge("cost", `$${data.cost.toFixed(4)}`, "warn"),
				contextualBadge("share", share, { warn: 30, danger: 50 }),
			];
			return `  ${chalk.cyan(provider.padEnd(16))} ${metrics.join(themedSeparator())}`;
		});
		const footer = `${badge(
			"Total requests",
			summary.totalRequests.toLocaleString(),
			"info",
		)} ${themedSeparator()} ${badge(
			"Total tokens",
			summary.totalTokens.toLocaleString(),
			"info",
		)} ${themedSeparator()} ${badge(
			"Total cost",
			`$${summary.totalCost.toFixed(4)}`,
			"warn",
		)}`;
		this.renderText(
			`${badge("📊 Cost Breakdown", label, "info")}\n${lines.join("\n")}\n\n  ${footer}`,
		);
	}

	private formatTokens(tokens: number): string {
		if (tokens < 1000) return tokens.toString();
		if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}K`;
		return `${(tokens / 1_000_000).toFixed(1)}M`;
	}
}
