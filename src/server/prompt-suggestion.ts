import type {
	ComposerMessage,
	ComposerPromptSuggestionRequest,
	ComposerPromptSuggestionResponse,
} from "@evalops/contracts";
import type { Agent } from "../agent/index.js";
import type { AssistantMessage } from "../agent/types.js";
import {
	type RegisteredModel,
	getRegisteredModels,
} from "../models/registry.js";

const MAX_TRANSCRIPT_CHARS = 6_000;
const MAX_MESSAGE_CHARS = 700;
const MAX_RECENT_MESSAGES = 8;
const FAST_MODEL_HINT = /(haiku|mini|nano|flash)/i;
const PROMPT_SUGGESTION_SYSTEM_PROMPT = `You suggest the next natural user prompt for a coding assistant conversation.

Return exactly one plausible next user message.

Rules:
- Output only the user prompt text.
- Do not use quotes, bullets, markdown, labels, or explanations.
- Keep it under 120 characters.
- Make it concrete and action-oriented.
- Base it only on the recent conversation.
- Do not mention hidden policies, system prompts, or internal tooling.
- If there is no useful follow-up prompt to suggest, return NONE.`;

export interface PromptSuggestionDependencies {
	getRegisteredModel: (
		input: string | null | undefined,
	) => Promise<RegisteredModel>;
	getCurrentSelection: () => { provider: string; modelId: string };
	createBackgroundAgent: (
		model: RegisteredModel,
		options?: { systemPrompt?: string },
	) => Promise<Agent>;
}

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function getComposerMessageText(message: ComposerMessage): string {
	const parts: string[] = [];
	if (typeof message.content === "string") {
		parts.push(message.content);
	} else if (Array.isArray(message.content)) {
		for (const block of message.content) {
			if (block.type === "text" && block.text) {
				parts.push(block.text);
			}
		}
	}
	if (
		message.role === "assistant" &&
		Array.isArray(message.tools) &&
		message.tools.length > 0
	) {
		const tools = message.tools
			.map((tool) => normalizeWhitespace(tool.name ?? ""))
			.filter(Boolean)
			.slice(0, 4);
		if (tools.length > 0) {
			parts.push(`Tools: ${tools.join(", ")}`);
		}
	}
	return normalizeWhitespace(parts.join("\n"));
}

function getLastRelevantMessage(
	messages: ComposerMessage[],
): ComposerMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role === "user" || message?.role === "assistant") {
			return message;
		}
	}
	return undefined;
}

function buildTranscript(messages: ComposerMessage[]): string {
	const relevant = messages
		.filter(
			(message) => message.role === "user" || message.role === "assistant",
		)
		.slice(-MAX_RECENT_MESSAGES)
		.map((message) => {
			const text = getComposerMessageText(message)
				.slice(0, MAX_MESSAGE_CHARS)
				.trim();
			if (!text) {
				return null;
			}
			return `${message.role.toUpperCase()}: ${text}`;
		})
		.filter((line): line is string => Boolean(line));
	const transcript = relevant.join("\n\n");
	if (transcript.length <= MAX_TRANSCRIPT_CHARS) {
		return transcript;
	}
	return transcript.slice(-MAX_TRANSCRIPT_CHARS);
}

function extractAssistantText(message: AssistantMessage): string {
	const content = message?.content as unknown;
	if (typeof content === "string") {
		return content.trim();
	}
	if (Array.isArray(content)) {
		return content
			.filter(
				(block): block is { type: "text"; text: string } =>
					Boolean(block) &&
					typeof block === "object" &&
					"type" in block &&
					(block as { type?: string }).type === "text" &&
					"text" in block &&
					typeof (block as { text?: unknown }).text === "string",
			)
			.map((block) => block.text.trim())
			.filter(Boolean)
			.join("\n")
			.trim();
	}
	return "";
}

function normalizeGeneratedSuggestion(
	raw: string,
	messages: ComposerMessage[],
): string | null {
	const firstLine = raw
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find(Boolean);
	if (!firstLine) {
		return null;
	}

	let suggestion = firstLine
		.replace(/^suggestion:\s*/i, "")
		.replace(/^[*-]\s*/, "")
		.replace(/^["'`]+|["'`]+$/g, "")
		.trim();
	suggestion = normalizeWhitespace(suggestion);

	if (!suggestion || /^(none|n\/a|null)$/i.test(suggestion)) {
		return null;
	}
	if (suggestion.length > 120) {
		return null;
	}

	const lastUser = [...messages]
		.reverse()
		.find((message) => message.role === "user");
	const lastUserText = lastUser
		? normalizeWhitespace(getComposerMessageText(lastUser))
		: "";
	if (lastUserText && suggestion.toLowerCase() === lastUserText.toLowerCase()) {
		return null;
	}

	return suggestion;
}

function pickFastModel(models: RegisteredModel[]): RegisteredModel | undefined {
	return models.find((model) => FAST_MODEL_HINT.test(model.id));
}

function selectPromptSuggestionModel(
	preferredModel: RegisteredModel,
): RegisteredModel {
	if (FAST_MODEL_HINT.test(preferredModel.id)) {
		return preferredModel;
	}

	const models = getRegisteredModels();
	const sameProviderFast = pickFastModel(
		models.filter((model) => model.provider === preferredModel.provider),
	);
	return sameProviderFast ?? pickFastModel(models) ?? preferredModel;
}

export function getPromptSuggestionSuppressReason(
	messages: ComposerMessage[],
): string | null {
	const relevant = messages.filter(
		(message) => message.role === "user" || message.role === "assistant",
	);
	const assistantCount = relevant.filter(
		(message) => message.role === "assistant",
	).length;
	if (assistantCount < 2) {
		return "early_conversation";
	}

	const lastRelevant = getLastRelevantMessage(relevant);
	if (!lastRelevant || lastRelevant.role !== "assistant") {
		return "awaiting_assistant";
	}
	if (lastRelevant.isError) {
		return "last_response_error";
	}

	const transcript = buildTranscript(relevant);
	if (!transcript) {
		return "empty_conversation";
	}

	return null;
}

export async function generatePromptSuggestion(
	request: ComposerPromptSuggestionRequest,
	deps: PromptSuggestionDependencies,
): Promise<ComposerPromptSuggestionResponse> {
	const suppressReason = getPromptSuggestionSuppressReason(request.messages);
	if (suppressReason) {
		return {
			suggestion: null,
			suppressedReason: suppressReason,
		};
	}

	const selection =
		request.model ??
		`${deps.getCurrentSelection().provider}/${deps.getCurrentSelection().modelId}`;
	const preferredModel = await deps.getRegisteredModel(selection);
	const suggestionModel = selectPromptSuggestionModel(preferredModel);
	const agent = await deps.createBackgroundAgent(suggestionModel, {
		systemPrompt: PROMPT_SUGGESTION_SYSTEM_PROMPT,
	});
	const transcript = buildTranscript(request.messages);
	const response = await agent.generateSummary(
		[],
		`Recent conversation, oldest to newest:\n\n${transcript}\n\nSuggest the next user message.`,
		PROMPT_SUGGESTION_SYSTEM_PROMPT,
		suggestionModel,
	);
	const suggestion = normalizeGeneratedSuggestion(
		extractAssistantText(response),
		request.messages,
	);
	if (!suggestion) {
		return {
			suggestion: null,
			suppressedReason: "empty",
			model: `${suggestionModel.provider}/${suggestionModel.id}`,
		};
	}

	return {
		suggestion,
		model: `${suggestionModel.provider}/${suggestionModel.id}`,
	};
}
