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
import { createGroupedCommandHandler, isSessionId } from "./utils.js";

export interface SessionCommandDeps {
	handleSessionInfo: (ctx: CommandExecutionContext) => void;
	handleNewChat: () => void | Promise<void>;
	handleClear: () => Promise<void> | void;
	handleSessionsList: (ctx: CommandExecutionContext) => Promise<void> | void;
	handleBranch: (ctx: CommandExecutionContext) => Promise<void> | void;
	handleTree: (ctx: CommandExecutionContext) => Promise<void> | void;
	handleQueue: (ctx: CommandExecutionContext) => Promise<void> | void;
	handleExport: (ctx: CommandExecutionContext) => Promise<void> | void;
	handleShare: (ctx: CommandExecutionContext) => Promise<void> | void;
	handleRecover: (ctx: CommandExecutionContext) => Promise<void> | void;
	handleCleanup: (ctx: CommandExecutionContext) => Promise<void> | void;
	showInfo: (message: string) => void;
}

export function createSessionCommandHandler(deps: SessionCommandDeps) {
	return createGroupedCommandHandler({
		defaultSubcommand: "info",
		showHelp: showSessionHelp,
		routes: [
			{
				match: ["info", "status"],
				execute: ({ ctx }) => deps.handleSessionInfo(ctx),
			},
			{ match: ["new"], execute: () => deps.handleNewChat() },
			{ match: ["clear"], execute: () => deps.handleClear() },
			{
				match: ["list", "ls", "history"],
				execute: ({ rewriteContext }) =>
					deps.handleSessionsList(rewriteContext("sessions list")),
			},
			{
				match: ["load"],
				execute: ({ customContext, restArgumentText }) =>
					deps.handleSessionsList(
						customContext(
							`/sessions load ${restArgumentText}`,
							`load ${restArgumentText}`.trim(),
						),
					),
			},
			{
				match: ["branch"],
				execute: ({ rewriteContext }) =>
					deps.handleBranch(rewriteContext("branch")),
			},
			{
				match: ["tree"],
				execute: ({ rewriteContext }) =>
					deps.handleTree(rewriteContext("tree")),
			},
			{
				match: ["queue"],
				execute: ({ rewriteContext }) =>
					deps.handleQueue(rewriteContext("queue")),
			},
			{
				match: ["export"],
				execute: ({ rewriteContext }) =>
					deps.handleExport(rewriteContext("export")),
			},
			{
				match: ["share"],
				execute: ({ rewriteContext }) =>
					deps.handleShare(rewriteContext("share")),
			},
			{
				match: ["favorite", "fav"],
				execute: ({ customContext }) =>
					deps.handleSessionsList(
						customContext("/sessions favorite", "favorite"),
					),
			},
			{
				match: ["unfavorite", "unfav"],
				execute: ({ customContext }) =>
					deps.handleSessionsList(
						customContext("/sessions unfavorite", "unfavorite"),
					),
			},
			{
				match: ["summary", "summarize"],
				execute: ({ customContext, restArgumentText }) =>
					deps.handleSessionInfo(
						customContext(
							`/session summary ${restArgumentText}`.trim(),
							`summary ${restArgumentText}`.trim(),
						),
					),
			},
			{
				match: ["recover"],
				execute: ({ rewriteContext }) =>
					deps.handleRecover(rewriteContext("recover")),
			},
			{
				match: ["cleanup", "prune"],
				execute: ({ rewriteContext }) =>
					deps.handleCleanup(rewriteContext("cleanup")),
			},
		],
		onUnknown: async ({ ctx, subcommand, customContext }) => {
			if (isSessionId(subcommand)) {
				await deps.handleSessionsList(
					customContext(`/sessions load ${subcommand}`, `load ${subcommand}`),
				);
				return;
			}
			ctx.showError(`Unknown subcommand: ${subcommand}`);
			showSessionHelp(ctx);
		},
	});
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
  /session cleanup      Prune old sessions (respects favorites)

Aliases: /s`);
}
