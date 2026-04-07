/**
 * Consolidated /usage command handler.
 *
 * Combines: /cost, /quota, /stats
 *
 * Usage:
 *   /usage                - Show usage overview
 *   /usage cost [period]  - Show costs (breakdown <period>|clear)
 *   /usage quota [cmd]    - Token quota (detailed|models|alerts|limit <n>)
 *   /usage stats          - Combined status and cost
 */

import type { CommandExecutionContext } from "../types.js";
import { createGroupedCommandHandler } from "./utils.js";

export interface UsageCommandDeps {
	handleCost: (ctx: CommandExecutionContext) => Promise<void> | void;
	handleQuota: (ctx: CommandExecutionContext) => Promise<void> | void;
	handleStats: (ctx: CommandExecutionContext) => Promise<void> | void;
}

export function createUsageCommandHandler(deps: UsageCommandDeps) {
	return createGroupedCommandHandler({
		defaultSubcommand: "overview",
		showHelp: showUsageHelp,
		routes: [
			{
				match: ["overview", "summary"],
				execute: ({ ctx }) => deps.handleStats(ctx),
			},
			{
				match: ["cost", "costs", "spend"],
				execute: ({ rewriteContext }) =>
					deps.handleCost(rewriteContext("cost")),
			},
			{
				match: ["quota", "tokens", "limit", "limits"],
				execute: ({ rewriteContext }) =>
					deps.handleQuota(rewriteContext("quota")),
			},
			{
				match: ["stats", "all"],
				execute: ({ ctx }) => deps.handleStats(ctx),
			},
		],
		onUnknown: async ({ ctx, subcommand, customContext }) => {
			if (["breakdown", "clear", "week", "month", "day"].includes(subcommand)) {
				await deps.handleCost(
					customContext(`/cost ${ctx.argumentText}`, ctx.argumentText),
				);
				return;
			}
			if (["detailed", "models", "alerts"].includes(subcommand)) {
				await deps.handleQuota(
					customContext(`/quota ${ctx.argumentText}`, ctx.argumentText),
				);
				return;
			}
			ctx.showError(`Unknown subcommand: ${subcommand}`);
			showUsageHelp(ctx);
		},
	});
}

function showUsageHelp(ctx: CommandExecutionContext): void {
	ctx.showInfo(`Usage Commands:
  /usage                Show usage overview
  /usage cost           Show cost summary
  /usage cost breakdown <period>  Detailed cost breakdown
  /usage cost clear     Clear cost history
  /usage quota          Show token quota status
  /usage quota detailed Full quota details (enterprise)
  /usage quota models   Per-model breakdown (enterprise)
  /usage quota limit <n> Set session token limit
  /usage stats          Combined status and cost

Direct shortcuts still work: /cost, /quota, /stats`);
}
