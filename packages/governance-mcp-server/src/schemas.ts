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
