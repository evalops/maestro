/**
 * Command-suite /diag handler.
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
import { handleAuditCommand } from "../audit-command.js";
import { handlePiiCommand } from "../pii-command.js";
import type { CommandExecutionContext } from "../types.js";
import { createSubcommandHandler } from "./utils.js";

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
	handlePerf: () => void;
	isDatabaseConfigured: () => boolean;
}

export function createDiagCommandHandler(deps: DiagCommandDeps) {
	return createSubcommandHandler({
		defaultSubcommand: "status",
		showHelp: showDiagHelp,
		routes: [
			{
				match: ["status", "health"],
				execute: () => deps.handleStatus(),
			},
			{
				match: ["about", "version", "info"],
				execute: () => deps.handleAbout(),
			},
			{
				match: ["context", "tokens"],
				execute: ({ ctx }) => deps.handleContext(ctx),
			},
			{
				match: ["stats", "overview"],
				execute: ({ ctx }) => deps.handleStats(ctx),
			},
			{
				match: ["background", "bg"],
				execute: ({ customContext, restArgumentText }) =>
					deps.handleBackground(
						customContext(`/background ${restArgumentText}`, restArgumentText),
					),
			},
			{
				match: ["lsp"],
				execute: ({ customContext, restArgumentText }) =>
					deps.handleLsp(
						customContext(`/lsp ${restArgumentText}`, restArgumentText),
					),
			},
			{
				match: ["mcp"],
				execute: ({ ctx }) => deps.handleMcp(ctx),
			},
			{
				match: ["sources", "ctx"],
				execute: ({ ctx }) => deps.handleSources(ctx),
			},
			{
				match: ["keys", "api"],
				execute: ({ customContext }) =>
					deps.handleDiagnostics(customContext("/diag keys", "keys")),
			},
			{
				match: ["telemetry", "telem"],
				execute: ({ customContext, restArgumentText }) =>
					deps.handleTelemetry(
						customContext(`/telemetry ${restArgumentText}`, restArgumentText),
					),
			},
			{
				match: ["training", "train"],
				execute: ({ customContext, restArgumentText }) =>
					deps.handleTraining(
						customContext(`/training ${restArgumentText}`, restArgumentText),
					),
			},
			{
				match: ["otel", "opentelemetry"],
				execute: ({ ctx }) => deps.handleOtel(ctx),
			},
			{
				match: ["perf", "performance"],
				execute: () => deps.handlePerf(),
			},
			{
				match: ["config", "cfg"],
				execute: ({ ctx }) => deps.handleConfig(ctx),
			},
			{
				match: ["pii"],
				execute: ({ customContext, restArgumentText }) =>
					handlePiiCommand({
						...customContext(
							`/pii ${restArgumentText}`.trim(),
							restArgumentText,
						),
					}),
			},
			{
				match: ["access"],
				execute: ({ customContext, restArgumentText }) =>
					handleAccessCommand(
						customContext(
							`/access ${restArgumentText}`.trim(),
							restArgumentText,
						),
					),
			},
			{
				match: ["audit"],
				execute: ({ customContext, restArgumentText }) =>
					handleAuditCommand(
						{
							...customContext(
								`/audit ${restArgumentText}`.trim(),
								restArgumentText,
							),
						},
						{ isDatabaseConfigured: deps.isDatabaseConfigured },
					),
			},
			{
				match: ["bedrock", "aws"],
				execute: ({ ctx }) => {
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
					ctx.showInfo(lines.join("\n"));
				},
			},
		],
		onUnknown: ({ ctx }) => deps.handleDiagnostics(ctx),
	});
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
  /diag perf            Session performance metrics (tool/LLM latency, throughput)
  /diag config          Configuration validation
  /diag pii [cmd]       PII detection (patterns|test <text>)
  /diag access [cmd]    Directory access (safe|restricted|test <path>)
  /diag audit           Audit log status (enterprise)

Aliases: /d, /diagnostics`);
}
