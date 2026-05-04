/**
 * Register all governance tools on an McpServer instance.
 *
 * @module governance-mcp-server/tools
 */

import type { GovernanceEngine } from "@evalops/governance";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EvaluateActionSchema, ScanPayloadSchema } from "./schemas.js";

export function registerGovernanceTools(
	server: McpServer,
	engine: GovernanceEngine,
): void {
	// 1. evaluate_action — Full governance pipeline evaluation
	server.tool(
		"evaluate_action",
		"Evaluate a tool call through Platform governance.v1.GovernanceService/EvaluateAction. Returns allow/require_approval/block verdict.",
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

	// 2. scan_payload — Platform PII detection + sanitization
	server.tool(
		"scan_payload",
		"Scan a payload through Platform governance.v1.GovernanceService/DetectPII. Returns findings and a sanitized (redacted) copy.",
		ScanPayloadSchema,
		{ readOnlyHint: true },
		async (args) => {
			const result = await engine.scanPayload(args.payload);
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

	// 3. get_policy — Return Platform safety policy summary
	server.tool(
		"get_policy",
		"Return the Platform governance safety-policy summary for the configured workspace.",
		{},
		{ readOnlyHint: true },
		async () => {
			const result = await engine.getPolicy();
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
}
