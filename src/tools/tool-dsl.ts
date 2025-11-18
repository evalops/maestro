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

	image(data: string, mimeType: string): this {
		this.contents.push({ type: "image", data, mimeType });
		return this;
	}

	push(content: TextContent | ImageContent): this {
		this.contents.push(content);
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
