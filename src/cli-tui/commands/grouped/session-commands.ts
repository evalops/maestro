/**
 * Consolidated /session command handler.
 *
 * Combines: /new, /clear, /session, /sessions, /branch, /queue, /export, /share
 *
 * Usage:
 *   /session              - Show current session info (default)
 *   /session new          - Start a fresh chat session
 *   /session clear        - Clear context and start fresh
 *   /session list         - List recent sessions
 *   /session load <id>    - Load a session by ID
 *   /session branch [n]   - Branch from message n
 *   /session tree         - Navigate the session tree
 *   /session queue        - Show/manage message queue
 *   /session export       - Export session to file
 *   /session share        - Generate shareable HTML
 *   /session favorite     - Mark current session as favorite
 *   /session unfavorite   - Remove favorite mark
 *   /session summary      - Add manual summary
 */

import type { CommandExecutionContext } from "../types.js";
import { isHelpRequest, isSessionId, parseSubcommand } from "./utils.js";

export interface SessionCommandDeps {
	handleSessionInfo: (ctx: CommandExecutionContext) => void;
	handleNewChat: () => void;
	handleClear: () => Promise<void> | void;
	handleSessionsList: (ctx: CommandExecutionContext) => Promise<void> | void;
	handleBranch: (ctx: CommandExecutionContext) => Promise<void> | void;
	handleTree: (ctx: CommandExecutionContext) => Promise<void> | void;
	handleQueue: (ctx: CommandExecutionContext) => Promise<void> | void;
	handleExport: (ctx: CommandExecutionContext) => Promise<void> | void;
	handleShare: (ctx: CommandExecutionContext) => Promise<void> | void;
	handleRecover: (ctx: CommandExecutionContext) => Promise<void> | void;
	showInfo: (message: string) => void;
}

export function createSessionCommandHandler(deps: SessionCommandDeps) {
	return async function handleSessionCommand(
		ctx: CommandExecutionContext,
	): Promise<void> {
		const { subcommand, args, rewriteContext, customContext } = parseSubcommand(
			ctx,
			"info",
		);

		switch (subcommand) {
			case "info":
			case "status":
				deps.handleSessionInfo(ctx);
				break;

			case "new":
				deps.handleNewChat();
				break;

			case "clear":
				await deps.handleClear();
				break;

			case "list":
			case "ls":
			case "history":
				await deps.handleSessionsList(rewriteContext("sessions list"));
				break;

			case "load":
				await deps.handleSessionsList(
					customContext(
						`/sessions load ${args.slice(1).join(" ")}`,
						`load ${args.slice(1).join(" ")}`,
					),
				);
				break;

			case "branch":
				await deps.handleBranch(rewriteContext("branch"));
				break;
			case "tree":
				await deps.handleTree(rewriteContext("tree"));
				break;

			case "queue":
				await deps.handleQueue(rewriteContext("queue"));
				break;

			case "export":
				await deps.handleExport(rewriteContext("export"));
				break;

			case "share":
				await deps.handleShare(rewriteContext("share"));
				break;

			case "favorite":
			case "fav":
				await deps.handleSessionsList(
					customContext("/sessions favorite", "favorite"),
				);
				break;

			case "unfavorite":
			case "unfav":
				await deps.handleSessionsList(
					customContext("/sessions unfavorite", "unfavorite"),
				);
				break;

			case "summary":
			case "summarize":
				deps.handleSessionInfo(
					customContext(
						`/session summary ${args.slice(1).join(" ")}`,
						`summary ${args.slice(1).join(" ")}`,
					),
				);
				break;

			case "recover":
				await deps.handleRecover(rewriteContext("recover"));
				break;

			default:
				if (isHelpRequest(subcommand)) {
					showSessionHelp(ctx);
				}
				// If it looks like an ID, try to load it
				else if (isSessionId(subcommand)) {
					await deps.handleSessionsList(
						customContext(`/sessions load ${subcommand}`, `load ${subcommand}`),
					);
				} else {
					ctx.showError(`Unknown subcommand: ${subcommand}`);
					showSessionHelp(ctx);
				}
		}
	};
}

function showSessionHelp(ctx: CommandExecutionContext): void {
	ctx.showInfo(`Session Commands:
  /session              Show current session info
  /session new          Start a fresh chat session
  /session clear        Clear context and start fresh
  /session list         List recent sessions
  /session load <id>    Load a session by ID or index
  /session branch [n]   Branch from user message n
  /session tree         Navigate the session tree
  /session queue        Show/manage message queue
  /session export       Export session to file
  /session share        Generate shareable HTML
  /session favorite     Mark as favorite
  /session unfavorite   Remove favorite mark
  /session summary "x"  Add manual summary
  /session recover      Restore from latest auto-recovery backup

Aliases: /s`);
}
