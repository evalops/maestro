import type { Message } from "../services/api-client.js";
import type { UiMessage } from "./composer-chat-stream-state.js";

export function getShareTokenFromLocation(): string | null {
	if (typeof window === "undefined") {
		return null;
	}
	try {
		const url = new URL(window.location.href);
		const match = /^\/share\/([^/]+)\/?$/.exec(url.pathname || "/");
		if (match?.[1]) return match[1];
		return (
			url.searchParams.get("share") ||
			url.searchParams.get("shareToken") ||
			url.searchParams.get("token")
		);
	} catch {
		return null;
	}
}

export function deriveComposerModelTokens(
	model: Partial<{
		contextWindow?: number;
		maxOutputTokens?: number;
		maxTokens?: number;
	}> | null,
): string | null {
	if (!model) return null;
	if (model.contextWindow)
		return `${Math.round(model.contextWindow / 1000)}k ctx`;
	if (model.maxOutputTokens)
		return `${Math.round(model.maxOutputTokens / 1000)}k max out`;
	if (model.maxTokens) return `${Math.round(model.maxTokens / 1000)}k tokens`;
	return null;
}

export function coerceMessageContent(content: Message["content"]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block?.type === "text")
		.map((block) => (block?.type === "text" ? block.text : ""))
		.join("");
}

export function normalizeComposerMessage(message: Message): Message {
	if (typeof message.content === "string") return message;
	return {
		...message,
		content: coerceMessageContent(message.content),
	};
}

export function normalizeComposerMessages(messages: Message[]): UiMessage[] {
	return messages.map((message) => normalizeComposerMessage(message));
}
