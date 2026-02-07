/**
 * Zod input schemas for governance MCP tools.
 *
 * @module governance-mcp-server/schemas
 */

import { z } from "zod";

export const EvaluateActionSchema = {
	toolName: z.string().describe("Name of the tool being invoked"),
	args: z
		.record(z.string(), z.unknown())
		.default({})
		.describe("Arguments for the tool call"),
	userIntent: z
		.string()
		.optional()
		.describe("The user's original request for intent-matching"),
};

export const ScanPayloadSchema = {
	payload: z
		.record(z.string(), z.unknown())
		.describe(
			"The payload to scan for credentials, PII, and sensitive content",
		),
};

export const AnalyzeCommandSchema = {
	command: z.string().describe("The bash command to analyze for safety"),
};

export const CheckPolicySchema = {
	toolName: z.string().describe("Name of the tool to check against policy"),
	args: z
		.record(z.string(), z.unknown())
		.default({})
		.describe("Arguments for the tool call"),
};

export const LogAuditEventSchema = {
	type: z
		.enum([
			"evaluation",
			"scan",
			"command_analysis",
			"policy_check",
			"execution",
		])
		.describe("Type of audit event"),
	toolName: z.string().describe("Tool name involved"),
	verdict: z
		.enum(["allow", "require_approval", "block"])
		.optional()
		.describe("The verdict or outcome"),
	details: z
		.record(z.string(), z.unknown())
		.optional()
		.describe("Additional event details"),
};
