/**
 * Provider Stream Dispatch
 * Routes model API type to the appropriate streaming provider implementation.
 */

import { streamAnthropic } from "../providers/anthropic.js";
import { streamBedrock } from "../providers/bedrock.js";
import { streamGoogleGeminiCli } from "../providers/google-gemini-cli.js";
import { streamGoogle } from "../providers/google.js";
import { streamOpenAI } from "../providers/openai.js";
import type {
	Api,
	AssistantMessageEvent,
	Context,
	Model,
	ReasoningEffort,
	StreamOptions,
} from "../types.js";

export interface ReasoningOptions {
	reasoning?: ReasoningEffort;
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
}

/**
 * Create a provider stream based on the model's API type.
 * Dispatches to the appropriate streaming implementation.
 */
export function createProviderStream(
	model: Model<Api>,
	context: Context,
	options: StreamOptions,
	reasoning: ReasoningOptions,
): AsyncGenerator<AssistantMessageEvent, void, unknown> {
	if (model.api === "anthropic-messages") {
		return streamAnthropic(model as Model<"anthropic-messages">, context, {
			...options,
			thinking: reasoning.reasoning,
		});
	}

	if (model.api === "openai-completions" || model.api === "openai-responses") {
		return streamOpenAI(
			model as Model<"openai-completions" | "openai-responses">,
			context,
			{
				...options,
				reasoningEffort: reasoning.reasoning,
				reasoningSummary: reasoning.reasoningSummary,
			},
		);
	}

	if (model.api === "google-generative-ai") {
		return streamGoogle(model as Model<"google-generative-ai">, context, {
			...options,
			thinking: reasoning.reasoning,
		});
	}

	if (model.api === "google-gemini-cli") {
		return streamGoogleGeminiCli(model as Model<"google-gemini-cli">, context, {
			...options,
			thinking: reasoning.reasoning,
		});
	}

	if (model.api === "bedrock-converse") {
		return streamBedrock(model as Model<"bedrock-converse">, context, options);
	}

	throw new Error(`Unsupported API: ${model.api}`);
}
