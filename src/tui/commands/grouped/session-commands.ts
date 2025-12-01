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
 *   /session queue        - Show/manage message queue
 *   /session export       - Export session to file
 *   /session share        - Generate shareable HTML
 *   /session favorite     - Mark current session as favorite
 *   /session unfavorite   - Remove favorite mark
 *   /session summary      - Add manual summary
 */

import type { CommandExecutionContext } from "../types.js";

export interface SessionCommandDeps {
	handleSessionInfo: (ctx: CommandExecutionContext) => void;
	handleNewChat: () => void;
	handleClear: () => Promise<void> | void;
	handleSessionsList: (ctx: CommandExecutionContext) => Promise<void> | void;
	handleBranch: (ctx: CommandExecutionContext) => Promise<void> | void;
	handleQueue: (ctx: CommandExecutionContext) => Promise<void> | void;
	handleExport: (ctx: CommandExecutionContext) => Promise<void> | void;
	handleShare: (ctx: CommandExecutionContext) => Promise<void> | void;
	showInfo: (message: string) => void;
}

export function createSessionCommandHandler(deps: SessionCommandDeps) {
	return async function handleSessionCommand(
		ctx: CommandExecutionContext,
	): Promise<void> {
		const args = ctx.argumentText.trim().split(/\s+/);
		const subcommand = args[0]?.toLowerCase() || "info";

		// Rewrite context for subcommand handlers that expect original format
		const rewriteContext = (prefix: string): CommandExecutionContext => ({
			...ctx,
			rawInput: `/${prefix} ${args.slice(1).join(" ")}`.trim(),
			argumentText: args.slice(1).join(" "),
		});

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
				await deps.handleSessionsList({
					...ctx,
					rawInput: `/sessions load ${args.slice(1).join(" ")}`,
					argumentText: `load ${args.slice(1).join(" ")}`,
				});
				break;

			case "branch":
				await deps.handleBranch(rewriteContext("branch"));
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
				await deps.handleSessionsList({
					...ctx,
					rawInput: "/sessions favorite",
					argumentText: "favorite",
				});
				break;

			case "unfavorite":
			case "unfav":
				await deps.handleSessionsList({
					...ctx,
					rawInput: "/sessions unfavorite",
					argumentText: "unfavorite",
				});
				break;

			case "summary":
			case "summarize":
				deps.handleSessionInfo({
					...ctx,
					rawInput: `/session summary ${args.slice(1).join(" ")}`,
					argumentText: `summary ${args.slice(1).join(" ")}`,
				});
				break;

			case "help":
				showSessionHelp(ctx);
				break;

			default:
				// If it looks like an ID, try to load it
				if (/^[a-f0-9-]+$/i.test(subcommand) || /^\d+$/.test(subcommand)) {
					await deps.handleSessionsList({
						...ctx,
						rawInput: `/sessions load ${subcommand}`,
						argumentText: `load ${subcommand}`,
					});
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
  /session queue        Show/manage message queue
  /session export       Export session to file
  /session share        Generate shareable HTML
  /session favorite     Mark as favorite
  /session unfavorite   Remove favorite mark
  /session summary "x"  Add manual summary

Aliases: /s`);
}
