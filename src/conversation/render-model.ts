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
	raw: AssistantMessage;
}

export interface RenderableToolCall {
	id: string;
	name: string;
	arguments: Record<string, any>;
}

export interface RenderableToolResultMessage {
	kind: "toolResult";
	toolCallId: string;
	toolName: string;
	textContent: string;
	images: RenderableImageContent[];
	isError: boolean;
	details?: any;
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
): RenderableAssistantMessage {
	const textBlocks: string[] = [];
	const thinkingBlocks: string[] = [];
	const toolCalls: RenderableToolCall[] = [];

	for (const content of message.content) {
		if (content.type === "text" && content.text.trim()) {
			textBlocks.push(content.text.trim());
		} else if (content.type === "thinking" && content.thinking.trim()) {
			thinkingBlocks.push(content.thinking.trim());
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
		raw: message,
	};
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
): RenderableMessage | null {
	if (message.role === "user") {
		return toRenderableUserMessage(message as UserMessageWithAttachments);
	}
	if (message.role === "assistant") {
		return toRenderableAssistantMessage(message);
	}
	if (message.role === "toolResult") {
		return toRenderableToolResultMessage(message);
	}
	return null;
}

export function buildConversationModel(
	messages: AppMessage[],
): RenderableMessage[] {
	const renderables: RenderableMessage[] = [];
	for (const message of messages) {
		const renderable = createRenderableMessage(message);
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
