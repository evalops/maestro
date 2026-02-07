/**
 * Register all governance tools on an McpServer instance.
 *
 * @module governance-mcp-server/tools
 */

import type { GovernanceEngine } from "@evalops/governance";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	AnalyzeCommandSchema,
	CheckPolicySchema,
	EvaluateActionSchema,
	LogAuditEventSchema,
	ScanPayloadSchema,
} from "./schemas.js";

export function registerGovernanceTools(
	server: McpServer,
	engine: GovernanceEngine,
): void {
	// 1. evaluate_action — Full governance pipeline evaluation
	server.tool(
		"evaluate_action",
		"Evaluate a tool call through the full governance pipeline (firewall rules, loop detection, sequence analysis, enterprise policy). Returns allow/require_approval/block verdict.",
		EvaluateActionSchema,
		{ readOnlyHint: true },
		async (args) => {
			const result = await engine.evaluate({
				toolName: args.toolName,
				args: args.args,
				userIntent: args.userIntent,
			});
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(result, null, 2),
					},
				],
			};
		},
	);

	// 2. scan_payload — Credential/PII detection + sanitization
	server.tool(
		"scan_payload",
		"Scan a payload for credentials, API keys, PII, and other sensitive content. Returns findings and a sanitized (redacted) copy.",
		ScanPayloadSchema,
		{ readOnlyHint: true },
		(args) => {
			const result = engine.scanPayload(args.payload);
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(result, null, 2),
					},
				],
			};
		},
	);

	// 3. analyze_command — Bash command safety analysis
	server.tool(
		"analyze_command",
		"Analyze a bash command for safety concerns using tree-sitter parsing and heuristic detection. Identifies destructive operations, egress patterns, and risky syntax.",
		AnalyzeCommandSchema,
		{ readOnlyHint: true },
		(args) => {
			const result = engine.analyzeCommand(args.command);
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(result, null, 2),
					},
				],
			};
		},
	);

	// 4. check_policy — Enterprise policy compliance check
	server.tool(
		"check_policy",
		"Check a tool call against enterprise policy rules only (tool restrictions, path restrictions, network policies, dependency policies).",
		CheckPolicySchema,
		{ readOnlyHint: true },
		async (args) => {
			const result = await engine.checkPolicy({
				toolName: args.toolName,
				args: args.args,
			});
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(result, null, 2),
					},
				],
			};
		},
	);

	// 5. get_policy — Return current policy configuration
	server.tool(
		"get_policy",
		"Return the current enterprise policy configuration summary (what restrictions are active, org ID, etc.).",
		{},
		{ readOnlyHint: true },
		() => {
			const result = engine.getPolicy();
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(result, null, 2),
					},
				],
			};
		},
	);

	// 6. log_audit_event — Record audit event for compliance
	server.tool(
		"log_audit_event",
		"Record a governance audit event for compliance tracking. Events are stored in the engine's audit log.",
		LogAuditEventSchema,
		{ readOnlyHint: false },
		(args) => {
			engine.logAuditEvent({
				type: args.type,
				toolName: args.toolName,
				verdict: args.verdict,
				details: args.details as Record<string, unknown> | undefined,
			});
			const log = engine.getAuditLog();
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(
							{ logged: true, totalEvents: log.length },
							null,
							2,
						),
					},
				],
			};
		},
	);
}
