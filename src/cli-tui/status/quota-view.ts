import type { Container, TUI } from "@evalops/tui";
import { Spacer, Text } from "@evalops/tui";
import chalk from "chalk";
import { isDatabaseConfigured } from "../../db/client.js";
import {
	badge,
	contextualBadge,
	muted,
	separator as themedSeparator,
} from "../../style/theme.js";
import type { CommandExecutionContext } from "../commands/types.js";

interface QuotaViewOptions {
	chatContainer: Container;
	ui: TUI;
	showInfo: (message: string) => void;
	showError: (message: string) => void;
	getSessionTokenUsage: () => number;
}

interface SessionQuotaLimit {
	enabled: boolean;
	maxTokens: number;
}

export class QuotaView {
	private sessionQuotaLimit: SessionQuotaLimit = {
		enabled: false,
		maxTokens: 0,
	};

	constructor(private readonly options: QuotaViewOptions) {}

	async handleQuotaCommand(
		context: CommandExecutionContext<Record<string, unknown>>,
	): Promise<void> {
		const tokens = context.argumentText
			.trim()
			.split(/\s+/)
			.filter((token: string) => token.length > 0);
		const action = tokens[0]?.toLowerCase();
		const remainder = action ? tokens.slice(1) : tokens;

		switch (action) {
			case "help":
				this.renderHelp();
				return;
			case "detailed":
				await this.handleDetailedCommand();
				return;
			case "models":
				await this.handleModelsCommand();
				return;
			case "alerts":
				await this.handleAlertsCommand();
				return;
			case "limit":
				this.handleLimitCommand(remainder);
				return;
			default:
				await this.handleStatusCommand();
		}
	}

	getSessionLimit(): SessionQuotaLimit & { tokensUsed: number } {
		return {
			...this.sessionQuotaLimit,
			tokensUsed: this.options.getSessionTokenUsage(),
		};
	}

	isOverLimit(): boolean {
		if (!this.sessionQuotaLimit.enabled) return false;
		return (
			this.options.getSessionTokenUsage() >= this.sessionQuotaLimit.maxTokens
		);
	}

	private async handleStatusCommand(): Promise<void> {
		if (!isDatabaseConfigured()) {
			this.renderNonEnterpriseStatus();
			return;
		}

		await this.handleEnterpriseStatusCommand();
	}

	private async handleEnterpriseStatusCommand(): Promise<void> {
		try {
			const { getUsageQuota } = await import("../../billing/token-tracker.js");
			const userContext = await this.getEnterpriseUserContext();

			if (!userContext) {
				this.renderText(
					`${badge("[Token Quota]", undefined, "info")}\n${muted("Not authenticated. Enterprise quota features require login.")}`,
				);
				return;
			}

			const quota = await getUsageQuota(userContext.userId, userContext.orgId);
			if (!quota) {
				this.renderText(
					`${badge("[Token Quota]", undefined, "info")}\n${muted("No quota assigned to your account.")}`,
				);
				return;
			}

			this.renderQuotaStatus(quota);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Unable to load quota";
			this.options.showError(`Quota status failed: ${message}`);
		}
	}

	private async getEnterpriseUserContext(): Promise<{
		userId: string;
		orgId: string;
	} | null> {
		try {
			const { verifyToken } = await import("../../auth/jwt.js");
			const storedToken = process.env.MAESTRO_ENTERPRISE_TOKEN;
			if (!storedToken) return null;

			const payload = verifyToken(storedToken);
			if (!payload) return null;

			return { userId: payload.userId, orgId: payload.orgId };
		} catch {
			return null;
		}
	}

	private renderNonEnterpriseStatus(): void {
		const lines = [badge("[Token Quota]", undefined, "info"), ""];
		const tokensUsed = this.options.getSessionTokenUsage();

		if (this.sessionQuotaLimit.enabled) {
			const max = this.sessionQuotaLimit.maxTokens;
			const remaining = Math.max(0, max - tokensUsed);
			const percent = max > 0 ? (tokensUsed / max) * 100 : 0;

			lines.push(badge("Session Limit", "Active", "success"));
			lines.push(`  ${badge("Used", this.formatTokens(tokensUsed), "info")}`);
			lines.push(`  ${badge("Limit", this.formatTokens(max), "info")}`);
			lines.push(
				`  ${badge("Remaining", this.formatTokens(remaining), percent > 80 ? "warn" : "info")}`,
			);
			lines.push(
				`  ${contextualBadge("Usage", percent, { warn: 80, danger: 100 })}`,
			);
		} else {
			lines.push(badge("Session Usage", this.formatTokens(tokensUsed), "info"));
			lines.push("");
			lines.push(
				muted("Enterprise quota features require database configuration."),
			);
			lines.push(muted("Set MAESTRO_DATABASE_URL to enable org-wide quotas."));
			lines.push("");
			lines.push(
				muted("Set a local session limit with: /quota limit <tokens>"),
			);
		}

		this.renderText(lines.join("\n"));
	}

