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
import { isHelpRequest, parseSubcommand } from "./utils.js";

export interface GitCommandDeps {
	handleDiff: (ctx: CommandExecutionContext) => Promise<void> | void;
	handleReview: (ctx: CommandExecutionContext) => void;
	showInfo: (message: string) => void;
	runGitCommand: (cmd: string) => Promise<string>;
}

export function createGitCommandHandler(deps: GitCommandDeps) {
	return async function handleGitCommand(
		ctx: CommandExecutionContext,
	): Promise<void> {
		const { subcommand, args, customContext } = parseSubcommand(ctx, "status");

		switch (subcommand) {
			case "status":
			case "st":
				deps.handleReview(ctx);
				break;

			case "diff":
			case "d":
				await deps.handleDiff(
					customContext(
						`/diff ${args.slice(1).join(" ")}`,
						args.slice(1).join(" "),
					),
				);
				break;

			case "review":
			case "summary":
				deps.handleReview(ctx);
				break;

			default:
				if (isHelpRequest(subcommand)) {
					showGitHelp(ctx);
				}
				// If argument looks like a path, treat as diff
				else if (args[0] && !args[0].startsWith("-")) {
					await deps.handleDiff(
						customContext(`/diff ${ctx.argumentText}`, ctx.argumentText),
					);
				} else {
					ctx.showError(`Unknown subcommand: ${subcommand}`);
					showGitHelp(ctx);
				}
		}
	};
}

function showGitHelp(ctx: CommandExecutionContext): void {
	ctx.showInfo(`Git Commands:
  /git                 Show git status summary
  /git status          Show git status
  /git diff [path]     Show diff for file
  /git review          Summarize status and diff stats

Direct shortcuts still work: /diff, /review`);
}
