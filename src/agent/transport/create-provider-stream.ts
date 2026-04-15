/**
 * Provider Stream Dispatch
 * Routes model API type to the appropriate streaming provider implementation.
 *
 * Uses lazy loading via dynamic imports to avoid loading all provider SDKs
 * at startup. Each provider module is loaded on first use and cached.
 */

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
 *
 * Provider modules are loaded lazily on first use to improve startup performance.
 */
export async function* createProviderStream(
	model: Model<Api>,
	context: Context,
	options: StreamOptions,
	reasoning: ReasoningOptions,
): AsyncGenerator<AssistantMessageEvent, void, unknown> {
	if (model.api === "anthropic-messages") {
		const { streamAnthropic } = await import("../providers/anthropic.js");
		yield* streamAnthropic(model as Model<"anthropic-messages">, context, {
			...options,
			thinking: reasoning.reasoning,
		});
		return;
	}

	if (model.api === "openai-completions" || model.api === "openai-responses") {
		const { streamOpenAI } = await import("../providers/openai.js");
		yield* streamOpenAI(
			model as Model<"openai-completions" | "openai-responses">,
			context,
			{
				...options,
				reasoningEffort: reasoning.reasoning,
				reasoningSummary: reasoning.reasoningSummary,
			},
		);
		return;
	}

	if (model.api === "google-generative-ai") {
		const { streamGoogle } = await import("../providers/google.js");
		yield* streamGoogle(model as Model<"google-generative-ai">, context, {
			...options,
			thinking: reasoning.reasoning,
		});
		return;
	}

	if (model.api === "google-gemini-cli") {
		const { streamGoogleGeminiCli } = await import(
			"../providers/google-gemini-cli.js"
		);
		yield* streamGoogleGeminiCli(model as Model<"google-gemini-cli">, context, {
			...options,
			thinking: reasoning.reasoning,
		});
		return;
	}

	if (model.api === "bedrock-converse") {
		const { streamBedrock } = await import("../providers/bedrock.js");
		yield* streamBedrock(model as Model<"bedrock-converse">, context, options);
		return;
	}

	if (model.api === "vertex-ai") {
		const { streamVertex } = await import("../providers/vertex.js");
		yield* streamVertex(model as Model<"vertex-ai">, context, {
			...options,
			thinking: reasoning.reasoning,
		});
		return;
	}

	throw new Error(`Unsupported API: ${model.api}`);
}
