/**
 * Render Model - Transforms raw messages into UI-ready format with content deduplication
 *
 * This module provides the transformation layer between raw agent messages and the
 * renderable structures consumed by the TUI. Its primary responsibilities:
 *
 * 1. **Message Normalization**: Extracts text, thinking blocks, tool calls, and
 *    attachments into consistent, typed structures.
 *
 * 2. **Content Deduplication**: Removes repeated lines that occur during streaming,
 *    particularly when LLM providers resend cumulative content on each delta.
 *
 * 3. **Clean Mode Support**: Three levels of content cleaning (off/soft/aggressive)
 *    to balance rendering accuracy vs visual cleanliness.
 *
 * ## The Duplicate Line Problem
 *
 * When streaming responses, some LLM providers (especially for reasoning/thinking
 * blocks) resend all previous content with each update rather than just the delta.
 * This manifests as:
 * - Numbered list items appearing multiple times
 * - Paragraph beginnings repeated
 * - Code blocks with duplicated lines
 *
 * ## Deduplication Strategy
 *
 * We maintain a sliding window of recently-seen lines. Each new line is checked
 * against this window; if found, it's collapsed. The window size varies by mode:
 * - **Soft mode**: Small window (40 lines) catches local repetition
 * - **Aggressive mode**: Large window (120 lines) catches re-sent blocks
 *
 * Cross-block mode shares history between text blocks in the same message,
 * catching duplicates that span the streaming chunk boundaries.
 *
 * @module conversation/render-model
 */

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

/**
 * Content cleaning modes for handling streaming artifacts
 *
 * - `off`: No cleaning, render exactly as received (for debugging)
 * - `soft`: Light deduplication for adjacent duplicate lines
 * - `aggressive`: Heavy deduplication with large sliding window and cross-block history
 */
export type CleanMode = "off" | "soft" | "aggressive";

export interface RenderOptions {
	cleanMode?: CleanMode;
}

/**
 * Collapse Duplicate Lines - Removes streaming-induced repetition
 *
 * Primary entry point for line deduplication. Creates a fresh history array
 * for single-block use, or delegates to the history-sharing variant for
 * cross-block deduplication.
 *
 * @param text - The text content to deduplicate
 * @param options - Configuration for deduplication behavior
 * @param options.windowSize - How many recent lines to remember (default: 1)
 * @param options.crossBlock - If true, initializes shared history for cross-block mode
 * @returns Object with deduplicated text and whether any changes were made
 */
export function collapseRepeatedLines(
	text: string,
	options: { windowSize?: number; crossBlock?: boolean } = {},
): { text: string; changed: boolean } {
	return collapseRepeatedLinesWithHistory(text, {
		...options,
		sharedHistory: options.crossBlock ? [] : undefined,
	});
}

/**
 * History-Aware Line Deduplication - Core algorithm with shared state
 *
 * This is the workhorse function that actually performs deduplication. It maintains
 * a sliding window of recently-seen lines and filters out repetitions.
 *
 * ## Algorithm
 *
 * For each line in the input:
 * 1. Normalize by trimming trailing whitespace (leading preserved for code)
 * 2. Collapse consecutive blank lines to single blank
 * 3. Check if line exists in recent history window
 * 4. If duplicate: skip it (and any trailing blank before it)
 * 5. If unique: add to output and update history window
 *
 * ## Window Semantics
 *
 * The `windowSize` parameter controls how far back we look for duplicates:
 * - windowSize=1: Only catches immediately consecutive duplicates
 * - windowSize=40: Catches duplicates within ~40 lines (soft mode)
 * - windowSize=120: Catches duplicates from large re-sent blocks (aggressive)
 *
 * The window is FIFO: oldest lines drop off as new ones are added.
 *
 * ## Cross-Block Mode
 *
 * When `sharedHistory` is provided, the history array persists across multiple
 * calls. This is essential for streaming where content arrives in chunks:
 *
 *   Chunk 1: "1. First item\n2. Second item"
 *   Chunk 2: "2. Second item\n3. Third item"  <- "2. Second item" is duplicate
 *
 * Without cross-block mode, chunk 2's duplicate wouldn't be detected since
 * each call would start with empty history.
 *
 * ## Blank Line Handling
 *
 * Blank lines receive special treatment:
 * - Multiple consecutive blanks collapse to one (visual spacing)
 * - Trailing blanks before duplicates are also removed (prevents orphan whitespace)
 * - Empty lines don't enter the history window (they're never "duplicate content")
 *
 * @param text - The text content to deduplicate
 * @param options.windowSize - Size of the sliding history window (default: 1)
 * @param options.crossBlock - Whether we're in cross-block mode (affects duplicate check)
 * @param options.sharedHistory - External history array for cross-block persistence
 * @returns Object with deduplicated text and whether any changes were made
 */
export function collapseRepeatedLinesWithHistory(
	text: string,
	options: {
		windowSize?: number;
		crossBlock?: boolean;
		sharedHistory?: string[];
	} = {},
): { text: string; changed: boolean } {
	// Split on both Unix and Windows line endings
	const lines = text.split(/\r?\n/);
	const result: string[] = [];
	const windowSize = options.windowSize ?? 1;
	// Use shared history if provided (cross-block mode), otherwise local array
	const recent: string[] = options.sharedHistory ?? [];
	let changed = false;

	for (const line of lines) {
		// Normalize: trim trailing whitespace but preserve leading (for code indentation)
		const normalized = line.trimEnd();
		const isEmpty = normalized.length === 0;

		// Rule 1: Collapse runs of blank lines to a single blank
		// This prevents visual gaps from accumulating during streaming
		if (
			isEmpty &&
			result.length > 0 &&
			result[result.length - 1].length === 0
		) {
			changed = true;
			continue;
		}

		// Rule 2: Check for duplicate content lines
		// In cross-block mode: search entire history window
		// In local mode: only check the immediately previous line
		const isDuplicate =
			!isEmpty &&
			(options.crossBlock
				? recent.includes(normalized)
				: recent.length > 0 && recent[recent.length - 1] === normalized);

		if (isDuplicate) {
			// Clean up trailing blank that precedes the duplicate
			// This prevents orphaned whitespace when duplicates are removed
			if (result.length > 0 && result[result.length - 1].length === 0) {
				result.pop();
			}
			changed = true;
			continue;
		}

		// Line is unique - add to output
		result.push(line);

		// Update sliding window history (only for non-empty lines)
		if (!isEmpty) {
			recent.push(normalized);
			// Maintain window size by dropping oldest entry
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
	// Share recent-line history across blocks so duplicated numbered items that
	// arrive as separate chunks during streaming get collapsed.
	const recentLines: string[] = [];

	const cleanText = (value: string): { text: string; changed: boolean } => {
		if (cleanMode === "off") {
			return { text: value, changed: false };
		}
		// Keep a larger recent-line window so we can collapse content when
		// providers resend cumulative chunks (e.g., entire bullet lists on each
		// delta). Soft mode gets a generous window; aggressive mode gets an
		// even larger one, but both are bounded to avoid unbounded growth.
		const windowSize = cleanMode === "aggressive" ? 120 : 40;
		return collapseRepeatedLinesWithHistory(value, {
			windowSize,
			crossBlock: true,
			sharedHistory: recentLines,
		});
	};

	for (const content of message.content) {
		if (content.type === "text" && content.text.trim()) {
			const { text, changed } = cleanText(content.text.trim());
			textBlocks.push(text);
			cleaned = cleaned || changed;
		} else if (content.type === "thinking" && content.thinking.trim()) {
			const { text, changed } = cleanText(content.thinking.trim());
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
