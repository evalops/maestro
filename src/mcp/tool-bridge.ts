import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { type TSchema, Type } from "@sinclair/typebox";
import type { AgentTool } from "../agent/types.js";
import {
	trackToolApprovalRequired,
	trackToolBlocked,
} from "../telemetry/security-events.js";
import { createTool } from "../tools/tool-dsl.js";
import { mcpManager } from "./manager.js";
import type { McpToolCallResult } from "./manager.js";
import { buildMcpToolName } from "./names.js";

interface McpToolDetails {
	server: string;
	tool: string;
	content: unknown[];
	structuredContent?: unknown;
	isError?: boolean;
	governedOutcome?: McpGovernedOutcome;
}

interface McpGovernedOutcome {
	classification:
		| "approval_required"
		| "approval_pending"
		| "authentication_required"
		| "denied"
		| "rate_limited";
	decision?: string;
	riskLevel?: string;
	reasons?: string[];
	approvalRequestId?: string;
	matchedRules?: string[];
	message?: string;
	code?: string;
	state?: string;
	retryAfterMs?: number;
	retryAfterSeconds?: number;
}

function normalizeObject(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function firstString(
	value: Record<string, unknown>,
	...keys: string[]
): string | undefined {
	for (const key of keys) {
		const candidate = value[key];
		if (typeof candidate === "string" && candidate.trim().length > 0) {
			return candidate.trim();
		}
	}
	return undefined;
}

function firstNumber(
	value: Record<string, unknown>,
	...keys: string[]
): number | undefined {
	for (const key of keys) {
		const candidate = value[key];
		if (typeof candidate === "number" && Number.isFinite(candidate)) {
			return candidate;
		}
		if (typeof candidate === "string" && candidate.trim().length > 0) {
			const parsed = Number(candidate);
			if (Number.isFinite(parsed)) {
				return parsed;
			}
		}
	}
	return undefined;
}

function toStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const entries = value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter(Boolean);
	return entries.length > 0 ? entries : undefined;
}

function extractMcpTextContent(
	content: McpToolCallResult["content"],
): string | undefined {
	const text = content
		.filter((item) => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text as string)
		.join("\n")
		.trim();
	return text.length > 0 ? text : undefined;
}

function parseJsonObjectFromText(
	text: string | undefined,
): Record<string, unknown> | null {
	if (!text) {
		return null;
	}
	const trimmed = text.trim();
	if (!(trimmed.startsWith("{") && trimmed.endsWith("}"))) {
		return null;
	}
	try {
		return normalizeObject(JSON.parse(trimmed));
	} catch {
		return null;
	}
}

function resolveGovernedPayload(
	result: McpToolCallResult,
): Record<string, unknown> | null {
	return (
		normalizeObject(result.structuredContent) ??
		parseJsonObjectFromText(extractMcpTextContent(result.content))
	);
}

function classifyGovernedOutcome(
	payload: Record<string, unknown> | null,
): McpGovernedOutcome | undefined {
	if (!payload) {
		return undefined;
	}

	const decision = firstString(payload, "decision")?.toLowerCase();
	const code = firstString(payload, "code", "error_code")?.toLowerCase();
	const state = firstString(payload, "state")?.toLowerCase();
	const status = firstNumber(payload, "status", "status_code");
	const approvalRequestId = firstString(
		payload,
		"approval_id",
		"approvalId",
		"approval_request_id",
		"approvalRequestId",
	);
	const reasons = toStringArray(payload.reasons);
	const matchedRules = toStringArray(
		payload.matched_rules ?? payload.matchedRules,
	);
	const outcome: Omit<McpGovernedOutcome, "classification"> = {
		decision,
		riskLevel: firstString(payload, "risk_level", "riskLevel"),
		reasons,
		approvalRequestId,
		matchedRules,
		message: firstString(payload, "message", "detail", "error"),
		code,
		state,
		retryAfterMs: firstNumber(payload, "retry_after_ms", "retryAfterMs"),
		retryAfterSeconds: firstNumber(
			payload,
			"retry_after_seconds",
			"retryAfterSeconds",
		),
	};

	if (decision === "require_approval" || code?.includes("approval_required")) {
		return { classification: "approval_required", ...outcome };
	}
	if (state === "pending" && approvalRequestId) {
		return { classification: "approval_pending", ...outcome };
	}
	if (
		code?.includes("rate_limit") ||
		code?.includes("too_many_requests") ||
		status === 429
	) {
		return { classification: "rate_limited", ...outcome };
	}
	if (
		code?.includes("authentication_required") ||
		code?.includes("unauthorized") ||
		status === 401
	) {
		return { classification: "authentication_required", ...outcome };
	}
	if (
		decision === "deny" ||
		code?.includes("denied") ||
		code?.includes("forbidden") ||
		status === 403
	) {
		return { classification: "denied", ...outcome };
	}
	return undefined;
}

