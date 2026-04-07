/**
 * Consolidated /git command handler.
 *
 * Combines: /diff, /review
 *
 * Usage:
 *   /git                 - Show git status summary
 *   /git diff [path]     - Show diff for file
 *   /git review          - Summarize status and diff stats
 *   /git status          - Show git status
 */

import type { CommandExecutionContext } from "../types.js";
import { createGroupedCommandHandler } from "./utils.js";

export interface GitCommandDeps {
	handleDiff: (ctx: CommandExecutionContext) => Promise<void> | void;
	handleReview: (ctx: CommandExecutionContext) => void;
	showInfo: (message: string) => void;
	runGitCommand: (cmd: string) => Promise<string>;
}

export function createGitCommandHandler(deps: GitCommandDeps) {
	return createGroupedCommandHandler({
		defaultSubcommand: "status",
		showHelp: showGitHelp,
		routes: [
			{
				match: ["status", "st"],
				execute: ({ ctx }) => deps.handleReview(ctx),
			},
			{
				match: ["diff", "d"],
				execute: ({ customContext, restArgumentText }) =>
					deps.handleDiff(
						customContext(`/diff ${restArgumentText}`, restArgumentText),
					),
			},
			{
				match: ["review", "summary"],
				execute: ({ ctx }) => deps.handleReview(ctx),
			},
		],
		onUnknown: async ({ ctx, subcommand, args, customContext }) => {
			if (args[0] && !args[0].startsWith("-")) {
				await deps.handleDiff(
					customContext(`/diff ${ctx.argumentText}`, ctx.argumentText),
				);
				return;
			}
			ctx.showError(`Unknown subcommand: ${subcommand}`);
			showGitHelp(ctx);
		},
	});
}

function showGitHelp(ctx: CommandExecutionContext): void {
	ctx.showInfo(`Git Commands:
  /git                 Show git status summary
  /git status          Show git status
  /git diff [path]     Show diff for file
  /git review          Summarize status and diff stats

Direct shortcuts still work: /diff, /review`);
}
