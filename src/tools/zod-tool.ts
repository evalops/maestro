import { performance } from "node:perf_hooks";
import { Type } from "@sinclair/typebox";
import type { z } from "zod";
import { ZodError } from "zod";
import type { JsonSchema7Type } from "zod-to-json-schema";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { AgentTool, AgentToolResult } from "../agent/types.js";
import { logToolFailure, recordToolExecution } from "../telemetry.js";

type ExecuteResult<Details> =
	| AgentToolResult<Details>
	| Promise<AgentToolResult<Details>>;

/**
 * Configuration options for creating a Zod-validated tool.
 *
 * @template Schema - The Zod schema type for parameter validation
 * @template Details - Optional details type for the tool result
 */
interface CreateZodToolOptions<Schema extends z.ZodTypeAny, Details> {
	/** Unique tool name (must match the name LLMs will use to invoke it) */
	name: string;
	/** Human-readable label for UI display */
	label: string;
	/** Description of what the tool does (shown to LLMs and users) */
	description: string;
	/** Zod schema defining valid parameters */
	schema: Schema;
	/** Optional name for the JSON schema (defaults to capitalized tool name + "Parameters") */
	schemaName?: string;
	/** Maximum number of retry attempts on transient failures (default: 1, no retries) */
	maxRetries?: number;
	/** Delay in milliseconds between retry attempts (default: 500ms) */
	retryDelayMs?: number;
	/** Custom predicate to determine if an error should trigger a retry */
	shouldRetry?: (error: unknown) => boolean;
	/** Tool execution function that receives validated parameters */
	execute: (
		toolCallId: string,
		params: z.infer<Schema>,
		signal?: AbortSignal,
	) => ExecuteResult<Details>;
}

/**
 * Formats Zod validation errors into a human-readable string.
 *
 * @param error - The ZodError to format
 * @returns Formatted error message with path and message for each issue
 */
function formatZodIssues(error: ZodError): string {
	return error.issues
		.map((issue) => {
			const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
			return `${path}: ${issue.message}`;
		})
		.join(", ");
}

/**
 * Creates a type-safe AgentTool with Zod schema validation and automatic retry logic.
 *
 * This factory function wraps tool execution with:
 * - Runtime parameter validation using Zod
 * - Automatic JSON schema generation for LLM tool calling
 * - Configurable retry logic for transient failures
 * - Telemetry integration (success/failure tracking, timing)
 * - Abort signal support for cancellation
 *
 * @template Schema - The Zod schema type for parameter validation
 * @template Details - Optional details type for structured tool results
 *
 * @param options - Tool configuration including name, schema, and execute function
 * @returns An AgentTool that can be registered with the agent
 *
 * @example
 * ```typescript
 * const readTool = createZodTool({
 *   name: "read",
 *   label: "Read File",
 *   description: "Read contents of a file",
 *   schema: z.object({
 *     path: z.string().describe("File path to read"),
 *     offset: z.number().optional().describe("Line number to start reading from")
 *   }),
 *   maxRetries: 2,
 *   execute: async (toolCallId, params) => {
 *     const content = await fs.readFile(params.path, 'utf-8');
 *     return { success: true, data: content };
 *   }
 * });
 * ```
 */
export function createZodTool<Schema extends z.ZodTypeAny, Details = undefined>(
	options: CreateZodToolOptions<Schema, Details>,
): AgentTool<any, Details> {
	const schemaName =
		options.schemaName ??
		`${options.name.charAt(0).toUpperCase()}${options.name.slice(1)}Parameters`;

	let jsonSchema = zodToJsonSchema(options.schema, {
		target: "jsonSchema7",
		$refStrategy: "none",
		name: schemaName,
	}) as JsonSchema7Type;

	// If the schema has $ref and definitions, inline the definition
	const schemaAny = jsonSchema as any;
	if (schemaAny.$ref && schemaAny.definitions) {
		const refKey = schemaAny.$ref.replace("#/definitions/", "");
		const definition = schemaAny.definitions[refKey];
		if (definition) {
			// Use the definition directly as the schema
			jsonSchema = definition as JsonSchema7Type;
		}
	}

	const schemaWithDescription = {
		...jsonSchema,
		description: jsonSchema.description ?? options.description,
	};

	// Remove $schema and definitions from the final schema
	const { $schema, definitions, $ref, ...cleanSchema } =
		schemaWithDescription as any;

	const parameters = Type.Unsafe<z.infer<Schema>>(cleanSchema);

	return {
		name: options.name,
		label: options.label,
		description: options.description,
		parameters,
		execute: async (toolCallId, params, signal) => {
			let parsedParams: z.infer<Schema>;

			try {
				parsedParams = options.schema.parse(params);
			} catch (error: unknown) {
				if (error instanceof ZodError) {
					throw new Error(
						`Invalid arguments for ${options.name}: ${formatZodIssues(error)}`,
					);
				}
				throw error;
			}

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
						retrying: true,
					});

					await delay(retryDelayMs * attempt);
				}
			}

			throw lastError ?? new Error("Tool execution failed");
		},
	};
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

export function isTransientToolError(error: unknown): boolean {
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
