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

export interface UsageCommandDeps {
	handleCost: (ctx: CommandExecutionContext) => Promise<void> | void;
	handleQuota: (ctx: CommandExecutionContext) => Promise<void> | void;
	handleStats: (ctx: CommandExecutionContext) => Promise<void> | void;
}

export function createUsageCommandHandler(deps: UsageCommandDeps) {
	return async function handleUsageCommand(
		ctx: CommandExecutionContext,
	): Promise<void> {
		const args = ctx.argumentText.trim().split(/\s+/);
		const subcommand = args[0]?.toLowerCase() || "overview";

		const rewriteContext = (cmd: string): CommandExecutionContext => ({
			...ctx,
			rawInput: `/${cmd} ${args.slice(1).join(" ")}`.trim(),
			argumentText: args.slice(1).join(" "),
		});

		switch (subcommand) {
			case "overview":
			case "summary":
				// Show combined stats
				await deps.handleStats(ctx);
				break;

			case "cost":
			case "costs":
			case "spend":
				await deps.handleCost(rewriteContext("cost"));
				break;

			case "quota":
			case "tokens":
			case "limit":
			case "limits":
				await deps.handleQuota(rewriteContext("quota"));
				break;

			case "stats":
			case "all":
				await deps.handleStats(ctx);
				break;

			case "help":
				showUsageHelp(ctx);
				break;

			default:
				// Check if it's a cost subcommand
				if (
					["breakdown", "clear", "week", "month", "day"].includes(subcommand)
				) {
					await deps.handleCost({
						...ctx,
						rawInput: `/cost ${ctx.argumentText}`,
						argumentText: ctx.argumentText,
					});
				}
				// Check if it's a quota subcommand
				else if (["detailed", "models", "alerts"].includes(subcommand)) {
					await deps.handleQuota({
						...ctx,
						rawInput: `/quota ${ctx.argumentText}`,
						argumentText: ctx.argumentText,
					});
				} else {
					ctx.showError(`Unknown subcommand: ${subcommand}`);
					showUsageHelp(ctx);
				}
		}
	};
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
