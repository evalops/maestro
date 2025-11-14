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

interface CreateZodToolOptions<Schema extends z.ZodTypeAny, Details> {
	name: string;
	label: string;
	description: string;
	schema: Schema;
	schemaName?: string;
	maxRetries?: number;
	retryDelayMs?: number;
	shouldRetry?: (error: unknown) => boolean;
	execute: (
		toolCallId: string,
		params: z.infer<Schema>,
		signal?: AbortSignal,
	) => ExecuteResult<Details>;
}

function formatZodIssues(error: ZodError): string {
	return error.issues
		.map((issue) => {
			const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
			return `${path}: ${issue.message}`;
		})
		.join(", ");
}

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