	private renderQuotaStatus(quota: {
		userId: string;
		orgId: string;
		tokenQuota: number | null;
		tokenUsed: number;
		tokenRemaining: number;
		spendLimit: number | null;
		spendUsed: number;
		spendRemaining: number;
		quotaResetAt: Date | null;
	}): void {
		const lines = [badge("[Token Quota Status]", undefined, "info"), ""];

		if (quota.tokenQuota === null || quota.tokenQuota === 0) {
			lines.push(badge("Token Limit", "Unlimited", "success"));
			lines.push(
				`  ${badge("Used", this.formatTokens(quota.tokenUsed), "info")}`,
			);
		} else {
			const percent = (quota.tokenUsed / quota.tokenQuota) * 100;
			lines.push(
				`  ${badge("Used", `${this.formatTokens(quota.tokenUsed)} of ${this.formatTokens(quota.tokenQuota)} tokens`, "info")} (${percent.toFixed(1)}%)`,
			);
			lines.push(
				`  ${badge("Remaining", this.formatTokens(quota.tokenRemaining), percent > 80 ? "warn" : "info")}`,
			);

			if (quota.quotaResetAt) {
				lines.push(
					`  ${badge("Resets", quota.quotaResetAt.toLocaleDateString(), "info")}`,
				);
			}
		}

		if (this.sessionQuotaLimit.enabled) {
			lines.push("");
			lines.push(badge("Session Override", "Active", "warn"));
			lines.push(
				`  ${badge("Session Limit", this.formatTokens(this.sessionQuotaLimit.maxTokens), "info")}`,
			);
		}

		this.renderText(lines.join("\n"));
	}

	private async handleDetailedCommand(): Promise<void> {
		if (!isDatabaseConfigured()) {
			this.options.showError(
				"Detailed quota view requires enterprise database configuration.",
			);
			return;
		}

		try {
			const { getUsageQuota } = await import("../../billing/token-tracker.js");

			const userContext = await this.getEnterpriseUserContext();
			if (!userContext) {
				this.options.showError("Not authenticated for enterprise features.");
				return;
			}

			const quota = await getUsageQuota(userContext.userId, userContext.orgId);
			if (!quota) {
				this.options.showInfo("No quota assigned to your account.");
				return;
			}

			const lines = [
				badge("[Detailed Quota Breakdown]", undefined, "info"),
				"",
			];

			lines.push(badge("Token Usage", undefined, "info"));
			lines.push(
				`  ${badge("Quota", quota.tokenQuota ? this.formatTokens(quota.tokenQuota) : "Unlimited", "info")}`,
			);
			lines.push(
				`  ${badge("Used", this.formatTokens(quota.tokenUsed), "info")}`,
			);
			lines.push(
				`  ${badge("Remaining", quota.tokenQuota ? this.formatTokens(quota.tokenRemaining) : "∞", "info")}`,
			);

			if (quota.tokenQuota && quota.tokenQuota > 0) {
				const percent = (quota.tokenUsed / quota.tokenQuota) * 100;
				lines.push(
					`  ${contextualBadge("Usage", percent, { warn: 80, danger: 100 })}`,
				);
			}

			lines.push("");
			lines.push(badge("Spend Tracking", undefined, "info"));
			lines.push(
				`  ${badge("Limit", quota.spendLimit ? `$${(quota.spendLimit / 100).toFixed(2)}` : "Unlimited", "info")}`,
			);
			lines.push(
				`  ${badge("Used", `$${(quota.spendUsed / 100).toFixed(2)}`, "info")}`,
			);

			if (quota.quotaResetAt) {
				lines.push("");
				lines.push(
					badge("Reset Date", quota.quotaResetAt.toLocaleDateString(), "info"),
				);
			}

			this.renderText(lines.join("\n"));
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Unable to load quota details";
			this.options.showError(`Detailed quota failed: ${message}`);
		}
	}