function formatGovernedOutcomeSummary(
	outcome: McpGovernedOutcome | undefined,
): string | undefined {
	if (!outcome) {
		return undefined;
	}

	const lines: string[] = [];
	switch (outcome.classification) {
		case "approval_required":
			lines.push("Approval required.");
			break;
		case "approval_pending":
			lines.push("Approval pending.");
			break;
		case "authentication_required":
			lines.push("Authentication required.");
			break;
		case "rate_limited":
			lines.push("Rate limit reached.");
			break;
		case "denied":
			lines.push("Action denied.");
			break;
	}

	if (outcome.message) {
		lines.push(outcome.message);
	}
	if (outcome.reasons?.length) {
		lines.push(`Reasons: ${outcome.reasons.join("; ")}`);
	}
	if (outcome.approvalRequestId) {
		lines.push(`Approval request: ${outcome.approvalRequestId}`);
	}
	if (outcome.state && outcome.classification !== "approval_pending") {
		lines.push(`State: ${outcome.state}`);
	}
	if (outcome.riskLevel) {
		lines.push(`Risk level: ${outcome.riskLevel}`);
	}
	if (typeof outcome.retryAfterSeconds === "number") {
		lines.push(`Retry after: ${outcome.retryAfterSeconds} seconds`);
	} else if (typeof outcome.retryAfterMs === "number") {
		lines.push(`Retry after: ${outcome.retryAfterMs} ms`);
	}

	return lines.join("\n");
}

function emitGovernedOutcomeTelemetry(
	toolName: string,
	outcome: McpGovernedOutcome | undefined,
): void {
	if (!outcome) {
		return;
	}

	const reason =
		outcome.message ??
		outcome.reasons?.join("; ") ??
		outcome.code ??
		"policy event";

	if (
		outcome.classification === "approval_required" ||
		outcome.classification === "approval_pending"
	) {
		trackToolApprovalRequired({
			toolName,
			reason,
			source: "policy",
		});
		return;
	}

	trackToolBlocked({
		toolName,
		reason,
		source: "policy",
		severity:
			outcome.classification === "authentication_required" ? "medium" : "high",
	});
}

function convertJsonSchemaToTypebox(schema: unknown): TSchema {
	if (!schema || typeof schema !== "object") {
		return Type.Unknown();
	}

	const s = schema as Record<string, unknown>;
	const type = s.type as string | undefined;

	switch (type) {
		case "string":
			return Type.String({ description: s.description as string | undefined });
		case "number":
		case "integer":
			return Type.Number({ description: s.description as string | undefined });
		case "boolean":
			return Type.Boolean({ description: s.description as string | undefined });
		case "array":
			return Type.Array(convertJsonSchemaToTypebox(s.items), {
				description: s.description as string | undefined,
			});
		case "object": {
			const properties = s.properties as Record<string, unknown> | undefined;
			if (!properties) {
				return Type.Record(Type.String(), Type.Unknown());
			}
			const required = (s.required as string[]) ?? [];
			const props: Record<string, TSchema> = {};
			for (const [key, value] of Object.entries(properties)) {
				const converted = convertJsonSchemaToTypebox(value);
				props[key] = required.includes(key)
					? converted
					: Type.Optional(converted);
			}
			return Type.Object(props, {
				description: s.description as string | undefined,
			});
		}
		default:
			return Type.Unknown({ description: s.description as string | undefined });
	}
}

