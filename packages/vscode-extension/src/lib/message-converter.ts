import type * as Contracts from "@evalops/contracts";
import type { Message } from "./api-client.js";

interface ContentPart {
	type: string;
	text?: string;
	thinking?: string;
	name?: string;
	arguments?: Record<string, unknown>;
	id?: string;
}

export interface RawMessage {
	role: string;
	content: string | ContentPart[];
	timestamp?: number | string;
	toolName?: string;
	isError?: boolean;
	usage?: Contracts.ComposerUsage;
}

export function convertToComposerMessage(msg: RawMessage): Message {
	const contentParts: string[] = [];
	const tools: Contracts.ComposerToolCall[] = [];
	let thinking: string | undefined;

	if (typeof msg.content === "string") {
		contentParts.push(msg.content);
	} else if (Array.isArray(msg.content)) {
		for (const part of msg.content) {
			if (part.type === "text" && part.text) {
				contentParts.push(part.text);
			} else if (part.type === "toolCall") {
				tools.push({
					name: part.name ?? "",
					status: "completed",
					args: part.arguments,
					toolCallId: part.id,
				});
			} else if (part.type === "thinking" && part.thinking) {
				thinking = part.thinking;
			}
		}
	}

	let role = msg.role;
	if (role === "toolResult") {
		role = "tool";
	}

	return {
		role: role as Message["role"],
		content: contentParts.join("\n"),
		thinking,
		tools: tools.length ? tools : undefined,
		timestamp:
			msg.timestamp !== undefined && msg.timestamp !== null
				? new Date(msg.timestamp).toISOString()
				: new Date().toISOString(),
		toolName: msg.toolName,
		isError: msg.isError,
		usage: msg.usage,
	};
}
