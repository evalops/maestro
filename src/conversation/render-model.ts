import type {
	AppMessage,
	AssistantMessage,
	Attachment,
	StopReason,
	ToolResultMessage,
	UserMessageWithAttachments,
} from "../agent/types.js";

export type RenderableMessage =
	| RenderableUserMessage
	| RenderableAssistantMessage
	| RenderableToolResultMessage;

export type CleanMode = "off" | "soft" | "aggressive";

export interface RenderOptions {
	cleanMode?: CleanMode;
}

/**
 * Collapse duplicate lines with configurable window.
 * - soft: consecutive only (default windowSize 1)
 * - aggressive: dedupe within a small recent window and across blocks
 */
export function collapseRepeatedLines(
	text: string,
	options: { windowSize?: number; crossBlock?: boolean } = {},
): { text: string; changed: boolean } {
	const lines = text.split(/\r?\n/);
	const result: string[] = [];
	const windowSize = options.windowSize ?? 1;
	const recent: string[] = [];
	let changed = false;

	for (const line of lines) {
		const normalized = line.trimEnd();
		const isEmpty = normalized.length === 0;
		// Collapse runs of blank lines to a single blank.
		if (
			isEmpty &&
			result.length > 0 &&
			result[result.length - 1].length === 0
		) {
			changed = true;
			continue;
		}
		const isDuplicate =
			!isEmpty &&
			(options.crossBlock
				? recent.includes(normalized)
				: recent.length > 0 && recent[recent.length - 1] === normalized);

		if (isDuplicate) {
			// Also remove a trailing blank we may have kept right before the duplicate.
			if (result.length > 0 && result[result.length - 1].length === 0) {
				result.pop();
			}
			changed = true;
			continue;
		}

		result.push(line);
		if (!isEmpty) {
			recent.push(normalized);
			if (recent.length > windowSize) {
				recent.shift();
			}
		}
	}

	return { text: result.join("\n"), changed };
}

export interface RenderableUserMessage {
	kind: "user";
	text: string;
	attachments: RenderableAttachment[];
	raw: UserMessageWithAttachments;
}

export interface RenderableAssistantMessage {
	kind: "assistant";
	textBlocks: string[];
	thinkingBlocks: string[];
	toolCalls: RenderableToolCall[];
	stopReason: StopReason;
	errorMessage?: string;
	cleaned: boolean;
	raw: AssistantMessage;
}

export interface RenderableToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export interface RenderableToolResultMessage {
	kind: "toolResult";
	toolCallId: string;
	toolName: string;
	textContent: string;
	images: RenderableImageContent[];
	isError: boolean;
	details?: unknown;
	raw: ToolResultMessage;
}

export interface RenderableAttachment {
	id: string;
	type: Attachment["type"];
	fileName: string;
	mimeType: string;
	size: number;
	preview?: string;
}

export interface RenderableImageContent {
	mimeType: string;
	data: string;
}

export function toRenderableUserMessage(
	message: UserMessageWithAttachments,
): RenderableUserMessage {
	return {
		kind: "user",
		text: extractTextFromUserContent(message),
		attachments:
			message.attachments?.map((attachment) => ({
				id: attachment.id,
				type: attachment.type,
				fileName: attachment.fileName,
				mimeType: attachment.mimeType,
				size: attachment.size,
				preview: attachment.preview,
			})) ?? [],
		raw: message,
	};
}

export function toRenderableAssistantMessage(
	message: AssistantMessage,
	options: RenderOptions = {},
): RenderableAssistantMessage {
	const textBlocks: string[] = [];
	const thinkingBlocks: string[] = [];
	const toolCalls: RenderableToolCall[] = [];
	const cleanMode = options.cleanMode ?? "off";
	let cleaned = false;

	for (const content of message.content) {
		if (content.type === "text" && content.text.trim()) {
			const { text, changed } = maybeCleanText(content.text.trim(), cleanMode);
			textBlocks.push(text);
			cleaned = cleaned || changed;
		} else if (content.type === "thinking" && content.thinking.trim()) {
			const { text, changed } = maybeCleanText(
				content.thinking.trim(),
				cleanMode,
			);
			thinkingBlocks.push(text);
			cleaned = cleaned || changed;
		} else if (content.type === "toolCall") {
			toolCalls.push({
				id: content.id,
				name: content.name,
				arguments: content.arguments,
			});
		}
	}

	return {
		kind: "assistant",
		textBlocks,
		thinkingBlocks,
		toolCalls,
		stopReason: message.stopReason,
		errorMessage: message.errorMessage,
		cleaned,
		raw: message,
	};
}

