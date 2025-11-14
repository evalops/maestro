import { performance } from "node:perf_hooks";
import type { AgentTool } from "@mariozechner/pi-ai";
import type { AgentToolResult } from "@mariozechner/pi-ai/dist/agent/types.js";
import { Type } from "@sinclair/typebox";
import type { z } from "zod";
import { ZodError } from "zod";
import type { JsonSchema7Type } from "zod-to-json-schema";
import { zodToJsonSchema } from "zod-to-json-schema";
import { recordToolExecution } from "../telemetry.js";

type ExecuteResult<Details> =
	| AgentToolResult<Details>
	| Promise<AgentToolResult<Details>>;

interface CreateZodToolOptions<Schema extends z.ZodTypeAny, Details> {
	name: string;
	label: string;
	description: string;
	schema: Schema;
	schemaName?: string;
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

	const jsonSchema = zodToJsonSchema(options.schema, {
		target: "jsonSchema7",
		$refStrategy: "none",
		name: schemaName,
	}) as JsonSchema7Type;

	const schemaWithDescription = {
		...jsonSchema,
		description: jsonSchema.description ?? options.description,
	};

	const parameters = Type.Unsafe<z.infer<Schema>>(schemaWithDescription as any);

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

			const start = performance.now();
			try {
				const result = await options.execute(toolCallId, parsedParams, signal);
				recordToolExecution(options.name, true, performance.now() - start, {
					toolCallId,
				});
				return result;
			} catch (error: unknown) {
				recordToolExecution(options.name, false, performance.now() - start, {
					toolCallId,
					error:
						error instanceof Error ? error.message : String(error ?? "unknown"),
				});
				throw error;
			}
		},
	};
}
