import type { Static, TSchema } from "@sinclair/typebox";
import type { AgentToolResult } from "../agent/types.js";
import { createTypeboxTool } from "./typebox-tool.js";
import { callExa, type CallExaOptions } from "./exa-client.js";

interface CreateExaToolOptions<Schema extends TSchema, Response, Details> {
	name: string;
	label: string;
	description: string;
	schema: Schema;
	endpoint: string;
	operation: string;
	buildRequest: (params: Static<Schema>) => Record<string, unknown>;
	mapResponse: (
		response: Response,
		params: Static<Schema>,
		context: { toolCallId: string },
	) => AgentToolResult<Details> | Promise<AgentToolResult<Details>>;
	maxRetries?: number;
	retryDelayMs?: number;
	shouldRetry?: (error: unknown) => boolean;
	callOptions?: Pick<CallExaOptions, "retries" | "retryDelayMs">;
}

export function createExaTool<Schema extends TSchema, Response, Details = undefined>(
	options: CreateExaToolOptions<Schema, Response, Details>,
) {
	return createTypeboxTool<Schema, Details>({
		name: options.name,
		label: options.label,
		description: options.description,
		schema: options.schema,
		maxRetries: options.maxRetries,
		retryDelayMs: options.retryDelayMs,
		shouldRetry: options.shouldRetry,
		execute: async (toolCallId, params) => {
			const requestBody = options.buildRequest(params);
			const response = await callExa<Response>(
				options.endpoint,
				requestBody,
				{
					toolName: options.name,
					operation: options.operation,
					...options.callOptions,
				},
			);
			return options.mapResponse(response, params, { toolCallId });
		},
	});
}
