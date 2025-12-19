/**
 * Grouped /diag command handler.
 *
 * Combines: /status, /about, /context, /stats, /background, /diag,
 *           /telemetry, /training, /otel, /lsp, /mcp, /config
 * Adds: pii, access, audit, bedrock inspection
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
 *   /diag bedrock         - AWS Bedrock credentials and region status
 */

import { getBedrockStatus } from "../../../providers/aws-auth.js";
import { handleAccessCommand } from "../access-command.js";
import type { CommandExecutionContext } from "../types.js";
import { isHelpRequest, parseSubcommand } from "./utils.js";

export interface DiagCommandDeps {
	handleStatus: () => void;
	handleAbout: () => void;
	handleContext: (ctx: CommandExecutionContext) => void | Promise<void>;
	handleStats: (ctx: CommandExecutionContext) => void | Promise<void>;
	handleBackground: (ctx: CommandExecutionContext) => void;
	handleDiagnostics: (ctx: CommandExecutionContext) => void;
	handleTelemetry: (ctx: CommandExecutionContext) => void;
	handleTraining: (ctx: CommandExecutionContext) => void;
	handleOtel: (ctx: CommandExecutionContext) => void;
	handleConfig: (ctx: CommandExecutionContext) => void | Promise<void>;
	handleLsp: (ctx: CommandExecutionContext) => void | Promise<void>;
	handleMcp: (ctx: CommandExecutionContext) => void;
	handleSources: (ctx: CommandExecutionContext) => void | Promise<void>;
	showInfo: (message: string) => void;
	isDatabaseConfigured: () => boolean;
}

export function createDiagCommandHandler(deps: DiagCommandDeps) {
	return async function handleDiagCommand(
		ctx: CommandExecutionContext,
	): Promise<void> {
		const { subcommand, args, customContext } = parseSubcommand(ctx, "status");

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
				await deps.handleContext(ctx);
				break;

			case "stats":
			case "overview":
				await deps.handleStats(ctx);
				break;

			case "background":
			case "bg":
				deps.handleBackground(
					customContext(
						`/background ${args.slice(1).join(" ")}`,
						args.slice(1).join(" "),
					),
				);
				break;

			case "lsp":
				await deps.handleLsp(
					customContext(
						`/lsp ${args.slice(1).join(" ")}`,
						args.slice(1).join(" "),
					),
				);
				break;

			case "mcp":
				deps.handleMcp(ctx);
				break;

			case "sources":
			case "ctx":
				await deps.handleSources(ctx);
				break;

			case "keys":
			case "api":
				deps.handleDiagnostics(customContext("/diag keys", "keys"));
				break;

			case "telemetry":
			case "telem":
				deps.handleTelemetry(
					customContext(
						`/telemetry ${args.slice(1).join(" ")}`,
						args.slice(1).join(" "),
					),
				);
				break;

			case "training":
			case "train":
				deps.handleTraining(
					customContext(
						`/training ${args.slice(1).join(" ")}`,
						args.slice(1).join(" "),
					),
				);
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
				handleAccessCommand(
					customContext(
						`/access ${args.slice(1).join(" ")}`.trim(),
						args.slice(1).join(" "),
					),
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

			case "bedrock":
			case "aws": {
				const status = getBedrockStatus();
				const lines = [
					"AWS Bedrock Status:",
					`  Region: ${status.region}`,
					`  Credentials: ${status.hasCredentials ? "Available" : "Not detected"}`,
				];
				if (status.credentialSources.length > 0) {
					lines.push(`  Sources: ${status.credentialSources.join(", ")}`);
				} else {
					lines.push(
						"  Sources: None detected (may use EC2/ECS instance metadata at runtime)",
					);
				}
				lines.push("");
				lines.push("Supported credential sources:");
				lines.push(
					"  - AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (environment)",
				);
				lines.push("  - AWS_PROFILE (~/.aws/credentials or SSO)");
				lines.push("  - AWS_SSO_SESSION_NAME (SSO session)");
				lines.push("  - AWS_WEB_IDENTITY_TOKEN_FILE (EKS IRSA)");
				lines.push("  - AWS_CONTAINER_CREDENTIALS_* (ECS task role)");
				lines.push(
					"  - EC2 Instance Metadata Service (auto-detected at runtime)",
				);
				deps.showInfo(lines.join("\n"));
				break;
			}

			default:
				if (isHelpRequest(subcommand)) {
					showDiagHelp(ctx);
				} else {
					// Pass through to original diag handler for unknown subcommands
					deps.handleDiagnostics(ctx);
				}
		}
	};
}

function showDiagHelp(ctx: CommandExecutionContext): void {
	ctx.showInfo(`Diagnostics Commands:
  /diag                 System health overview
  /diag status          Health snapshot
  /diag about           Build and version info
  /diag context         Token usage visualization
  /diag sources         Context source load status (todo, lsp, ide, etc.)
  /diag stats           Combined status and cost
  /diag background      Background task config
  /diag lsp [cmd]       LSP server (status|start|stop|restart|detect)
  /diag mcp             MCP server status
  /diag keys            API key status
  /diag bedrock         AWS Bedrock credentials and region
  /diag telemetry [cmd] Telemetry (status|on|off|reset)
  /diag training [cmd]  Training preference (status|on|off|reset)
  /diag otel            OpenTelemetry runtime config
  /diag config          Configuration validation
  /diag pii [cmd]       PII detection (patterns|test <text>)
  /diag access [cmd]    Directory access (safe|restricted|test <path>)
  /diag audit           Audit log status (enterprise)

Aliases: /d, /diagnostics`);
}
