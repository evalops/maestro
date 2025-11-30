import type { TSchema } from "@sinclair/typebox";
import type { AgentToolResult, ToolAnnotations } from "../agent/types.js";
import type { Sandbox } from "../sandbox/types.js";

export class ToolResponseBuilder<Details> {
	private _content: (
		| { type: "text"; text: string }
		| { type: "image"; data: string; mimeType: string }
	)[] = [];
	private _details?: Details;
	private _isError = false;

	text(content: string): this {
		this._content.push({ type: "text", text: content });
		return this;
	}

	image(base64: string, mimeType: string): this {
		this._content.push({ type: "image", data: base64, mimeType });
		return this;
	}

	detail(details: Details): this {
		this._details = details;
		return this;
	}

	error(message: string): this {
		this.text(message);
		this._isError = true;
		return this;
	}

	build(): AgentToolResult<Details> {
		return {
			content: this._content,
			details: this._details,
			isError: this._isError,
		};
	}
}

export interface ToolRunContext<Details> {
	toolCallId: string;
	signal?: AbortSignal;
	respond: ToolResponseBuilder<Details>;
	sandbox?: Sandbox;
}

export interface CreateToolOptions<Schema extends TSchema, Details> {
	name: string;
	label?: string;
	description: string;
	schema: Schema;
	annotations?: ToolAnnotations;
	toolType?: string;
	inputExamples?: unknown[];
	allowedCallers?: string[];
	deferApiDefinition?: boolean;
	run: (
		params: import("@sinclair/typebox").Static<Schema>,
		context: ToolRunContext<Details>,
	) =>
		| undefined
		| ToolResponseBuilder<Details>
		| AgentToolResult<Details>
		| Promise<
				undefined | ToolResponseBuilder<Details> | AgentToolResult<Details>
		  >;
	maxRetries?: number;
	retryDelayMs?: number;
	shouldRetry?: (error: unknown) => boolean;
}

export class ToolError extends Error {
	constructor(
		message: string,
		public readonly code?: string,
		public readonly details?: unknown,
	) {
		super(message);
		this.name = "ToolError";
	}
}

export function createTool<Schema extends TSchema, Details = undefined>(
	options: CreateToolOptions<Schema, Details>,
) {
	return Object.freeze({
		name: options.name,
		label: options.label ?? options.name,
		description: options.description,
		parameters: options.schema,
		annotations: options.annotations,
		toolType: options.toolType,
		inputExamples: options.inputExamples,
		allowedCallers: options.allowedCallers,
		deferApiDefinition: options.deferApiDefinition,
		maxRetries: options.maxRetries,
		retryDelayMs: options.retryDelayMs,
		shouldRetry: options.shouldRetry,
		execute: async (
			toolCallId: string,
			params: Record<string, unknown>,
			signal?: AbortSignal,
			context?: { sandbox?: Sandbox },
		) => {
			const builder = new ToolResponseBuilder<Details>();
			const result = await options.run(params as any, {
				toolCallId,
				signal,
				respond: builder,
				sandbox: context?.sandbox,
			});
			if (result instanceof ToolResponseBuilder) {
				return result.build();
			}
			if (result) {
				return result;
			}
			return builder.build();
		},
	});
}

import os from "node:os";

export function expandUserPath(path: string): string {
	if (path === "~") {
		return os.homedir();
	}
	if (path.startsWith("~/")) {
		return path.replace("~", os.homedir());
	}
	return path;
}

export interface CreateTextToolOptions<Schema extends TSchema, Details>
	extends Omit<CreateToolOptions<Schema, Details>, "run"> {
	run: (
		params: import("@sinclair/typebox").Static<Schema>,
		context: ToolRunContext<Details>,
	) =>
		| string
		| undefined
		| ToolResponseBuilder<Details>
		| AgentToolResult<Details>
		| Promise<
				| string
				| undefined
				| ToolResponseBuilder<Details>
				| AgentToolResult<Details>
		  >;
}

export function createTextTool<Schema extends TSchema, Details = undefined>(
	options: CreateTextToolOptions<Schema, Details>,
) {
	return createTool<Schema, Details>({
		...options,
		run: async (params, context) => {
			const result = await options.run(params, context);
			if (typeof result === "string") {
				return context.respond.text(result);
			}
			return result;
		},
	});
}

export interface CreateJsonToolOptions<Schema extends TSchema, Details>
	extends Omit<CreateToolOptions<Schema, Details>, "run"> {
	run: (
		params: import("@sinclair/typebox").Static<Schema>,
		context: ToolRunContext<Details>,
	) =>
		| unknown
		| undefined
		| ToolResponseBuilder<Details>
		| AgentToolResult<Details>
		| Promise<
				| unknown
				| undefined
				| ToolResponseBuilder<Details>
				| AgentToolResult<Details>
		  >;
}

export function createJsonTool<Schema extends TSchema, Details = undefined>(
	options: CreateJsonToolOptions<Schema, Details>,
) {
	return createTool<Schema, Details>({
		...options,
		run: async (params, context) => {
			const result = await options.run(params, context);
			if (
				result !== undefined &&
				!(result instanceof ToolResponseBuilder) &&
				!isAgentToolResult(result)
			) {
				return context.respond.text(JSON.stringify(result, null, 2));
			}
			return result as any;
		},
	});
}

function isAgentToolResult<Details>(
	value: unknown,
): value is AgentToolResult<Details> {
	return (
		typeof value === "object" &&
		value !== null &&
		"content" in value &&
		Array.isArray((value as AgentToolResult<Details>).content)
	);
}
