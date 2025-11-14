import type {
	AgentTool,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Model,
	PromptCacheControl,
	ReasoningEffort,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	Usage,
} from "../types.js";

export interface AnthropicOptions extends StreamOptions {
	thinking?: ReasoningEffort;
}

interface AnthropicMessage {
	role: "user" | "assistant";
	content:
		| string
		| Array<
				| { type: "text"; text: string; cache_control?: PromptCacheControl }
				| {
						type: "image";
						source: { type: "base64"; media_type: string; data: string };
						cache_control?: PromptCacheControl;
				  }
				| { type: "tool_use"; id: string; name: string; input: any }
				| {
						type: "tool_result";
						tool_use_id: string;
						content:
							| string
							| Array<
									| { type: "text"; text: string }
									| {
											type: "image";
											source: {
												type: "base64";
												media_type: string;
												data: string;
											};
									  }
							  >;
						is_error?: boolean;
						cache_control?: PromptCacheControl;
				  }
		  >;
}

interface AnthropicTool {
	name: string;
	description: string;
	input_schema: any;
	cache_control?: PromptCacheControl;
}

export async function* streamAnthropic(
	model: Model<"anthropic-messages">,
	context: Context,
	options: AnthropicOptions,
): AsyncGenerator<AssistantMessageEvent, void, unknown> {
	const apiKey = options.apiKey;
	if (!apiKey) {
		throw new Error("API key is required for Anthropic");
	}

	// Convert messages
	const messages: AnthropicMessage[] = [];
	for (let i = 0; i < context.messages.length; i++) {
		const msg = context.messages[i];

		if (msg.role === "user") {
			const content =
				typeof msg.content === "string"
					? msg.content
					: msg.content.map((c) => {
							if (c.type === "text") {
								return { type: "text" as const, text: c.text };
							}
							return {
								type: "image" as const,
								source: {
									type: "base64" as const,
									media_type: c.mimeType,
									data: c.data,
								},
							};
						});
			messages.push({ role: "user", content });
		} else if (msg.role === "assistant") {
			const content: any[] = [];
			for (const c of msg.content) {
				if (c.type === "text") {
					content.push({ type: "text", text: c.text });
				} else if (c.type === "toolCall") {
					content.push({
						type: "tool_use",
						id: c.id,
						name: c.name,
						input: c.arguments,
					});
				}
			}
			messages.push({ role: "assistant", content });
		} else if (msg.role === "toolResult") {
			// Collect all consecutive toolResult messages into one user message
			const toolResults: any[] = [];

			// Helper to convert tool result content
			const convertToolResultContent = (content: any) =>
				typeof content === "string"
					? content
					: content.map((c: any) => {
							if (c.type === "text") {
								return { type: "text" as const, text: c.text };
							}
							return {
								type: "image" as const,
								source: {
									type: "base64" as const,
									media_type: c.mimeType,
									data: c.data,
								},
							};
						});

			// Add the current tool result
			toolResults.push({
				type: "tool_result",
				tool_use_id: msg.toolCallId,
				content: convertToolResultContent(msg.content),
				is_error: msg.isError,
			});

			// Look ahead for consecutive toolResult messages
			let j = i + 1;
			while (
				j < context.messages.length &&
				context.messages[j].role === "toolResult"
			) {
				const nextMsg = context.messages[j] as ToolResultMessage;
				toolResults.push({
					type: "tool_result",
					tool_use_id: nextMsg.toolCallId,
					content: convertToolResultContent(nextMsg.content),
					is_error: nextMsg.isError,
				});
				j++;
			}

			// Skip the messages we've already processed
			i = j - 1;

			// Add a single user message with all tool results
			messages.push({
				role: "user",
				content: toolResults,
			});
		}
	}

	// Apply prompt caching - mark last 4 items for caching
	let cacheAppliedCount = 0;
	const maxCacheItems = 4;

	// Cache tools (last tool)
	const tools: AnthropicTool[] =
		context.tools?.map((tool, idx, arr) => {
			const params = tool.parameters as any;
			const schema = {
				type: "object" as const,
				properties: params.properties || {},
				required: params.required || [],
			};
			return {
				name: tool.name,
				description: tool.description,
				input_schema: schema,
				...(idx === arr.length - 1 && cacheAppliedCount < maxCacheItems
					? { cache_control: { type: "ephemeral" as const } }
					: {}),
			};
		}) || [];

	if (tools.length > 0 && tools[tools.length - 1].cache_control) {
		cacheAppliedCount++;
	}

	// Cache system prompt
	const systemBlocks: Array<{
		type: "text";
		text: string;
		cache_control?: PromptCacheControl;
	}> = [];
	if (context.systemPrompt) {
		systemBlocks.push({
			type: "text",
			text: context.systemPrompt,
			...(cacheAppliedCount < maxCacheItems
				? { cache_control: { type: "ephemeral" as const } }
				: {}),
		});
		if (systemBlocks[0].cache_control) {
			cacheAppliedCount++;
		}
	}

	// Cache messages (mark breakpoints from end)
	for (
		let i = messages.length - 1;
		i >= 0 && cacheAppliedCount < maxCacheItems;
		i--
	) {
		const msg = messages[i];
		if (msg.role === "user" && Array.isArray(msg.content)) {
			const lastContent = msg.content[msg.content.length - 1];
			if (
				lastContent &&
				(lastContent.type === "text" || lastContent.type === "image")
			) {
				lastContent.cache_control = { type: "ephemeral" };
				cacheAppliedCount++;
			}
		}
	}

	const requestBody: any = {
		model: model.id,
		max_tokens: options.maxTokens || model.maxTokens,
		messages,
		stream: true,
	};

	if (systemBlocks.length > 0) {
		requestBody.system = systemBlocks;
	}

	if (tools.length > 0) {
		requestBody.tools = tools;
	}

	if (options.temperature !== undefined) {
		requestBody.temperature = options.temperature;
	}

	if (options.thinking && model.reasoning) {
		requestBody.thinking = {
			type: "enabled",
			budget_tokens: 10000,
		};
	}

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"anthropic-version": "2023-06-01",
		"x-api-key": apiKey,
		...options.headers,
	};

	if (options.thinking && model.reasoning) {
		headers["anthropic-beta"] =
			"prompt-caching-2024-07-31,extended-thinking-2024-12-12";
	} else {
		headers["anthropic-beta"] = "prompt-caching-2024-07-31";
	}

	const response = await fetch(model.baseUrl, {
		method: "POST",
		headers,
		body: JSON.stringify(requestBody),
		signal: options.signal,
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Anthropic API error (${response.status}): ${errorText}`);
	}

	if (!response.body) {
		throw new Error("Response body is null");
	}

	const partial: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};

	yield { type: "start", partial };

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";

			for (const line of lines) {
				if (!line.trim() || !line.startsWith("data: ")) continue;
				const data = line.slice(6);
				if (data === "[DONE]") continue;

				try {
					const event = JSON.parse(data);

					if (event.type === "message_start") {
						if (event.message?.usage) {
							partial.usage.input = event.message.usage.input_tokens || 0;
							partial.usage.cacheRead =
								event.message.usage.cache_read_input_tokens || 0;
							partial.usage.cacheWrite =
								event.message.usage.cache_creation_input_tokens || 0;
						}
					} else if (event.type === "content_block_start") {
						const block = event.content_block;
						if (block.type === "text") {
							const idx = partial.content.length;
							partial.content.push({ type: "text", text: "" });
							yield { type: "text_start", contentIndex: idx, partial };
						} else if (block.type === "thinking") {
							const idx = partial.content.length;
							partial.content.push({ type: "thinking", thinking: "" });
							yield { type: "thinking_start", contentIndex: idx, partial };
						} else if (block.type === "tool_use") {
							const idx = partial.content.length;
							const toolCall: any = {
								type: "toolCall",
								id: block.id,
								name: block.name,
								arguments: {},
								partialJson: "", // Track partial JSON
							};
							partial.content.push(toolCall);
							yield { type: "toolcall_start", contentIndex: idx, partial };
						}
					} else if (event.type === "content_block_delta") {
						const delta = event.delta;
						const idx = event.index;
						const block = partial.content[idx];

						if (delta.type === "text_delta" && block?.type === "text") {
							block.text += delta.text;
							yield {
								type: "text_delta",
								contentIndex: idx,
								delta: delta.text,
								partial,
							};
						} else if (
							delta.type === "thinking_delta" &&
							block?.type === "thinking"
						) {
							block.thinking += delta.thinking;
							yield {
								type: "thinking_delta",
								contentIndex: idx,
								delta: delta.thinking,
								partial,
							};
						} else if (
							delta.type === "input_json_delta" &&
							block?.type === "toolCall"
						) {
							const partialJson = delta.partial_json || "";
							(block as any).partialJson =
								((block as any).partialJson || "") + partialJson;

							// Try to parse accumulated JSON
							try {
								block.arguments = JSON.parse((block as any).partialJson);
							} catch {
								// Not complete JSON yet, keep accumulating
							}

							yield {
								type: "toolcall_delta",
								contentIndex: idx,
								delta: partialJson,
								partial,
							};
						}
					} else if (event.type === "content_block_stop") {
						const idx = event.index;
						const block = partial.content[idx];

						if (block?.type === "text") {
							yield {
								type: "text_end",
								contentIndex: idx,
								content: block.text,
								partial,
							};
						} else if (block?.type === "thinking") {
							yield {
								type: "thinking_end",
								contentIndex: idx,
								content: block.thinking,
								partial,
							};
						} else if (block?.type === "toolCall") {
							yield {
								type: "toolcall_end",
								contentIndex: idx,
								toolCall: block,
								partial,
							};
						}
					} else if (event.type === "message_delta") {
						if (event.delta?.stop_reason) {
							partial.stopReason =
								event.delta.stop_reason === "end_turn"
									? "stop"
									: event.delta.stop_reason === "max_tokens"
										? "length"
										: event.delta.stop_reason === "tool_use"
											? "toolUse"
											: "stop";
						}
						if (event.usage) {
							partial.usage.output = event.usage.output_tokens || 0;
						}
					} else if (event.type === "message_stop") {
						// Calculate costs
						partial.usage.cost = {
							input: (partial.usage.input * model.cost.input) / 1_000_000,
							output: (partial.usage.output * model.cost.output) / 1_000_000,
							cacheRead:
								(partial.usage.cacheRead * model.cost.cacheRead) / 1_000_000,
							cacheWrite:
								(partial.usage.cacheWrite * model.cost.cacheWrite) / 1_000_000,
							total: 0,
						};
						partial.usage.cost.total =
							partial.usage.cost.input +
							partial.usage.cost.output +
							partial.usage.cost.cacheRead +
							partial.usage.cost.cacheWrite;

						yield {
							type: "done",
							reason: partial.stopReason as any,
							message: partial,
						};
					} else if (event.type === "error") {
						partial.stopReason = "error";
						partial.errorMessage = event.error?.message || "Unknown error";
						yield { type: "error", reason: "error", error: partial };
					}
				} catch (e) {
					// Skip malformed event
					console.warn("Failed to parse Anthropic event:", e);
				}
			}
		}
	} catch (error: unknown) {
		if (error instanceof Error && error.name === "AbortError") {
			partial.stopReason = "aborted";
			yield { type: "error", reason: "aborted", error: partial };
		} else {
			throw error;
		}
	}
}