export function createMcpToolWrapper(serverName: string, mcpTool: McpTool) {
	const toolName = buildMcpToolName(serverName, mcpTool.name);
	const schema = mcpTool.inputSchema
		? convertJsonSchemaToTypebox(mcpTool.inputSchema)
		: Type.Object({});

	// Extract MCP tool annotations for approval decisions
	const mcpAnnotations = mcpTool.annotations as
		| {
				readOnlyHint?: boolean;
				destructiveHint?: boolean;
				idempotentHint?: boolean;
				openWorldHint?: boolean;
		  }
		| undefined;

	return createTool<typeof schema, McpToolDetails>({
		name: toolName,
		label: `${serverName}/${mcpTool.name}`,
		description:
			mcpTool.description ?? `MCP tool from ${serverName}: ${mcpTool.name}`,
		schema,
		annotations: mcpAnnotations
			? {
					readOnlyHint: mcpAnnotations.readOnlyHint,
					destructiveHint: mcpAnnotations.destructiveHint,
					idempotentHint: mcpAnnotations.idempotentHint,
					openWorldHint: mcpAnnotations.openWorldHint,
				}
			: undefined,
		async run(params, { respond }) {
			const result = await mcpManager.callTool(
				serverName,
				mcpTool.name,
				params as Record<string, unknown>,
			);
			const governedOutcome = classifyGovernedOutcome(
				resolveGovernedPayload(result),
			);
			emitGovernedOutcomeTelemetry(mcpTool.name, governedOutcome);

			const output =
				formatGovernedOutcomeSummary(governedOutcome) ??
				extractMcpTextContent(result.content) ??
				JSON.stringify(result.structuredContent ?? result.content, null, 2);

			const response = result.isError
				? respond.error(output)
				: respond.text(output);
			return response.detail({
				server: serverName,
				tool: mcpTool.name,
				content: result.content,
				structuredContent: result.structuredContent,
				isError: result.isError,
				governedOutcome,
			});
		},
	});
}

export function getAllMcpTools(): AgentTool[] {
	const mcpTools = mcpManager.getAllTools();
	return [
		...mcpTools.map(({ server, tool }) => createMcpToolWrapper(server, tool)),
		...getMcpHelperTools(),
	];
}

export function getMcpToolMap(): Map<string, AgentTool> {
	const map = new Map<string, AgentTool>();
	const mcpTools = mcpManager.getAllTools();

	for (const tool of getMcpHelperTools()) {
		map.set(tool.name, tool);
	}

	for (const { server, tool } of mcpTools) {
		const wrapper = createMcpToolWrapper(server, tool);
		map.set(wrapper.name, wrapper);
	}

	return map;
}

// ─────────────────────────────────────────────────────────────
// MCP Resource Tools (inspired by Claude Code's ListMcpResources/ReadMcpResource)
// ─────────────────────────────────────────────────────────────

interface McpResourceListDetails {
	servers: Array<{
		name: string;
		resources: string[];
	}>;
}

const listMcpResourcesSchema = Type.Object({
	server: Type.Optional(
		Type.String({
			description:
				"Optional server name to filter resources. If omitted, lists resources from all servers.",
		}),
	),
});

/**
 * Tool to list available MCP resources across all connected servers.
 */
export const listMcpResourcesTool = createTool<
	typeof listMcpResourcesSchema,
	McpResourceListDetails
>({
	name: "mcp_list_resources",
	description:
		"List available resources from MCP servers. Resources are data sources that can be read (files, configs, etc.).",
	schema: listMcpResourcesSchema,
	annotations: {
		readOnlyHint: true,
	},
	async run(params, { respond }) {
		const status = mcpManager.getStatus();
		const result: Array<{ name: string; resources: string[] }> = [];

		for (const server of status.servers) {
			if (params.server && server.name !== params.server) {
				continue;
			}
			if (server.connected && server.resources.length > 0) {
				result.push({
					name: server.name,
					resources: server.resources,
				});
			}
		}

		if (result.length === 0) {
			return respond
				.text(
					"No MCP resources available. Either no servers are connected or they don't expose resources.",
				)
				.detail({ servers: [] });
		}

		const lines: string[] = ["# Available MCP Resources\n"];
		for (const server of result) {
			lines.push(`## ${server.name}`);
			for (const uri of server.resources) {
				lines.push(`- ${uri}`);
			}
			lines.push("");
		}

		return respond.text(lines.join("\n")).detail({ servers: result });
	},
});

interface McpResourceReadDetails {
	server: string;
	uri: string;
	contents: Array<{
		uri: string;
		text?: string;
		mimeType?: string;
	}>;
}

const readMcpResourceSchema = Type.Object({
	server: Type.String({
		description: "Name of the MCP server that hosts the resource",
	}),
	uri: Type.String({
		description: "URI of the resource to read",
	}),
});

/**
 * Tool to read a specific MCP resource.
 */
export const readMcpResourceTool = createTool<
	typeof readMcpResourceSchema,
	McpResourceReadDetails