	private async handleModelsCommand(): Promise<void> {
		if (!isDatabaseConfigured()) {
			this.options.showError(
				"Model usage breakdown requires enterprise database configuration.",
			);
			return;
		}

		try {
			const { getOrgUsageSummary } = await import(
				"../../billing/token-tracker.js"
			);

			const userContext = await this.getEnterpriseUserContext();
			if (!userContext) {
				this.options.showError("Not authenticated for enterprise features.");
				return;
			}

			const summary = await getOrgUsageSummary(userContext.orgId);

			const lines = [badge("[Usage by Model]", undefined, "info"), ""];

			if (summary.modelBreakdown.length === 0) {
				lines.push(muted("No model usage data available."));
			} else {
				for (const model of summary.modelBreakdown) {
					lines.push(
						`  ${chalk.cyan(model.modelId.padEnd(32))} ${badge("tokens", this.formatTokens(model.tokenUsed), "info")}`,
					);
				}
			}

			lines.push("");
			lines.push(
				`${badge("Total", this.formatTokens(summary.totalTokens), "info")} ${themedSeparator()} ${badge("Sessions", summary.totalSessions.toString(), "info")}`,
			);

			this.renderText(lines.join("\n"));
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Unable to load model usage";
			this.options.showError(`Model usage failed: ${message}`);
		}
	}

	private async handleAlertsCommand(): Promise<void> {
		if (!isDatabaseConfigured()) {
			this.options.showError(
				"Quota alerts require enterprise database configuration.",
			);
			return;
		}

		try {
			const { getDb } = await import("../../db/client.js");
			const { eq, and, isNull, desc } = await import("drizzle-orm");
			const { alerts } = await import("../../db/schema.js");

			const userContext = await this.getEnterpriseUserContext();
			if (!userContext) {
				this.options.showError("Not authenticated for enterprise features.");
				return;
			}

			const db = getDb();
			const quotaAlerts = await db.query.alerts.findMany({
				where: and(
					eq(alerts.userId, userContext.userId),
					isNull(alerts.resolvedAt),
				),
				orderBy: [desc(alerts.createdAt)],
				limit: 10,
			});

			const lines = [badge("[Quota Alerts]", undefined, "info"), ""];

			const filtered = quotaAlerts.filter(
				(a) =>
					a.type === "token_quota_warning" || a.type === "token_quota_exceeded",
			);

			if (filtered.length === 0) {
				lines.push(muted("No active quota alerts."));
			} else {
				for (const alert of filtered) {
					const severityBadge =
						alert.severity === "high" || alert.severity === "critical"
							? badge(alert.severity.toUpperCase(), undefined, "danger")
							: badge(alert.severity.toUpperCase(), undefined, "warn");
					lines.push(`  ${severityBadge} ${alert.message}`);
					lines.push(
						muted(`    ${new Date(alert.createdAt).toLocaleString()}`),
					);
				}
			}

			this.renderText(lines.join("\n"));
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Unable to load alerts";
			this.options.showError(`Alerts failed: ${message}`);
		}
	}

	private handleLimitCommand(args: string[]): void {
		if (args.length === 0) {
			if (this.sessionQuotaLimit.enabled) {
				this.renderText(
					`${badge("[Session Limit]", undefined, "info")}\n  ${badge("Limit", this.formatTokens(this.sessionQuotaLimit.maxTokens), "info")}\n  ${badge("Used", this.formatTokens(this.options.getSessionTokenUsage()), "info")}\n${muted("\nUse /quota limit off to disable.")}`,
				);
			} else {
				this.renderText(
					`${badge("[Session Limit]", undefined, "info")}\n${muted("No session limit set.\n")}${muted("Use /quota limit <tokens> to set a limit.")}`,
				);
			}
			return;
		}

		const arg = args[0]!.toLowerCase();

		if (arg === "off" || arg === "disable" || arg === "clear") {
			this.sessionQuotaLimit = {
				enabled: false,
				maxTokens: 0,
			};
			this.options.showInfo("Session token limit disabled.");
			return;
		}

		const limit = Number.parseInt(arg, 10);
		if (Number.isNaN(limit) || limit <= 0 || limit > Number.MAX_SAFE_INTEGER) {
			this.options.showError(
				"Invalid limit. Provide a positive number of tokens.",
			);
			return;
		}

		this.sessionQuotaLimit = {
			enabled: true,
			maxTokens: limit,
		};

		this.options.showInfo(
			`Session token limit set to ${this.formatTokens(limit)}.`,
		);
	}

	private renderHelp(): void {
		const lines = [
			chalk.bold("/quota usage"),
			"/quota — show current token quota status",
			"/quota detailed — detailed quota breakdown",
			"/quota models — show usage by model and provider",
			"/quota alerts — view quota-related alerts",
			"/quota limit <tokens> — set session token limit as local override",
			"/quota limit off — disable session limit",
			"/quota help — show this help",
		];
		this.renderText(lines.join("\n"));
	}

	private renderText(content: string): void {
		this.options.chatContainer.addChild(new Spacer(1));
		this.options.chatContainer.addChild(new Text(content, 1, 0));
		this.options.ui.requestRender();
	}

	private formatTokens(tokens: number): string {
		if (tokens < 1000) return tokens.toString();
		if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}K`;
		return `${(tokens / 1_000_000).toFixed(1)}M`;
	}
}
