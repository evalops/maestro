/**
 * Consolidated /diag command handler.
 *
 * Combines: /status, /about, /context, /stats, /background, /diag
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
 *   /diag keys            - API key configuration status
 *   /diag pii [test]      - PII detection patterns and testing
 *   /diag access [path]   - Directory access rules and testing
 *   /diag audit [filter]  - Audit log inspection (enterprise)
 */

import type { CommandExecutionContext } from "../types.js";

export interface DiagCommandDeps {
	handleStatus: () => void;
	handleAbout: () => void;
	handleContext: () => void;
	handleBackground: (ctx: CommandExecutionContext) => void;
	handleDiagnostics: (ctx: CommandExecutionContext) => void;
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
				deps.handleStatus(); // Stats redirects to status
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
				deps.handleDiagnostics({
					...ctx,
					rawInput: "/diag lsp",
					argumentText: "lsp",
				});
				break;

			case "keys":
			case "api":
				deps.handleDiagnostics({
					...ctx,
					rawInput: "/diag keys",
					argumentText: "keys",
				});
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
  /diag lsp             LSP server diagnostics
  /diag keys            API key status
  /diag pii [cmd]       PII detection (patterns|test <text>)
  /diag access [cmd]    Directory access (safe|restricted|test <path>)
  /diag audit           Audit log status (enterprise)

Aliases: /d, /diagnostics`);
}
