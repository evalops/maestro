/**
 * Consolidated /tools command handler.
 *
 * Combines: /tools, /mcp, /lsp, /workflow, /run, /commands
 *
 * Usage:
 *   /tools                  - Show available tools
 *   /tools list             - List all tools
 *   /tools failures         - Show tool failures
 *   /tools clear            - Clear tool logs
 *   /tools mcp              - Show, search, or manage MCP servers, approvals, and auth presets
 *   /tools lsp [cmd]        - LSP server management
 *   /tools workflow [cmd]   - Run workflows
 *   /tools run <script>     - Run npm scripts
 *   /tools commands         - User command management
 */

import type { CommandExecutionContext } from "../types.js";
import { createSubcommandHandler } from "./utils.js";

export interface ToolsCommandDeps {
	handleTools: (ctx: CommandExecutionContext) => void | Promise<void>;
	handleMcp: (ctx: CommandExecutionContext) => void | Promise<void>;
	handleLsp: (ctx: CommandExecutionContext) => void | Promise<void>;
	handleWorkflow: (ctx: CommandExecutionContext) => void | Promise<void>;
	handleRun: (ctx: CommandExecutionContext) => void | Promise<void>;
	handleCommands: (ctx: CommandExecutionContext) => void | Promise<void>;
}

export function createToolsCommandHandler(deps: ToolsCommandDeps) {
	return createSubcommandHandler({
		defaultSubcommand: "list",
		showHelp: showToolsHelp,
		routes: [
			{
				match: ["list", "all", "available"],
				execute: ({ customContext }) =>
					deps.handleTools(customContext("/tools list", "list")),
			},
			{
				match: ["failures", "errors", "failed"],
				execute: ({ customContext }) =>
					deps.handleTools(customContext("/tools failures", "failures")),
			},
			{
				match: ["clear", "reset"],
				execute: ({ customContext }) =>
					deps.handleTools(customContext("/tools clear", "clear")),
			},
			{
				match: ["mcp", "servers"],
				execute: ({ rewriteContext }) => deps.handleMcp(rewriteContext("mcp")),
			},
			{
				match: ["lsp", "language"],
				execute: ({ rewriteContext }) => deps.handleLsp(rewriteContext("lsp")),
			},
			{
				match: ["workflow", "workflows", "wf"],
				execute: ({ rewriteContext }) =>
					deps.handleWorkflow(rewriteContext("workflow")),
			},
			{
				match: ["run", "script", "npm"],
				execute: ({ rewriteContext }) => deps.handleRun(rewriteContext("run")),
			},
			{
				match: ["commands", "cmd", "user"],
				execute: ({ rewriteContext }) =>
					deps.handleCommands(rewriteContext("commands")),
			},
		],
		onUnknown: async ({ ctx, subcommand, args, customContext }) => {
			if (args[0] && !args[0].startsWith("-")) {
				await deps.handleRun(
					customContext(`/run ${ctx.argumentText}`, ctx.argumentText),
				);
				return;
			}
			ctx.showError(`Unknown subcommand: ${subcommand}`);
			showToolsHelp(ctx);
		},
	});
}

function showToolsHelp(ctx: CommandExecutionContext): void {
	ctx.showInfo(`Tools Commands:
  /tools                  Show available tools
  /tools list             List all tools
  /tools failures         Show tool failures
  /tools clear            Clear tool logs
  /tools mcp              Show, search, or manage MCP servers, approvals, and auth presets
  /tools lsp [cmd]        LSP (status|start|stop|restart|detect)
  /tools workflow [cmd]   Workflows (list|run|validate|show)
  /tools run <script>     Run npm script
  /tools commands         User command management

Direct shortcuts still work: /tools, /mcp, /lsp, /workflow, /run, /commands`);
}
