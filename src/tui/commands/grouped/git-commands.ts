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
		const args = ctx.argumentText.trim().split(/\s+/);
		const subcommand = args[0]?.toLowerCase() || "status";

		switch (subcommand) {
			case "status":
			case "st":
				deps.handleReview(ctx);
				break;

			case "diff":
			case "d":
				await deps.handleDiff({
					...ctx,
					rawInput: `/diff ${args.slice(1).join(" ")}`,
					argumentText: args.slice(1).join(" "),
				});
				break;

			case "review":
			case "summary":
				deps.handleReview(ctx);
				break;

			case "help":
				showGitHelp(ctx);
				break;

			default:
				// If argument looks like a path, treat as diff
				if (args[0] && !args[0].startsWith("-")) {
					await deps.handleDiff({
						...ctx,
						rawInput: `/diff ${ctx.argumentText}`,
						argumentText: ctx.argumentText,
					});
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