>({
	name: "mcp_read_resource",
	description:
		"Read the contents of an MCP resource by URI. Use mcp_list_resources first to discover available resources.",
	schema: readMcpResourceSchema,
	annotations: {
		readOnlyHint: true,
	},
	async run(params, { respond }) {
		const { server, uri } = params;

		try {
			const result = await mcpManager.readResource(server, uri);

			if (result.contents.length === 0) {
				return respond.text(`Resource '${uri}' is empty.`).detail({
					server,
					uri,
					contents: [],
				});
			}

			// Format output based on content type
			const textContents = result.contents
				.filter((c) => c.text !== undefined)
				.map((c) => c.text)
				.join("\n---\n");

			const output = textContents || JSON.stringify(result.contents, null, 2);

			return respond.text(output).detail({
				server,
				uri,
				contents: result.contents.map((c) => ({
					uri: c.uri,
					text: c.text,
					mimeType: c.mimeType,
				})),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return respond.error(`Failed to read resource: ${message}`);
		}
	},
});

interface McpPromptListDetails {
	servers: Array<{
		name: string;
		prompts: string[];
	}>;
}

const listMcpPromptsSchema = Type.Object({
	server: Type.Optional(
		Type.String({
			description:
				"Optional server name to filter prompts. If omitted, lists prompts from all servers.",
		}),
	),
});

/**
 * Tool to list available MCP prompts across all connected servers.
 */
export const listMcpPromptsTool = createTool<
	typeof listMcpPromptsSchema,
	McpPromptListDetails
>({
	name: "mcp_list_prompts",
	description:
		"List available prompts from MCP servers. Prompts are reusable prompt templates exposed by servers.",
	schema: listMcpPromptsSchema,
	annotations: {
		readOnlyHint: true,
	},
	async run(params, { respond }) {
		const status = mcpManager.getStatus();
		const result: Array<{ name: string; prompts: string[] }> = [];

		for (const server of status.servers) {
			if (params.server && server.name !== params.server) {
				continue;
			}
			if (server.connected && server.prompts.length > 0) {
				result.push({
					name: server.name,
					prompts: server.prompts,
				});
			}
		}

		if (result.length === 0) {
			return respond
				.text(
					"No MCP prompts available. Either no servers are connected or they don't expose prompts.",
				)
				.detail({ servers: [] });
		}

		const lines: string[] = ["# Available MCP Prompts\n"];
		for (const server of result) {
			lines.push(`## ${server.name}`);
			for (const prompt of server.prompts) {
				lines.push(`- ${prompt}`);
			}
			lines.push("");
		}

		return respond.text(lines.join("\n")).detail({ servers: result });
	},
});

interface McpPromptDetails {
	server: string;
	name: string;
	description?: string;
	messages: Array<{ role: string; content: string }>;
}

const getMcpPromptSchema = Type.Object({
	server: Type.String({
		description: "Name of the MCP server that hosts the prompt",
	}),
	name: Type.String({
		description: "Name of the prompt to fetch",
	}),
	args: Type.Optional(
		Type.Record(
			Type.String(),
			Type.String({
				description: "Optional string arguments passed to the prompt",
			}),
		),
	),
});

/**
 * Tool to fetch a specific MCP prompt.
 */
export const getMcpPromptTool = createTool<
	typeof getMcpPromptSchema,
	McpPromptDetails
>({
	name: "mcp_get_prompt",
	description:
		"Fetch an MCP prompt by name. Use mcp_list_prompts first to discover available prompts.",
	schema: getMcpPromptSchema,
	annotations: {
		readOnlyHint: true,
	},
	async run(params, { respond }) {
		const { server, name, args } = params;

		try {
			const result = await mcpManager.getPrompt(server, name, args);
			const lines: string[] = [`Prompt: ${name}`];

			if (result.description) {
				lines.push(`Description: ${result.description}`);
			}

			if (result.messages.length === 0) {
				lines.push("");
				lines.push("No prompt messages returned.");
			} else {
				lines.push("");
				for (const message of result.messages) {
					lines.push(`[${message.role}]`);
					lines.push(message.content);
					lines.push("");
				}
			}

			return respond.text(lines.join("\n").trimEnd()).detail({
				server,
				name,
				description: result.description,
				messages: result.messages,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return respond.error(`Failed to get prompt: ${message}`);
		}
	},
});

/**
 * Get all MCP resource tools.
 */
export function getMcpResourceTools() {
	return [listMcpResourcesTool, readMcpResourceTool];
}

function getMcpHelperTools() {
	return [
		listMcpResourcesTool,
		readMcpResourceTool,
		listMcpPromptsTool,
		getMcpPromptTool,
	];
}
