/**
 * Grouped /diag command handler.
 *
 * Combines: /status, /about, /context, /stats, /background, /diag,
 *           /telemetry, /training, /otel, /lsp, /mcp, /config
 * Adds: pii, access, audit inspection
 *
 * Usage:
 *   /diag                 - Show system health overview (default)
 *   /diag status          - Health snapshot (model, git, plan, telemetry)
 *   /diag about           - Build, env, and git info
 *   /diag context         - Token usage per message/file
 *   /diag stats           - Combined status and cost overview
 *   /diag background      - Background task configuration
 *   /diag lsp             - LSP server diagnostics
 *   /diag mcp             - MCP server status
 *   /diag keys            - API key configuration status
 *   /diag telemetry       - Telemetry status and controls
 *   /diag training        - Model training preference
 *   /diag otel            - OpenTelemetry runtime config
 *   /diag config          - Configuration validation
 *   /diag pii [test]      - PII detection patterns and testing
 *   /diag access [path]   - Directory access rules and testing
 *   /diag audit [filter]  - Audit log inspection (enterprise)
 */

import type { CommandExecutionContext } from "../types.js";

export interface DiagCommandDeps {
	handleStatus: () => void;
	handleAbout: () => void;
	handleContext: () => void;
	handleStats: (ctx: CommandExecutionContext) => void | Promise<void>;
	handleBackground: (ctx: CommandExecutionContext) => void;
	handleDiagnostics: (ctx: CommandExecutionContext) => void;
	handleTelemetry: (ctx: CommandExecutionContext) => void;
	handleTraining: (ctx: CommandExecutionContext) => void;
	handleOtel: (ctx: CommandExecutionContext) => void;
	handleConfig: (ctx: CommandExecutionContext) => void | Promise<void>;
	handleLsp: (ctx: CommandExecutionContext) => void | Promise<void>;
	handleMcp: (ctx: CommandExecutionContext) => void;
	showInfo: (message: string) => void;
	isDatabaseConfigured: () => boolean;
}

export function createDiagCommandHandler(deps: DiagCommandDeps) {
	return async function handleDiagCommand(
		ctx: CommandExecutionContext,
	): Promise<void> {
		const args = ctx.argumentText.trim().split(/\s+/);
		const subcommand = args[0]?.toLowerCase() || "status";

		switch (subcommand) {
			case "status":
			case "health":
				deps.handleStatus();
				break;

			case "about":
			case "version":
			case "info":
				deps.handleAbout();
				break;

			case "context":
			case "tokens":
				deps.handleContext();
				break;

			case "stats":
			case "overview":
				await deps.handleStats(ctx);
				break;

			case "background":
			case "bg":
				deps.handleBackground({
					...ctx,
					rawInput: `/background ${args.slice(1).join(" ")}`,
					argumentText: args.slice(1).join(" "),
				});
				break;

			case "lsp":
				await deps.handleLsp({
					...ctx,
					rawInput: `/lsp ${args.slice(1).join(" ")}`,
					argumentText: args.slice(1).join(" "),
				});
				break;

			case "mcp":
				deps.handleMcp(ctx);
				break;

			case "keys":
			case "api":
				deps.handleDiagnostics({
					...ctx,
					rawInput: "/diag keys",
					argumentText: "keys",
				});
				break;

			case "telemetry":
			case "telem":
				deps.handleTelemetry({
					...ctx,
					rawInput: `/telemetry ${args.slice(1).join(" ")}`,
					argumentText: args.slice(1).join(" "),
				});
				break;

			case "training":
			case "train":
				deps.handleTraining({
					...ctx,
					rawInput: `/training ${args.slice(1).join(" ")}`,
					argumentText: args.slice(1).join(" "),
				});
				break;

			case "otel":
			case "opentelemetry":
				deps.handleOtel(ctx);
				break;

			case "config":
			case "cfg":
				await deps.handleConfig(ctx);
				break;

			case "pii":
				deps.showInfo(
					"PII Detection: Built-in patterns for emails, phone numbers, SSNs, credit cards, etc.\nUse /diag pii patterns to list all.",
				);
				break;

			case "access":
				deps.showInfo(
					"Directory Access Control: Configures safe and restricted paths.\nUse /diag access safe|restricted|test <path>.",
				);
				break;

			case "audit":
				if (deps.isDatabaseConfigured()) {
					deps.showInfo(
						"Audit Log (Enterprise): Database connected.\nUse web API for full audit log access.",
					);
				} else {
					deps.showInfo(
						"Audit Log: Enterprise feature - database not configured.\nSet COMPOSER_DATABASE_URL to enable.",
					);
				}
				break;

			case "help":
				showDiagHelp(ctx);
				break;

			default:
				// Pass through to original diag handler for unknown subcommands
				deps.handleDiagnostics(ctx);
		}
	};
}

function showDiagHelp(ctx: CommandExecutionContext): void {
	ctx.showInfo(`Diagnostics Commands:
  /diag                 System health overview
  /diag status          Health snapshot
  /diag about           Build and version info
  /diag context         Token usage visualization
  /diag stats           Combined status and cost
  /diag background      Background task config
  /diag lsp [cmd]       LSP server (status|start|stop|restart|detect)
  /diag mcp             MCP server status
  /diag keys            API key status
  /diag telemetry [cmd] Telemetry (status|on|off|reset)
  /diag training [cmd]  Training preference (status|on|off|reset)
  /diag otel            OpenTelemetry runtime config
  /diag config          Configuration validation
  /diag pii [cmd]       PII detection (patterns|test <text>)
  /diag access [cmd]    Directory access (safe|restricted|test <path>)
  /diag audit           Audit log status (enterprise)

Aliases: /d, /diagnostics`);
}
