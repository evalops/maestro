import { performance } from "node:perf_hooks";
import type { Static, TSchema } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import type { ErrorObject } from "ajv";
import type {
	AgentTool,
	AgentToolResult,
	ToolAnnotations,
} from "../agent/types.js";
import { logToolFailure, recordToolExecution } from "../telemetry.js";
import { compileTypeboxSchema } from "../utils/typebox-ajv.js";

type ExecuteResult<Details> =
	| AgentToolResult<Details>
	| Promise<AgentToolResult<Details>>;

interface CreateTypeboxToolOptions<Schema extends TSchema, Details> {
	name: string;
	label: string;
	description: string;
	schema: Schema;
	annotations?: ToolAnnotations;
	maxRetries?: number;
	retryDelayMs?: number;
	shouldRetry?: (error: unknown) => boolean;
	execute: (
		toolCallId: string,
		params: Static<Schema>,
		signal?: AbortSignal,
	) => ExecuteResult<Details>;
}

export function createTypeboxTool<Schema extends TSchema, Details = undefined>(
	options: CreateTypeboxToolOptions<Schema, Details>,
): AgentTool<any, Details> {
	const schema = Type.Strict(options.schema) as Schema;
	const parameters = schema;
	const validate = compileTypeboxSchema(schema);

	return {
		name: options.name,
		label: options.label,
		description: options.description,
		parameters,
		annotations: options.annotations,
		execute: async (toolCallId, params, signal) => {
			let parsedParams: Static<Schema>;
			const input =
				params && typeof params === "object"
					? JSON.parse(JSON.stringify(params))
					: {};
			if (!validate(input)) {
				const message =
					validate.errors
						?.map((err: ErrorObject) => {
							return `${err.instancePath || "/"} ${err.message}`;
						})
						.join("; ") ?? "Invalid arguments";
				throw new Error(`Invalid arguments for ${options.name}: ${message}`);
			}
			parsedParams = input as Static<Schema>;

			const maxAttempts = Math.max(1, (options.maxRetries ?? 1) + 1);
			const retryDelayMs = options.retryDelayMs ?? 500;
			const shouldRetry =
				options.shouldRetry ??
				((error: unknown) => isTransientToolError(error));

			let attempt = 0;
			let lastError: unknown;

			while (attempt < maxAttempts) {
				attempt++;
				const start = performance.now();
				try {
					const result = await options.execute(
						toolCallId,
						parsedParams,
						signal,
					);
					recordToolExecution(options.name, true, performance.now() - start, {
						toolCallId,
						attempt,
						maxAttempts,
					});
					return result;
				} catch (error: unknown) {
					lastError = error;
					const errorMessage =
						error instanceof Error ? error.message : String(error ?? "unknown");
					const isAbort = error instanceof Error && error.name === "AbortError";
					const isFinalAttempt = attempt === maxAttempts;

					if (isAbort || !shouldRetry(error) || isFinalAttempt) {
						recordToolExecution(
							options.name,
							false,
							performance.now() - start,
							{
								toolCallId,
								error: errorMessage,
								attempt,
								maxAttempts,
							},
						);
						logToolFailure(options.name, errorMessage, {
							toolCallId,
							attempt,
							maxAttempts,
						});
						throw error;
					}

					logToolFailure(options.name, errorMessage, {
						toolCallId,
						attempt,
						maxAttempts,
					});

					await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
				}
			}

			throw lastError ?? new Error("Unknown tool execution failure");
		},
	};
}
function isTransientToolError(error: unknown): boolean {
	if (!error) return true;
	if (error instanceof Error) {
		if (error.name === "AbortError") {
			return false;
		}
		const message = error.message.toLowerCase();
		if (
			message.includes("invalid") ||
			message.includes("syntax") ||
			message.includes("not found") ||
			message.includes("unknown command")
		) {
			return false;
		}
	}
	return true;
}