function maybeCleanText(
	text: string,
	mode: CleanMode,
): { text: string; changed: boolean } {
	if (mode === "off") {
		return { text, changed: false };
	}
	if (mode === "soft") {
		return collapseRepeatedLines(text);
	}
	// aggressive: dedupe within a sliding window across blocks
	return collapseRepeatedLines(text, { windowSize: 8, crossBlock: true });
}

export function toRenderableToolResultMessage(
	message: ToolResultMessage,
): RenderableToolResultMessage {
	const textContent = extractTextFromToolResult(message);
	const images = message.content
		.filter((content) => content.type === "image")
		.map((content) => ({
			mimeType: content.mimeType,
			data: content.data,
		}));

	return {
		kind: "toolResult",
		toolCallId: message.toolCallId,
		toolName: message.toolName,
		textContent,
		images,
		isError: message.isError,
		details: message.details,
		raw: message,
	};
}

export function createRenderableMessage(
	message: AppMessage,
	options: RenderOptions = {},
): RenderableMessage | null {
	if (message.role === "user") {
		return toRenderableUserMessage(message as UserMessageWithAttachments);
	}
	if (message.role === "assistant") {
		return toRenderableAssistantMessage(message, options);
	}
	if (message.role === "toolResult") {
		return toRenderableToolResultMessage(message);
	}
	return null;
}

export function buildConversationModel(
	messages: AppMessage[],
	options: RenderOptions = {},
): RenderableMessage[] {
	const renderables: RenderableMessage[] = [];
	for (const message of messages) {
		const renderable = createRenderableMessage(message, options);
		if (renderable) {
			renderables.push(renderable);
		}
	}
	return renderables;
}

export function isRenderableUserMessage(
	message: RenderableMessage,
): message is RenderableUserMessage {
	return message.kind === "user";
}

export function isRenderableAssistantMessage(
	message: RenderableMessage,
): message is RenderableAssistantMessage {
	return message.kind === "assistant";
}

export function isRenderableToolResultMessage(
	message: RenderableMessage,
): message is RenderableToolResultMessage {
	return message.kind === "toolResult";
}

export function renderMessageToPlainText(message: RenderableMessage): string {
	if (isRenderableUserMessage(message)) {
		const attachmentNotes = message.attachments.map(
			(attachment) =>
				`[attachment] ${attachment.fileName} (${attachment.mimeType})`,
		);
		return [message.text, ...attachmentNotes]
			.filter((part) => Boolean(part?.trim()))
			.join("\n")
			.trim();
	}
	if (isRenderableAssistantMessage(message)) {
		const lines: string[] = [];
		lines.push(...message.textBlocks);
		lines.push(
			...message.thinkingBlocks.map((thinking) => `[thinking] ${thinking}`),
		);
		lines.push(...message.toolCalls.map((call) => `[tool call] ${call.name}`));
		return lines.filter((part) => Boolean(part?.trim())).join("\n");
	}
	if (isRenderableToolResultMessage(message)) {
		const imageLines = message.images.map(
			(image) => `[image] ${image.mimeType || "attachment"}`,
		);
		return [message.textContent, ...imageLines]
			.filter((part) => Boolean(part?.trim()))
			.join("\n")
			.trim();
	}
	return "";
}

function extractTextFromUserContent(
	message: UserMessageWithAttachments,
): string {
	if (typeof message.content === "string") {
		return message.content;
	}
	if (Array.isArray(message.content)) {
		return message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("");
	}
	return "";
}

function extractTextFromToolResult(message: ToolResultMessage): string {
	return message.content
		.filter((content) => content.type === "text")
		.map((content) => content.text)
		.join("\n")
		.trim();
}
