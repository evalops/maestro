import os from "node:os";
import type { Static, TSchema } from "@sinclair/typebox";
import type {
	AgentToolResult,
	ImageContent,
	TextContent,
} from "../agent/types.js";
import { createTypeboxTool } from "./typebox-tool.js";

export class ToolResponseBuilder<Details> {
	private contents: (TextContent | ImageContent)[] = [];
	private details: Details | undefined;

	text(text: string): this {
		this.contents.push({ type: "text", text });
		return this;
	}

	json(value: unknown, spacing = 2): this {
		const serialized = JSON.stringify(value, null, spacing);
		return this.text(serialized);
	}

	code(language: string | undefined, code: string): this {
		const lang = language?.trim();
		const fence = "```";
		const header = lang && lang.length > 0 ? `${fence}${lang}\n` : `${fence}\n`;
		const block = `${header}${code}\n${fence}`;
		return this.text(block);
	}

	image(data: string, mimeType: string): this {
		this.contents.push({ type: "image", data, mimeType });
		return this;
	}

	push(content: TextContent | ImageContent): this {
		this.contents.push(content);
		return this;
	}

	error(message: string, details?: Details): this {
		const prefix = message.startsWith("Error:") ? message : `Error: ${message}`;
		this.text(prefix);
		if (details !== undefined) {
			this.detail(details);
		}
		return this;
	}

	detail(value: Details): this {
		this.details = value;
		return this;
	}

	setDetails(value: Details): this {
		return this.detail(value);
	}

	build(): AgentToolResult<Details> {
		if (this.contents.length === 0) {
			throw new Error(
				"ToolResponseBuilder produced no content. Call text()/image()/push() before build().",
			);
		}
		return {
			content: [...this.contents],
			details: this.details,
		};
	}
}

export interface ToolRunContext<Details> {
	toolCallId: string;
	signal?: AbortSignal;
	respond: ToolResponseBuilder<Details>;
}

export interface CreateToolOptions<Schema extends TSchema, Details> {
	name: string;
	label?: string;
	description: string;
	schema: Schema;
	run: (
		params: Static<Schema>,
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

export function createTool<Schema extends TSchema, Details = undefined>(
	options: CreateToolOptions<Schema, Details>,
) {
	return createTypeboxTool<Schema, Details>({
		name: options.name,
		label: options.label ?? options.name,
		description: options.description,
		schema: options.schema,
		maxRetries: options.maxRetries,
		retryDelayMs: options.retryDelayMs,
		shouldRetry: options.shouldRetry,
		execute: async (toolCallId, params, signal) => {
			const builder = new ToolResponseBuilder<Details>();
			const result = await options.run(params, {
				toolCallId,
				signal,
				respond: builder,
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

export function expandUserPath(path: string): string {
	if (path === "~") {
		return os.homedir();
	}
	if (path.startsWith("~/")) {
		return os.homedir() + path.slice(1);
	}
	return path;
}

function isAgentToolResult<Details>(
	value: unknown,
): value is AgentToolResult<Details> {
	return (
		typeof value === "object" &&
		value !== null &&
		"content" in (value as Record<string, unknown>) &&
		Array.isArray((value as AgentToolResult<Details>).content)
	);
}

export interface CreateTextToolOptions<Schema extends TSchema, Details>
	extends Omit<CreateToolOptions<Schema, Details>, "run"> {
	run: (
		params: Static<Schema>,
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
		params: Static<Schema>,
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
		run: async (
			params,
			context,
		): Promise<
			ToolResponseBuilder<Details> | AgentToolResult<Details> | undefined
		> => {
			const result = await options.run(params, context);
			if (
				result === undefined ||
				result instanceof ToolResponseBuilder ||
				isAgentToolResult<Details>(result)
			) {
				return result;
			}
			return context.respond.json(
				result,
			) as unknown as AgentToolResult<Details>;
		},
	});
}
