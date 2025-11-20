import type { Agent } from "../agent/agent.js";
import type { AssistantMessage, Message } from "../agent/types.js";
import {
	type RegisteredModel,
	getRegisteredModels,
} from "../models/registry.js";
import type { SessionManager } from "../session/manager.js";
import type {
	SessionDataProvider,
	SessionItem,
} from "./session-data-provider.js";

interface SessionSummaryControllerOptions {
	agent: Agent;
	sessionManager: SessionManager;
	sessionDataProvider: SessionDataProvider;
	showInfo: (message: string) => void;
	showError: (message: string) => void;
}

export function selectSummaryModel(
	models: RegisteredModel[],
): RegisteredModel | undefined {
	const priorities = [
		(models: RegisteredModel[]) =>
			models.find(
				(model) => model.provider === "anthropic" && /haiku/i.test(model.id),
			),
		(models: RegisteredModel[]) =>
			models.find(
				(model) => model.provider === "openai" && /mini/i.test(model.id),
			),
		(models: RegisteredModel[]) =>
			models.find(
				(model) =>
					model.provider === "openrouter" &&
					(/haiku/i.test(model.id) || /mini/i.test(model.id)),
			),
		(models: RegisteredModel[]) =>
			models.find((model) => model.provider === "anthropic"),
		(models: RegisteredModel[]) =>
			models.find((model) => model.provider === "openai"),
		(models: RegisteredModel[]) =>
			models.find((model) => model.provider === "openrouter"),
	];

	for (const pick of priorities) {
		const candidate = pick(models);
		if (candidate) {
			return candidate;
		}
	}
	return undefined;
}

export class SessionSummaryController {
	private readonly inFlight = new Set<string>();

	constructor(private readonly options: SessionSummaryControllerOptions) {}

	async summarize(session: SessionItem): Promise<void> {
		if (this.inFlight.has(session.path)) {
			this.options.showInfo("Summary already in progress for that session.");
			return;
		}

		const model = this.pickSummaryModel();
		if (!model && !this.options.agent.state.model) {
			this.options.showError("No model available to summarize the session.");
			return;
		}

		const transcript = this.buildTranscript(session);
		if (!transcript) {
			this.options.showInfo("Nothing to summarize for that session.");
			return;
		}

		this.inFlight.add(session.path);
		this.options.showInfo("Summarizing session…");
		try {
			const { systemPrompt, userPrompt } = this.buildPrompts(transcript);
			const response = await this.options.agent.generateSummary(
				[] as Message[],
				userPrompt,
				systemPrompt,
				model,
			);
			const text = this.extractText(response);
			if (!text) {
				throw new Error("Model returned no summary text");
			}
			this.options.sessionManager.saveSessionSummary(text, session.path);
			this.options.sessionDataProvider.refresh();
			this.options.showInfo("Saved session summary.");
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: String(error ?? "unknown error");
			this.options.showError(`Failed to summarize session: ${message}`);
		} finally {
			this.inFlight.delete(session.path);
		}
	}

	private buildTranscript(session: SessionItem): string {
		const text = session.allMessagesText || "";
		const trimmed = text.trim();
		if (!trimmed) return "";
		const limit = 4000;
		if (trimmed.length <= limit) {
			return trimmed;
		}
		return trimmed.slice(-limit);
	}

	private buildPrompts(transcript: string): {
		systemPrompt: string;
		userPrompt: string;
	} {
		const systemPrompt =
			"You summarize coding sessions as short changelog-style blurbs. Be specific and under 120 characters.";
		const userPrompt = `Transcript of a coding session (latest activity last):\n\n${transcript}\n\nProvide a short summary (<120 characters) describing what was done. Do not include punctuation at the end.`;
		return { systemPrompt, userPrompt };
	}

	private extractText(message: AssistantMessage): string | undefined {
		const content = message?.content as unknown;
		if (!content) return undefined;
		if (typeof content === "string") {
			return content.trim();
		}
		if (Array.isArray(content)) {
			const textBlock = content.find((block) => block.type === "text");
			return textBlock?.text?.trim();
		}
		return undefined;
	}

	private pickSummaryModel(): RegisteredModel | undefined {
		return selectSummaryModel(getRegisteredModels());
	}
}
