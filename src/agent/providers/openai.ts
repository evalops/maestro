import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Model,
	StreamOptions,
} from "../types.js";

export interface OpenAIOptions extends StreamOptions {}

interface OpenAIMessage {
	role: "system" | "user" | "assistant" | "tool";
	content:
		| string
		| Array<
				| { type: "text"; text: string }
				| {
						type: "image_url";
						image_url: { url: string; detail?: "auto" | "low" | "high" };
				  }
		  >;
	tool_call_id?: string;
	tool_calls?: Array<{
		id: string;
		type: "function";
		function: { name: string; arguments: string };
	}>;
}

/**
 * OpenAI/OpenRouter provider with automatic prompt caching (no explicit cache_control needed).
 * Caching is automatic for prompts >= 1024 tokens.
 * Structure prompts with static content at the beginning for best cache hit rates.
 */
export async function* streamOpenAI(
	model: Model<"openai-responses">,
	context: Context,
	options: OpenAIOptions,
): AsyncGenerator<AssistantMessageEvent, void, unknown> {
	const apiKey = options.apiKey;
	if (!apiKey) {
		throw new Error("API key is required for OpenAI");
	}

	const messages: OpenAIMessage[] = [];

	// System prompt
	if (context.systemPrompt) {
		messages.push({
			role: "system",
			content: context.systemPrompt,
		});
	}

	// Convert messages
	for (const msg of context.messages) {
		if (msg.role === "user") {
			const content =
				typeof msg.content === "string"
					? msg.content
					: msg.content.map((c) => {
							if (c.type === "text") {
								return { type: "text" as const, text: c.text };
							}
							// OpenAI expects image URLs
							const dataUrl = `data:${c.mimeType};base64,${c.data}`;
							return {
								type: "image_url" as const,
								image_url: { url: dataUrl },
							};
						});
			messages.push({ role: "user", content });
		} else if (msg.role === "assistant") {
			const textContent: Array<{ type: "text"; text: string }> = [];
			const toolCalls: Array<{
				id: string;
				type: "function";
				function: { name: string; arguments: string };
			}> = [];

			for (const c of msg.content) {
				if (c.type === "text") {
					textContent.push({ type: "text", text: c.text });
				} else if (c.type === "toolCall") {
					toolCalls.push({
						id: c.id,
						type: "function",
						function: {
							name: c.name,
							arguments: JSON.stringify(c.arguments),
						},
					});
				}
			}

			const message: OpenAIMessage = {
				role: "assistant",
				content: textContent.length > 0 ? textContent : "",
			};

			if (toolCalls.length > 0) {
				message.tool_calls = toolCalls;
			}

			messages.push(message);
		} else if (msg.role === "toolResult") {
			const content =
				typeof msg.content === "string"
					? msg.content
					: msg.content
							.map((c) => (c.type === "text" ? c.text : "[Image]"))
							.join("\n");

			messages.push({
				role: "tool",
				tool_call_id: msg.toolCallId,
				content,
			});
		}
	}

	const requestBody: any = {
		model: model.id,
		messages,
		max_tokens: options.maxTokens || model.maxTokens,
		stream: true,
		stream_options: { include_usage: true },
	};

	if (context.tools && context.tools.length > 0) {
		requestBody.tools = context.tools.map((tool) => ({
			type: "function",
			function: {
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			},
		}));
	}

	if (options.temperature !== undefined) {
		requestBody.temperature = options.temperature;
	}

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Authorization: `Bearer ${apiKey}`,
		...options.headers,
	};

	const response = await fetch(model.baseUrl, {
		method: "POST",
		headers,
		body: JSON.stringify(requestBody),
		signal: options.signal,
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
	}

	if (!response.body) {
		throw new Error("Response body is null");
	}

	const partial: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "openai-responses",
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
					const choice = event.choices?.[0];

					if (!choice) {
						// Check for usage data
						if (event.usage) {
							partial.usage.input = event.usage.prompt_tokens || 0;
							partial.usage.output = event.usage.completion_tokens || 0;
							// OpenAI caching: cached_tokens in prompt_tokens_details
							if (event.usage.prompt_tokens_details?.cached_tokens) {
								partial.usage.cacheRead =
									event.usage.prompt_tokens_details.cached_tokens;
								// Adjust input tokens to not double count
								partial.usage.input -= partial.usage.cacheRead;
							}
						}
						continue;
					}

					const delta = choice.delta;

					if (delta.content) {
						// Find or create text content block
						let textBlock = partial.content.find((c) => c.type === "text");
						if (!textBlock) {
							const idx = partial.content.length;
							textBlock = { type: "text", text: "" };
							partial.content.push(textBlock);
							yield { type: "text_start", contentIndex: idx, partial };
						}
						const idx = partial.content.indexOf(textBlock);
						textBlock.text += delta.content;
						yield {
							type: "text_delta",
							contentIndex: idx,
							delta: delta.content,
							partial,
						};
					}

					if (delta.tool_calls) {
						for (const toolCall of delta.tool_calls) {
							const idx = toolCall.index;

							// Ensure we have a slot
							while (partial.content.length <= idx) {
								partial.content.push({
									type: "toolCall",
									id: "",
									name: "",
									arguments: {},
								});
							}

							const block = partial.content[idx];
							if (block.type !== "toolCall") continue;

							if (toolCall.id) {
								block.id = toolCall.id;
								block.name = toolCall.function?.name || "";
								yield { type: "toolcall_start", contentIndex: idx, partial };
							}

							if (toolCall.function?.arguments) {
								const argsDelta = toolCall.function.arguments;
								yield {
									type: "toolcall_delta",
									contentIndex: idx,
									delta: argsDelta,
									partial,
								};
							}
						}
					}

					if (choice.finish_reason) {
						partial.stopReason =
							choice.finish_reason === "stop"
								? "stop"
								: choice.finish_reason === "length"
									? "length"
									: choice.finish_reason === "tool_calls"
										? "toolUse"
										: "stop";

						// Parse tool call arguments
						for (let i = 0; i < partial.content.length; i++) {
							const block = partial.content[i];
							if (block.type === "toolCall") {
								// Collect all deltas for this tool call (already accumulated as string)
								const argsStr = (block.arguments as any).toString?.() || "{}";
								try {
									block.arguments = JSON.parse(argsStr);
								} catch {
									block.arguments = {};
								}
								yield {
									type: "toolcall_end",
									contentIndex: i,
									toolCall: block,
									partial,
								};
							} else if (block.type === "text") {
								yield {
									type: "text_end",
									contentIndex: i,
									content: block.text,
									partial,
								};
							}
						}

						// Calculate costs
						partial.usage.cost = {
							input: (partial.usage.input * model.cost.input) / 1_000_000,
							output: (partial.usage.output * model.cost.output) / 1_000_000,
							cacheRead:
								(partial.usage.cacheRead * model.cost.cacheRead) / 1_000_000,
							cacheWrite: 0, // OpenAI doesn't charge for cache writes
							total: 0,
						};
						partial.usage.cost.total =
							partial.usage.cost.input +
							partial.usage.cost.output +
							partial.usage.cost.cacheRead;

						yield {
							type: "done",
							reason: partial.stopReason as any,
							message: partial,
						};
					}
				} catch (e) {
					console.warn("Failed to parse OpenAI event:", e);
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
