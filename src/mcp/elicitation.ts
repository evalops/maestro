import { AsyncLocalStorage } from "node:async_hooks";
import type {
	ElicitRequestParams,
	ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { ClientToolExecutionService } from "../agent/transport.js";
import type { AgentToolResult } from "../agent/types.js";

export interface McpElicitationClientToolArgs extends Record<string, unknown> {
	serverName: string;
	requestId: string;
	mode: "form" | "url";
	message: string;
	requestedSchema?: Record<string, unknown>;
	url?: string;
	elicitationId?: string;
}

const mcpClientToolServiceStorage = new AsyncLocalStorage<
	ClientToolExecutionService | undefined
>();

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeElicitationContent(
	value: unknown,
): Record<string, string | number | boolean | string[]> | undefined {
	if (!isRecord(value)) {
		return undefined;
	}

	const content: Record<string, string | number | boolean | string[]> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (
			typeof entry === "string" ||
			typeof entry === "number" ||
			typeof entry === "boolean"
		) {
			content[key] = entry;
			continue;
		}
		if (
			Array.isArray(entry) &&
			entry.every((item) => typeof item === "string")
		) {
			content[key] = [...entry];
		}
	}

	return Object.keys(content).length > 0 ? content : undefined;
}

export function buildMcpElicitationToolCallId(
	serverName: string,
	requestId: string | number,
): string {
	return `mcp_elicitation:${serverName}:${String(requestId)}`;
}

export function normalizeMcpElicitationArgs(
	serverName: string,
	requestId: string | number,
	params: ElicitRequestParams,
): McpElicitationClientToolArgs {
	const mode = params.mode === "url" ? "url" : "form";
	return {
		serverName,
		requestId: String(requestId),
		mode,
		message: params.message,
		...(mode === "form" &&
		"requestedSchema" in params &&
		isRecord(params.requestedSchema)
			? { requestedSchema: params.requestedSchema }
			: {}),
		...(mode === "url" && "url" in params ? { url: params.url } : {}),
		...(mode === "url" && "elicitationId" in params
			? { elicitationId: params.elicitationId }
			: {}),
	};
}

export function parseMcpElicitationClientToolResult(
	content: AgentToolResult["content"],
	isError: boolean,
): ElicitResult {
	if (isError) {
		return { action: "cancel" };
	}

	const textBlock = content.find(
		(block): block is { type: "text"; text: string } =>
			block.type === "text" && typeof block.text === "string",
	);
	if (!textBlock) {
		return { action: "cancel" };
	}

	try {
		const parsed = JSON.parse(textBlock.text) as unknown;
		if (!isRecord(parsed)) {
			return { action: "cancel" };
		}
		const action = parsed.action;
		if (action !== "accept" && action !== "decline" && action !== "cancel") {
			return { action: "cancel" };
		}
		const normalizedContent = normalizeElicitationContent(parsed.content);
		return action === "accept" && normalizedContent
			? { action, content: normalizedContent }
			: { action };
	} catch {
		return { action: "cancel" };
	}
}

export async function runWithMcpClientToolService<T>(
	clientToolService: ClientToolExecutionService | undefined,
	fn: () => T | Promise<T>,
): Promise<T> {
	return Promise.resolve(
		mcpClientToolServiceStorage.run(clientToolService, fn),
	);
}

export function getCurrentMcpClientToolService():
	| ClientToolExecutionService
	| undefined {
	return mcpClientToolServiceStorage.getStore();
}
