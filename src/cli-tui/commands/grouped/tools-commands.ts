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
 *   /tools mcp              - Show MCP servers
 *   /tools lsp [cmd]        - LSP server management
 *   /tools workflow [cmd]   - Run workflows
 *   /tools run <script>     - Run npm scripts
 *   /tools commands         - User command management
 */

import type { CommandExecutionContext } from "../types.js";
import { isHelpRequest, parseSubcommand } from "./utils.js";

export interface ToolsCommandDeps {
	handleTools: (ctx: CommandExecutionContext) => void | Promise<void>;
	handleMcp: (ctx: CommandExecutionContext) => void | Promise<void>;
	handleLsp: (ctx: CommandExecutionContext) => void | Promise<void>;
	handleWorkflow: (ctx: CommandExecutionContext) => void | Promise<void>;
	handleRun: (ctx: CommandExecutionContext) => void | Promise<void>;
	handleCommands: (ctx: CommandExecutionContext) => void | Promise<void>;
	showInfo: (message: string) => void;
}

export function createToolsCommandHandler(deps: ToolsCommandDeps) {
	return async function handleToolsCommand(
		ctx: CommandExecutionContext,
	): Promise<void> {
		const { subcommand, args, rewriteContext, customContext } = parseSubcommand(
			ctx,
			"list",
		);

		switch (subcommand) {
			case "list":
			case "all":
			case "available":
				await deps.handleTools(customContext("/tools list", "list"));
				break;

			case "failures":
			case "errors":
			case "failed":
				await deps.handleTools(customContext("/tools failures", "failures"));
				break;

			case "clear":
			case "reset":
				await deps.handleTools(customContext("/tools clear", "clear"));
				break;

			case "mcp":
			case "servers":
				await deps.handleMcp(rewriteContext("mcp"));
				break;

			case "lsp":
			case "language":
				await deps.handleLsp(rewriteContext("lsp"));
				break;

			case "workflow":
			case "workflows":
			case "wf":
				await deps.handleWorkflow(rewriteContext("workflow"));
				break;

			case "run":
			case "script":
			case "npm":
				await deps.handleRun(rewriteContext("run"));
				break;

			case "commands":
			case "cmd":
			case "user":
				await deps.handleCommands(rewriteContext("commands"));
				break;

			default:
				if (isHelpRequest(subcommand)) {
					showToolsHelp(ctx);
				}
				// If it looks like a script name, pass to run
				else if (args[0] && !args[0].startsWith("-")) {
					await deps.handleRun(
						customContext(`/run ${ctx.argumentText}`, ctx.argumentText),
					);
				} else {
					ctx.showError(`Unknown subcommand: ${subcommand}`);
					showToolsHelp(ctx);
				}
		}
	};
}

function showToolsHelp(ctx: CommandExecutionContext): void {
	ctx.showInfo(`Tools Commands:
  /tools                  Show available tools
  /tools list             List all tools
  /tools failures         Show tool failures
  /tools clear            Clear tool logs
  /tools mcp              Show MCP servers
  /tools lsp [cmd]        LSP (status|start|stop|restart|detect)
  /tools workflow [cmd]   Workflows (list|run|validate|show)
  /tools run <script>     Run npm script
  /tools commands         User command management

Direct shortcuts still work: /tools, /mcp, /lsp, /workflow, /run, /commands`);
}
