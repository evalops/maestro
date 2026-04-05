/**
 * Context Compaction - Pure Functions for Long Session Management
 *
 * This module provides pure functions for context compaction logic. Context
 * compaction summarizes older conversation history when approaching token limits,
 * allowing conversations to continue indefinitely while preserving important context.
 *
 * ## Architecture
 *
 * The compaction system follows a separation of concerns:
 * - **This module**: Pure functions for token calculation, cut point detection, and
 *   determining when compaction should trigger. No I/O or side effects.
 * - **SessionManager**: Handles persistence of compaction entries to session files.
 * - **ConversationCompactor**: Orchestrates the compaction process with TUI integration.
 *
 * ## Token-Based Cut Point Detection
 *
 * Instead of using a fixed message count, cut point detection uses actual token usage
 * from assistant messages. The algorithm walks backwards from the newest message,
 * calculating cumulative token differences until `keepRecentTokens` is exceeded.
 *
 * This approach:
 * - Preserves more context when messages are small
 * - Compacts more aggressively when messages are large
 * - Respects turn boundaries (never splits user/assistant/toolResult groups)
 *
 * ## Summarization Strategy
 *
 * When compacting, older messages are summarized using the LLM with a handoff-style
 * prompt. If a previous compaction exists, its summary is included as context for
 * the new summarization (cascading summaries).
 *
 * @module agent/compaction
 */

import { realpathSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
	resolveLoadedAppendSystemPromptPath,
	resolvePromptLoadedProjectDocPaths,
} from "../config/index.js";
import type { SessionEntry } from "../session/types.js";
import { readTool } from "../tools/read.js";
import { createLogger } from "../utils/logger.js";
import { expandUserPath } from "../utils/path-validation.js";
import { runPostCompactionCleanup } from "./compaction-cleanup.js";
import {
	type CompactionHookContext,
	type CompactionHookService,
	createCompactionHookService,
} from "./compaction-hooks.js";
import {
	PLAN_FILE_COMPACTION_CUSTOM_TYPE,
	PLAN_MODE_COMPACTION_CUSTOM_TYPE,
} from "./compaction-restoration.js";
import {
	isContextOverflow as isCompactionOverflowMessage,
	isOverflowErrorMessage,
	parseOverflowDetails,
} from "./context-overflow.js";
import {
	convertAppMessageToLlm,
	createHookMessage,
} from "./custom-messages.js";
import { getPlanFilePathForCompactionRestore } from "./plan-mode.js";
import type {
	Api,
	AppMessage,
	AssistantMessage,
	HookMessage,
	ImageContent,
	TextContent,
	ToolResultMessage,
	Usage,
	UserMessage,
	UserMessageWithAttachments,
} from "./types.js";

const logger = createLogger("agent:compaction");

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for compaction behavior.
 */
export interface CompactionSettings {
	/** Whether auto-compaction is enabled */
	enabled: boolean;
	/**
	 * Tokens to reserve for summary generation and safety margin.
	 * Default: 16384 (~13k for summary + ~3k safety margin)
	 */
	reserveTokens: number;
	/**
	 * Approximate number of recent tokens to preserve verbatim.
	 * Default: 20000 (recent context preserved without summarization)
	 */
	keepRecentTokens: number;
}

/**
 * Default compaction settings based on research into Claude Code, Codex, and OpenCode.
 */
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

/**
 * Internal user prompt appended after compaction so the model resumes from the
 * summarized context on the next turn.
 */
export const COMPACTION_RESUME_PROMPT =
	"Use the above summary to resume the plan from where we left off.";

const MAX_COMPACTION_OVERFLOW_RETRIES = 3;
const PREVIOUS_SUMMARY_PREFIX = "Previous session summary:\n";
const COMPACTION_OVERFLOW_RETRY_MARKER =
	"[earlier conversation truncated for compaction retry]";
const READ_RESTORE_COMPACTION_CUSTOM_TYPE = "read-file";
const MAX_READ_RESTORE_MESSAGES = 5;
const READ_RESTORE_TOKEN_BUDGET = 50_000;
const READ_RESTORE_MAX_TOKENS_PER_FILE = 5_000;
const READ_RESTORE_TRUNCATION_MARKER =
	"\n\n[... restored read result truncated for compaction; use `read` on the path again if you need the full contents]";
const SKILL_RESTORE_TOKEN_BUDGET = 25_000;
const SKILL_RESTORE_MAX_TOKENS_PER_SKILL = 5_000;
const SKILL_RESTORE_TRUNCATION_MARKER =
	"\n\n[... restored skill truncated for compaction; use the `Skill` tool again if you need the full instructions]";

/**
 * Result of a compaction operation, ready to be persisted.
 */
export interface CompactionResult {
	/** Generated summary of compacted messages */
	summary: string;
	/** Index of first entry to keep (entries before this are summarized) */
	firstKeptEntryIndex: number;
	/** Token count before compaction (for metrics) */
	tokensBefore: number;
	/** Messages that were summarized */
	summarizedMessages: AppMessage[];
	/** Messages to keep verbatim */
	keptMessages: AppMessage[];
}

// ============================================================================
// Token Calculation
// ============================================================================

/**
 * Calculate total context tokens from usage metadata.
 *
 * This includes all token types that contribute to context window consumption:
 * - input: Tokens from user/system messages
 * - output: Tokens generated by the model
 * - cacheRead: Tokens read from prompt cache
 * - cacheWrite: Tokens written to prompt cache
 *
 * @param usage - Usage metadata from an assistant message
 * @returns Total context token count
 */
export function calculateContextTokens(usage: Usage): number {
	return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/**
 * Extract usage metadata from a message if it's a non-aborted assistant message.
 *
 * @param msg - Any application message
 * @returns Usage metadata or null if not available/applicable
 */
function getAssistantUsage(msg: AppMessage): Usage | null {
	if (msg.role === "assistant") {
		const assistantMsg = msg as AssistantMessage;
		if (
			assistantMsg.stopReason !== "aborted" &&
			assistantMsg.stopReason !== "error" &&
			assistantMsg.usage
		) {
			return assistantMsg.usage;
		}
	}
	return null;
}

function shouldSkipAssistantCompactionMessage(message: AppMessage): boolean {
	return (
		message.role === "assistant" &&
		(message.stopReason === "aborted" || message.stopReason === "error")
	);
}

function shouldSkipReinjectedCompactionMessage(message: AppMessage): boolean {
	return (
		message.role === "hookMessage" &&
		((message.customType === "skill" && message.display === false) ||
			message.customType === READ_RESTORE_COMPACTION_CUSTOM_TYPE ||
			message.customType === PLAN_FILE_COMPACTION_CUSTOM_TYPE ||
			message.customType === "PostCompact" ||
			message.customType === "SessionStart" ||
			message.customType === PLAN_MODE_COMPACTION_CUSTOM_TYPE)
	);
}

function normalizeReadPath(path: string): string {
	return resolvePath(expandUserPath(path));
}

function normalizeComparableReadPath(path: string): string {
	const normalizedPath = normalizeReadPath(path);
	try {
		return realpathSync.native(normalizedPath);
	} catch {
		return normalizedPath;
	}
}

function getExcludedReadRestorePaths(
	additionalPaths: string[] = [],
): Set<string> {
	const loadedAppendSystemPromptPath = resolveLoadedAppendSystemPromptPath(
		process.cwd(),
	);
	const trackedPlanFilePath = getPlanFilePathForCompactionRestore();
	return new Set(
		[
			...resolvePromptLoadedProjectDocPaths(process.cwd()),
			...(loadedAppendSystemPromptPath ? [loadedAppendSystemPromptPath] : []),
			...(trackedPlanFilePath ? [trackedPlanFilePath] : []),
			...additionalPaths,
		].map((path) => normalizeComparableReadPath(path)),
	);
}

function shouldExcludeReadRestorePath(
	filePath: string,
	excludedPaths: Set<string>,
): boolean {
	return excludedPaths.has(normalizeComparableReadPath(filePath));
}

type ReadRestoreRequest = {
	path: string;
	offset?: number;
	limit?: number;
	mode?: "normal" | "head" | "tail";
	lineNumbers?: boolean;
	wrapInCodeFence?: boolean;
	language?: string;
	encoding?: "utf-8" | "utf-16le" | "latin1" | "ascii";
};

function parseOptionalInteger(value: unknown, minimum = 1): number | undefined {
	return typeof value === "number" &&
		Number.isInteger(value) &&
		value >= minimum
		? value
		: undefined;
}

function parseReadRestoreRequest(
	arguments_: Record<string, unknown>,
): ReadRestoreRequest | null {
	const rawPath = arguments_.path;
	if (typeof rawPath !== "string") {
		return null;
	}

	const mode =
		arguments_.mode === "normal" ||
		arguments_.mode === "head" ||
		arguments_.mode === "tail"
			? arguments_.mode
			: undefined;
	const lineNumbers =
		typeof arguments_.lineNumbers === "boolean"
			? arguments_.lineNumbers
			: undefined;
	const wrapInCodeFence =
		typeof arguments_.wrapInCodeFence === "boolean"
			? arguments_.wrapInCodeFence
			: undefined;
	const language =
		typeof arguments_.language === "string" ? arguments_.language : undefined;
	const encoding =
		arguments_.encoding === "utf-8" ||
		arguments_.encoding === "utf-16le" ||
		arguments_.encoding === "latin1" ||
		arguments_.encoding === "ascii"
			? arguments_.encoding
			: undefined;

	return {
		path: normalizeReadPath(rawPath),
		offset: parseOptionalInteger(arguments_.offset),
		limit: parseOptionalInteger(arguments_.limit),
		mode,
		lineNumbers,
		wrapInCodeFence,
		language,
		encoding,
	};
}

function collectReadRestoreRequestsByCallId(
	messages: AppMessage[],
): Map<string, ReadRestoreRequest> {
	const requestsByCallId = new Map<string, ReadRestoreRequest>();
	for (const message of messages) {
		if (message.role !== "assistant") {
			continue;
		}
		for (const part of message.content) {
			if (part.type !== "toolCall" || part.name !== "read") {
				continue;
			}
			const request = parseReadRestoreRequest(part.arguments);
			if (!request) {
				continue;
			}
			requestsByCallId.set(part.id, request);
		}
	}
	return requestsByCallId;
}

function collectVisibleReadPaths(messages: AppMessage[]): Set<string> {
	const requestsByCallId = collectReadRestoreRequestsByCallId(messages);
	const visiblePaths = new Set<string>();
	for (const message of messages) {
		if (
			message.role === "hookMessage" &&
			message.customType === READ_RESTORE_COMPACTION_CUSTOM_TYPE
		) {
			const details = message.details;
			if (
				typeof details === "object" &&
				details !== null &&
				"filePath" in details &&
				typeof details.filePath === "string"
			) {
				visiblePaths.add(normalizeReadPath(details.filePath));
			}
			continue;
		}

		if (
			message.role !== "toolResult" ||
			message.toolName !== "read" ||
			message.isError
		) {
			continue;
		}
		const request = requestsByCallId.get(message.toolCallId);
		if (request) {
			visiblePaths.add(request.path);
		}
	}
	return visiblePaths;
}

function extractSkillRestoreName(
	content: string | (TextContent | ImageContent)[],
): string | null {
	const text =
		typeof content === "string"
			? content
			: content
					.filter((block): block is TextContent => block.type === "text")
					.map((block) => block.text)
					.join("\n");
	const match = text.match(/^# Skill:\s+(.+)$/m);
	return match?.[1]?.trim() || null;
}

function collectVisibleSkillNames(messages: AppMessage[]): Set<string> {
	const visibleSkillNames = new Set<string>();
	for (const message of messages) {
		if (
			message.role === "toolResult" &&
			message.toolName === "Skill" &&
			!message.isError
		) {
			const skillName = extractSkillRestoreName(message.content);
			if (skillName) {
				visibleSkillNames.add(skillName);
			}
			continue;
		}

		if (message.role !== "hookMessage" || message.customType !== "skill") {
			continue;
		}

		const details = message.details;
		if (
			typeof details === "object" &&
			details !== null &&
			"name" in details &&
			typeof details.name === "string"
		) {
			visibleSkillNames.add(details.name);
			continue;
		}

		if (Array.isArray(message.content)) {
			const skillName = extractSkillRestoreName(message.content);
			if (skillName) {
				visibleSkillNames.add(skillName);
			}
		}
	}
	return visibleSkillNames;
}

async function refreshReadRestoreContent(
	request: ReadRestoreRequest,
	toolCallId: string,
): Promise<(TextContent | ImageContent)[] | null> {
	const result = await readTool.execute(toolCallId, {
		path: request.path,
		offset: request.offset,
		limit: request.limit,
		mode: request.mode,
		lineNumbers: request.lineNumbers,
		wrapInCodeFence: request.wrapInCodeFence,
		language: request.language,
		encoding: request.encoding,
		withDiagnostics: false,
	});
	if (result.isError) {
		return null;
	}
	return result.content.filter(
		(
			block,
		): block is
			| { type: "text"; text: string }
			| { type: "image"; data: string; mimeType: string } =>
			block.type === "text" || block.type === "image",
	);
}

function buildReadRestoreContent(
	filePath: string,
	content: (TextContent | ImageContent)[],
): (TextContent | ImageContent)[] {
	const header: TextContent = {
		type: "text",
		text: [
			"# Recently read file restored after compaction",
			"",
			`File: ${filePath}`,
			"",
			"Last read result:",
		].join("\n"),
	};
	const remainingTokens = Math.max(
		0,
		READ_RESTORE_MAX_TOKENS_PER_FILE - estimateHookContentTokens([header]),
	);

	return [header, ...truncateReadRestoreBlocks(content, remainingTokens)];
}

function hasReadRestoreMessage(
	messages: AppMessage[],
	filePath: string,
	content: (TextContent | ImageContent)[],
): boolean {
	const expectedContent = JSON.stringify(content);
	return messages.some((message) => {
		if (
			message.role !== "hookMessage" ||
			message.customType !== READ_RESTORE_COMPACTION_CUSTOM_TYPE
		) {
			return false;
		}

		const details = message.details;
		if (
			typeof details === "object" &&
			details !== null &&
			"filePath" in details &&
			typeof details.filePath === "string" &&
			details.filePath !== filePath
		) {
			return false;
		}

		return JSON.stringify(message.content) === expectedContent;
	});
}

function estimateHookContentTokens(
	content: string | (TextContent | ImageContent)[],
): number {
	return Math.max(1, Math.ceil(JSON.stringify(content).length / 4));
}

function buildReadRestoreTruncationBlock(text: string): TextContent | null {
	return estimateHookContentTokens([{ type: "text", text }]) > 0
		? { type: "text", text }
		: null;
}

function truncateReadRestoreBlocks(
	content: (TextContent | ImageContent)[],
	maxTokens: number,
): (TextContent | ImageContent)[] {
	const restored: (TextContent | ImageContent)[] = [];
	let usedTokens = 0;

	for (const block of content) {
		const blockTokens = estimateHookContentTokens([block]);
		if (usedTokens + blockTokens <= maxTokens) {
			restored.push(block);
			usedTokens += blockTokens;
			continue;
		}

		const remainingTokens = maxTokens - usedTokens;
		if (remainingTokens <= 0) {
			break;
		}

		if (block.type === "text") {
			const charBudget = Math.max(
				0,
				remainingTokens * 4 - READ_RESTORE_TRUNCATION_MARKER.length,
			);
			const truncatedText =
				charBudget > 0
					? `${block.text.slice(0, charBudget)}${READ_RESTORE_TRUNCATION_MARKER}`
					: READ_RESTORE_TRUNCATION_MARKER;
			const truncationBlock = buildReadRestoreTruncationBlock(truncatedText);
			if (truncationBlock) {
				restored.push(truncationBlock);
			}
			break;
		}

		const imageMarker = buildReadRestoreTruncationBlock(
			"[image omitted from restored read result due to compaction budget; use `read` on the path again if needed]",
		);
		if (imageMarker) {
			restored.push(imageMarker);
		}
		break;
	}

	return restored;
}

function truncateSkillRestoreBlocks(
	content: (TextContent | ImageContent)[],
	maxTokens: number,
): (TextContent | ImageContent)[] {
	const restored: (TextContent | ImageContent)[] = [];
	let usedTokens = 0;

	for (const block of content) {
		const blockTokens = estimateHookContentTokens([block]);
		if (usedTokens + blockTokens <= maxTokens) {
			restored.push(block);
			usedTokens += blockTokens;
			continue;
		}

		const remainingTokens = maxTokens - usedTokens;
		if (remainingTokens <= 0) {
			break;
		}

		if (block.type === "text") {
			const charBudget = Math.max(
				0,
				remainingTokens * 4 - SKILL_RESTORE_TRUNCATION_MARKER.length,
			);
			const truncatedText =
				charBudget > 0
					? `${block.text.slice(0, charBudget)}${SKILL_RESTORE_TRUNCATION_MARKER}`
					: SKILL_RESTORE_TRUNCATION_MARKER;
			const truncationBlock = buildReadRestoreTruncationBlock(truncatedText);
			if (truncationBlock) {
				restored.push(truncationBlock);
			}
			break;
		}

		const imageMarker = buildReadRestoreTruncationBlock(
			"[image omitted from restored skill due to compaction budget; use the `Skill` tool again if needed]",
		);
		if (imageMarker) {
			restored.push(imageMarker);
		}
		break;
	}

	return restored;
}

async function collectRecentReadRestoreMessages(
	compactedMessages: AppMessage[],
	preservedMessages: AppMessage[],
	additionalExcludedPaths: string[] = [],
): Promise<AppMessage[]> {
	const visiblePaths = collectVisibleReadPaths(preservedMessages);
	const requestsByCallId =
		collectReadRestoreRequestsByCallId(compactedMessages);
	const excludedPaths = getExcludedReadRestorePaths(additionalExcludedPaths);
	const restoredMessages: AppMessage[] = [];
	const seenPaths = new Set<string>();
	let usedTokens = 0;

	for (let i = compactedMessages.length - 1; i >= 0; i -= 1) {
		if (restoredMessages.length >= MAX_READ_RESTORE_MESSAGES) {
			break;
		}

		const message = compactedMessages[i];
		if (!message) {
			continue;
		}

		let filePath: string | null = null;
		let content: (TextContent | ImageContent)[] | null = null;

		if (
			message.role === "toolResult" &&
			message.toolName === "read" &&
			!message.isError
		) {
			const request = requestsByCallId.get(message.toolCallId);
			filePath = request?.path ?? null;
			const refreshedContent = request
				? await refreshReadRestoreContent(
						request,
						`compaction-read-restore-${message.toolCallId}`,
					)
				: null;
			content = buildReadRestoreContent(
				filePath ?? "",
				refreshedContent ?? message.content,
			);
		} else if (
			message.role === "hookMessage" &&
			message.customType === READ_RESTORE_COMPACTION_CUSTOM_TYPE &&
			Array.isArray(message.content)
		) {
			const details = message.details;
			filePath =
				typeof details === "object" &&
				details !== null &&
				"filePath" in details &&
				typeof details.filePath === "string"
					? normalizeReadPath(details.filePath)
					: null;
			content = message.content;
		}

		if (
			!filePath ||
			!content ||
			visiblePaths.has(filePath) ||
			seenPaths.has(filePath) ||
			shouldExcludeReadRestorePath(filePath, excludedPaths)
		) {
			continue;
		}
		const dedupeMessages =
			message.role === "hookMessage"
				? [
						...compactedMessages.slice(0, i),
						...compactedMessages.slice(i + 1),
						...preservedMessages,
						...restoredMessages,
					]
				: [...compactedMessages, ...preservedMessages, ...restoredMessages];
		if (hasReadRestoreMessage(dedupeMessages, filePath, content)) {
			seenPaths.add(filePath);
			continue;
		}

		const estimatedTokens = estimateHookContentTokens(content);
		if (usedTokens + estimatedTokens > READ_RESTORE_TOKEN_BUDGET) {
			continue;
		}

		usedTokens += estimatedTokens;
		seenPaths.add(filePath);
		restoredMessages.push(
			createHookMessage(
				READ_RESTORE_COMPACTION_CUSTOM_TYPE,
				content,
				false,
				{ filePath },
				new Date().toISOString(),
			),
		);
	}

	return restoredMessages;
}

async function collectRecentSkillRestoreMessages(
	compactedMessages: AppMessage[],
	preservedMessages: AppMessage[],
): Promise<AppMessage[]> {
	const visibleSkillNames = collectVisibleSkillNames(preservedMessages);
	const restoredMessages: AppMessage[] = [];
	const seenSkillNames = new Set<string>();
	let usedTokens = 0;

	for (let i = compactedMessages.length - 1; i >= 0; i -= 1) {
		const message = compactedMessages[i];
		if (!message) {
			continue;
		}

		let skillName: string | null = null;
		let content: (TextContent | ImageContent)[] | null = null;

		if (
			message.role === "toolResult" &&
			message.toolName === "Skill" &&
			!message.isError
		) {
			skillName = extractSkillRestoreName(message.content);
			content = truncateSkillRestoreBlocks(
				message.content,
				SKILL_RESTORE_MAX_TOKENS_PER_SKILL,
			);
		} else if (
			message.role === "hookMessage" &&
			message.customType === "skill" &&
			message.display === false &&
			Array.isArray(message.content)
		) {
			const details = message.details;
			const sourcedFromTool =
				typeof details === "object" &&
				details !== null &&
				"source" in details &&
				details.source === "tool";
			if (!sourcedFromTool) {
				continue;
			}
			skillName =
				typeof details === "object" &&
				details !== null &&
				"name" in details &&
				typeof details.name === "string"
					? details.name
					: extractSkillRestoreName(message.content);
			content = message.content;
		}

		if (
			!skillName ||
			!content ||
			visibleSkillNames.has(skillName) ||
			seenSkillNames.has(skillName)
		) {
			continue;
		}

		const estimatedTokens = estimateHookContentTokens(content);
		if (usedTokens + estimatedTokens > SKILL_RESTORE_TOKEN_BUDGET) {
			continue;
		}

		usedTokens += estimatedTokens;
		seenSkillNames.add(skillName);
		restoredMessages.push(
			createHookMessage(
				"skill",
				content,
				false,
				{ name: skillName, source: "tool" },
				new Date().toISOString(),
			),
		);
	}

	return restoredMessages;
}

function buildAttachmentMarkers(message: UserMessageWithAttachments): string[] {
	if (!Array.isArray(message.attachments) || message.attachments.length === 0) {
		return [];
	}
	return message.attachments.map((attachment) =>
		attachment.type === "document" ? "[document]" : "[image]",
	);
}

function replaceImageBlocksWithMarkers(
	content: (TextContent | ImageContent)[],
): (TextContent | ImageContent)[] {
	return content.map((block) =>
		block.type === "image" ? { type: "text", text: "[image]" } : block,
	);
}

function stripInlineImagesForCompactionSummary<
	T extends
		| UserMessage
		| UserMessageWithAttachments
		| HookMessage
		| ToolResultMessage,
>(message: T): T {
	if (!Array.isArray(message.content)) {
		return message;
	}

	let hasImage = false;
	for (const block of message.content) {
		if (block.type === "image") {
			hasImage = true;
			break;
		}
	}
	if (!hasImage) {
		return message;
	}

	return {
		...message,
		content: replaceImageBlocksWithMarkers(message.content),
	} as T;
}

function stripAttachmentsForCompactionSummary(
	message: UserMessageWithAttachments,
): AppMessage {
	const attachmentMarkers = buildAttachmentMarkers(message);
	if (attachmentMarkers.length === 0) {
		return message;
	}

	const { attachments: _attachments, ...rest } = message;
	const markerText = attachmentMarkers.join("\n");
	if (typeof rest.content === "string") {
		return {
			...rest,
			content: `${rest.content}\n\n${markerText}`,
		};
	}

	return {
		...rest,
		content: [
			...rest.content,
			{
				type: "text" as const,
				text: markerText,
			},
		],
	};
}

function prepareMessagesForCompactionSummary(
	messages: AppMessage[],
	readPathsRestoredAfterCompaction: ReadonlySet<string> = new Set(),
): AppMessage[] {
	const readRequestsByCallId =
		readPathsRestoredAfterCompaction.size > 0
			? collectReadRestoreRequestsByCallId(messages)
			: new Map<string, ReadRestoreRequest>();
	return messages.flatMap((message) => {
		if (
			message.role === "toolResult" &&
			message.toolName === "read" &&
			!message.isError
		) {
			const request = readRequestsByCallId.get(message.toolCallId);
			if (request && readPathsRestoredAfterCompaction.has(request.path)) {
				return [];
			}
		}
		if (
			message.role === "toolResult" &&
			message.toolName === "Skill" &&
			!message.isError
		) {
			return [];
		}
		if (
			shouldSkipAssistantCompactionMessage(message) ||
			shouldSkipReinjectedCompactionMessage(message)
		) {
			return [];
		}
		if (message.role === "user") {
			const sanitizedMessage = stripInlineImagesForCompactionSummary(message);
			if ("attachments" in sanitizedMessage) {
				return [stripAttachmentsForCompactionSummary(sanitizedMessage)];
			}
			return [sanitizedMessage];
		}
		if (message.role === "toolResult" || message.role === "hookMessage") {
			return [stripInlineImagesForCompactionSummary(message)];
		}
		return [message];
	});
}

function isPreviousSummaryPreamble(message: AppMessage | undefined): boolean {
	return (
		message?.role === "user" &&
		typeof message.content === "string" &&
		message.content.startsWith(PREVIOUS_SUMMARY_PREFIX)
	);
}

function isOverflowRetryMarker(message: AppMessage | undefined): boolean {
	return (
		message?.role === "user" &&
		typeof message.content === "string" &&
		message.content === COMPACTION_OVERFLOW_RETRY_MARKER
	);
}

function stripRedundantPreviousCompactionMessages(
	messages: AppMessage[],
	previousSummary: string | undefined,
): AppMessage[] {
	if (!previousSummary) {
		return messages;
	}

	return messages.filter(
		(message) =>
			!isDecoratedCompactionSummaryMessage(message) &&
			!isCompactionResumePromptMessage(message),
	);
}

function getOverflowTokenGap(errorMessage: string): number | undefined {
	const parsed = parseOverflowDetails(errorMessage);
	if (parsed?.requestedTokens === undefined || parsed.maxTokens === undefined) {
		return undefined;
	}
	const gap = parsed.requestedTokens - parsed.maxTokens;
	return gap > 0 ? gap : undefined;
}

function estimateRetryMessageTokens(message: AppMessage): number {
	const llmMessage = convertAppMessageToLlm(message);
	if (!llmMessage) {
		return 0;
	}
	return Math.max(1, Math.ceil(JSON.stringify(llmMessage).length / 4));
}

function truncateSummaryInputForOverflowRetry(
	messages: AppMessage[],
	overflowErrorMessage?: string,
): AppMessage[] | null {
	if (messages.length < 2) {
		return null;
	}

	const preamble = isPreviousSummaryPreamble(messages[0]) ? messages[0] : null;
	const bodyWithMarker = preamble ? messages.slice(1) : messages;
	const body = isOverflowRetryMarker(bodyWithMarker[0])
		? bodyWithMarker.slice(1)
		: bodyWithMarker;
	if (body.length < 2) {
		return null;
	}

	const turnBoundaries = findTurnBoundaries(body, 0, body.length).filter(
		(index) => index > 0,
	);
	const tokenGap = overflowErrorMessage
		? getOverflowTokenGap(overflowErrorMessage)
		: undefined;
	let boundary = 0;
	if (tokenGap !== undefined) {
		let coveredTokens = 0;
		const segmentEnds = [...turnBoundaries, body.length];
		for (const segmentEnd of segmentEnds) {
			if (segmentEnd <= boundary) {
				continue;
			}
			coveredTokens += body
				.slice(boundary, segmentEnd)
				.reduce(
					(total, message) => total + estimateRetryMessageTokens(message),
					0,
				);
			boundary = segmentEnd;
			if (coveredTokens >= tokenGap) {
				break;
			}
		}
	} else {
		const approximateDropCount = Math.max(1, Math.floor(body.length * 0.2));
		boundary =
			turnBoundaries.find((index) => index >= approximateDropCount) ??
			approximateDropCount;
	}
	boundary = adjustBoundaryForToolResults(body, boundary);
	if (boundary >= body.length) {
		return null;
	}

	const truncatedBody = body.slice(boundary);
	if (truncatedBody.length === 0) {
		return null;
	}

	const markerMessage: AppMessage = {
		role: "user",
		content: COMPACTION_OVERFLOW_RETRY_MARKER,
		timestamp: Date.now(),
	};
	return preamble
		? [preamble, markerMessage, ...truncatedBody]
		: [markerMessage, ...truncatedBody];
}

/**
 * Find the last non-aborted assistant message usage from a message array.
 *
 * Used to determine current context window consumption. Walks backwards
 * to find the most recent valid usage metadata.
 *
 * @param messages - Array of application messages
 * @returns Usage metadata from the last assistant message, or null
 */
export function getLastAssistantUsage(messages: AppMessage[]): Usage | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const usage = getAssistantUsage(messages[i]!);
		if (usage) return usage;
	}
	return null;
}

/**
 * Find the last non-aborted assistant message usage from session entries.
 *
 * @param entries - Array of session entries
 * @returns Usage metadata from the last assistant message, or null
 */
export function getLastAssistantUsageFromEntries(
	entries: SessionEntry[],
): Usage | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!entry) continue;
		if (entry.type === "message") {
			const usage = getAssistantUsage(entry.message as AppMessage);
			if (usage) return usage;
		}
	}
	return null;
}

// ============================================================================
// Compaction Trigger Detection
// ============================================================================

/**
 * Determine if compaction should trigger based on current context usage.
 *
 * Compaction triggers when context usage exceeds `contextWindow - reserveTokens`,
 * leaving enough room for summary generation plus a safety margin.
 *
 * @param contextTokens - Current context window usage in tokens
 * @param contextWindow - Model's total context window size
 * @param settings - Compaction configuration
 * @returns true if compaction should trigger
 */
export function shouldCompact(
	contextTokens: number,
	contextWindow: number,
	settings: CompactionSettings,
): boolean {
	if (!settings.enabled) return false;
	return contextTokens > contextWindow - settings.reserveTokens;
}

/**
 * Calculate context usage percentage.
 *
 * @param contextTokens - Current context window usage in tokens
 * @param contextWindow - Model's total context window size
 * @returns Percentage of context window used (0-100)
 */
export function calculateUsagePercent(
	contextTokens: number,
	contextWindow: number,
): number {
	if (contextWindow <= 0) return 0;
	return (contextTokens / contextWindow) * 100;
}

// ============================================================================
// Cut Point Detection
// ============================================================================

/**
 * Result of finding a cut point, including split turn information.
 */
export interface CutPointResult {
	/** Index of first message to keep (messages before this are summarized) */
	firstKeptIndex: number;
	/** Index of user message that starts the turn being split, or -1 if not splitting */
	turnStartIndex: number;
	/** Whether this cut splits a turn (cut point is not a user message) */
	isSplitTurn: boolean;
}

/**
 * Find indices of user messages (turn boundaries) in a message array.
 *
 * Turn boundaries are important because we never want to split a turn
 * (user message + assistant response + tool results). Cutting at a user
 * message ensures turn integrity.
 *
 * @param messages - Array of messages to scan
 * @param startIndex - First index to consider (inclusive)
 * @param endIndex - Last index to consider (exclusive)
 * @returns Array of indices where user messages appear
 */
function findTurnBoundaries(
	messages: AppMessage[],
	startIndex: number,
	endIndex: number,
): number[] {
	const boundaries: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		if (messages[i]!.role === "user") {
			boundaries.push(i);
		}
	}
	return boundaries;
}

/**
 * Find the user message that starts the turn containing the given index.
 *
 * @param messages - Array of messages
 * @param entryIndex - Index of the message to find the turn start for
 * @param startIndex - First index to consider (inclusive)
 * @returns Index of the user message that starts this turn, or -1 if not found
 */
export function findTurnStartIndex(
	messages: AppMessage[],
	entryIndex: number,
	startIndex: number,
): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		if (messages[i]!.role === "user") {
			return i;
		}
	}
	return -1;
}

/**
 * Find the optimal cut point in messages that preserves `keepRecentTokens`.
 *
 * The algorithm:
 * 1. Find all turn boundaries (user message indices)
 * 2. Walk backwards collecting assistant token usage
 * 3. Find where cumulative token difference exceeds keepRecentTokens
 * 4. Return the nearest turn boundary at or before that point
 *
 * This ensures:
 * - Recent context is preserved based on actual token usage, not message count
 * - Turn integrity is maintained (user/assistant/toolResult groups stay together)
 * - More context is kept when messages are small, less when large
 *
 * @param messages - Array of messages to analyze
 * @param startIndex - First index to consider for cutting
 * @param endIndex - Last index to consider (exclusive)
 * @param keepRecentTokens - Approximate tokens to preserve
 * @returns Index of first message to keep (messages before this are summarized)
 */
export function findCutPoint(
	messages: AppMessage[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): number {
	const boundaries = findTurnBoundaries(messages, startIndex, endIndex);

	if (boundaries.length === 0) {
		return startIndex; // No user messages, keep everything in range
	}

	// Collect assistant usages walking backwards from endIndex
	const assistantUsages: Array<{ index: number; tokens: number }> = [];
	for (let i = endIndex - 1; i >= startIndex; i--) {
		const usage = getAssistantUsage(messages[i]!);
		if (usage) {
			assistantUsages.push({
				index: i,
				tokens: calculateContextTokens(usage),
			});
		}
	}

	if (assistantUsages.length === 0) {
		// No usage info, keep last turn only
		return boundaries[boundaries.length - 1]!;
	}

	// Walk through and find where cumulative token difference exceeds keepRecentTokens
	const newestTokens = assistantUsages[0]!.tokens;
	let cutIndex = startIndex; // Default: keep everything in range

	for (let i = 1; i < assistantUsages.length; i++) {
		const tokenDiff = newestTokens - assistantUsages[i]!.tokens;
		if (tokenDiff >= keepRecentTokens) {
			// Find the turn boundary at or before the assistant we want to keep
			const lastKeptAssistantIndex = assistantUsages[i - 1]!.index;

			for (let b = boundaries.length - 1; b >= 0; b--) {
				const boundary = boundaries[b];
				if (boundary !== undefined && boundary <= lastKeptAssistantIndex) {
					cutIndex = boundary;
					break;
				}
			}
			break;
		}
	}

	return cutIndex;
}

/**
 * Find valid cut points (user or assistant messages, not tool results).
 * Tool results must stay with their preceding tool call.
 *
 * @param messages - Array of messages to scan
 * @param startIndex - First index to consider (inclusive)
 * @param endIndex - Last index to consider (exclusive)
 * @returns Array of indices where valid cut points exist
 */
function findValidCutPoints(
	messages: AppMessage[],
	startIndex: number,
	endIndex: number,
): number[] {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const role = messages[i]!.role;
		// user and assistant are valid cut points
		// toolResult must stay with its preceding tool call
		if (role === "user" || role === "assistant") {
			cutPoints.push(i);
		}
	}
	return cutPoints;
}

/**
 * Find the optimal cut point with split turn information.
 *
 * Similar to findCutPoint but:
 * - Can cut at assistant messages (not just user messages)
 * - Returns information about whether we're splitting a turn
 *
 * This allows for more aggressive compaction when turns are very large,
 * while providing the context needed to summarize the split turn prefix.
 *
 * @param messages - Array of messages to analyze
 * @param startIndex - First index to consider for cutting
 * @param endIndex - Last index to consider (exclusive)
 * @param keepRecentTokens - Approximate tokens to preserve
 * @returns CutPointResult with index and split turn information
 */
export function findCutPointWithSplitInfo(
	messages: AppMessage[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints = findValidCutPoints(messages, startIndex, endIndex);

	if (cutPoints.length === 0) {
		return {
			firstKeptIndex: startIndex,
			turnStartIndex: -1,
			isSplitTurn: false,
		};
	}

	// Estimate message sizes for token-based cutting
	let accumulatedTokens = 0;
	let cutIndex = startIndex;

	for (let i = endIndex - 1; i >= startIndex; i--) {
		const usage = getAssistantUsage(messages[i]!);
		if (usage) {
			accumulatedTokens = calculateContextTokens(usage);
			// Using cumulative tokens from the last assistant message
			if (accumulatedTokens >= keepRecentTokens) {
				// Find the closest valid cut point at or after this index
				for (const cp of cutPoints) {
					if (cp >= i) {
						cutIndex = cp;
						break;
					}
				}
				break;
			}
		}
	}

	// If no cut point found via tokens, use last assistant's token-based cut
	if (cutIndex === startIndex) {
		// Fall back to original algorithm
		cutIndex = findCutPoint(messages, startIndex, endIndex, keepRecentTokens);
	}

	// Determine if this is a split turn
	const isUserMessage = messages[cutIndex]?.role === "user";
	const turnStartIndex = isUserMessage
		? -1
		: findTurnStartIndex(messages, cutIndex, startIndex);

	return {
		firstKeptIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !isUserMessage && turnStartIndex !== -1,
	};
}

/**
 * Adjust a cut boundary to preserve tool call/result integrity.
 *
 * Tool results must stay paired with their originating assistant message.
 * If a toolResult would be kept but its toolCall would be cut, this
 * moves the boundary back to include the toolCall.
 *
 * @param messages - Array of messages
 * @param boundary - Initial cut point
 * @returns Adjusted boundary that preserves tool integrity
 */
export function adjustBoundaryForToolResults(
	messages: AppMessage[],
	boundary: number,
): number {
	let adjusted = boundary;
	const seenToolCalls = new Set<string>();
	const missingToolCalls = new Set<string>();

	// Process assistant message to collect tool calls
	const processAssistantMessage = (message: AppMessage) => {
		if (message.role !== "assistant") return;
		const content = (message as AssistantMessage).content;
		if (!content) return;
		for (const part of content) {
			if (part?.type === "toolCall") {
				seenToolCalls.add(part.id);
				if (missingToolCalls.has(part.id)) {
					missingToolCalls.delete(part.id);
				}
			}
		}
	};

	// Process tool result to check for missing tool calls
	const processToolResultMessage = (message: AppMessage) => {
		if (message.role !== "toolResult") return;
		const toolCallId = (message as { toolCallId: string }).toolCallId;
		if (!seenToolCalls.has(toolCallId)) {
			missingToolCalls.add(toolCallId);
		}
	};

	// First pass: process messages we're keeping
	for (const message of messages.slice(adjusted)) {
		processAssistantMessage(message);
		processToolResultMessage(message);
	}

	// Walk backwards to find missing tool calls
	while (missingToolCalls.size > 0 && adjusted > 0) {
		adjusted -= 1;
		const candidate = messages[adjusted]!;
		processAssistantMessage(candidate);
		processToolResultMessage(candidate);
	}

	return adjusted;
}

// ============================================================================
// Summarization
// ============================================================================

/**
 * Default prompt for generating compaction summaries.
 *
 * Based on research into Claude Code, Codex (OpenAI), and OpenCode (SST).
 * Focused on creating actionable handoff summaries for the resuming LLM.
 */
export const SUMMARIZATION_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- Absolute file paths of any relevant files that were read or modified
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`;

/**
 * Prompt for summarizing the prefix of a split turn.
 *
 * Used when compaction cuts in the middle of a turn (at an assistant message
 * rather than a user message). The prefix of the turn needs summarization
 * to provide context for the kept suffix.
 */
export const TURN_PREFIX_SUMMARIZATION_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION for a split turn.
This is the PREFIX of a turn that was too large to keep in full. The SUFFIX (recent work) is being kept.

Create a handoff summary that captures:
- What the user originally asked for in this turn
- Key decisions and progress made early in this turn
- Important context needed to understand the kept suffix

Be concise. Focus on information needed to understand the retained recent work.`;

/**
 * Build the turn prefix summarization prompt.
 *
 * @returns Complete turn prefix summarization prompt
 */
export function buildTurnPrefixSummarizationPrompt(): string {
	return TURN_PREFIX_SUMMARIZATION_PROMPT;
}

/**
 * Build the summarization prompt, optionally with custom instructions.
 *
 * @param customInstructions - Optional additional focus for the summary
 * @returns Complete summarization prompt
 */
export function buildSummarizationPrompt(customInstructions?: string): string {
	if (customInstructions) {
		return `${SUMMARIZATION_PROMPT}\n\nAdditional focus: ${customInstructions}`;
	}
	return SUMMARIZATION_PROMPT;
}

/**
 * Decorate a summary with handoff context.
 *
 * Adds a prefix that instructs the resuming LLM to build on existing work,
 * and a footer with compaction metadata.
 *
 * @param summaryText - The generated summary content
 * @param compactedCount - Number of messages that were compacted
 * @param fromModel - Whether the summary was generated by the LLM (vs local fallback)
 * @returns Decorated summary text
 */
export function decorateSummaryText(
	summaryText: string,
	compactedCount: number,
	fromModel: boolean,
): string {
	// OAI-style handoff prefix that tells the resuming model it's continuing work
	const handoffPrefix = fromModel
		? "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:\n\n"
		: "_Local summary of prior discussion (model unavailable)._\n\n";

	return `${handoffPrefix}${summaryText}\n\n(Compacted ${compactedCount} messages on ${new Date().toLocaleString()})`;
}

/**
 * Check whether text matches the decorated compaction summary format.
 */
export function isDecoratedCompactionSummaryText(text: string): boolean {
	const normalized = text.trim();
	if (!normalized) return false;
	return (
		normalized.includes(
			"Another language model started to solve this problem",
		) ||
		normalized.includes("(Compacted") ||
		normalized.includes("_Local summary of prior discussion")
	);
}

/**
 * Check whether a message is a decorated assistant compaction summary.
 */
export function isDecoratedCompactionSummaryMessage(
	message: AppMessage,
): boolean {
	if (message.role !== "assistant") return false;
	return isDecoratedCompactionSummaryText(extractMessageText(message));
}

/**
 * Check whether text matches the internal post-compaction resume prompt.
 */
export function isCompactionResumePromptText(text: string): boolean {
	return text.trim() === COMPACTION_RESUME_PROMPT;
}

/**
 * Check whether a message is the internal post-compaction resume prompt.
 */
export function isCompactionResumePromptMessage(message: AppMessage): boolean {
	if (message.role !== "user") return false;
	return isCompactionResumePromptText(extractMessageText(message));
}

/**
 * Merge a history summary with a turn prefix summary for split turn compaction.
 *
 * When compaction splits a turn, we generate two summaries:
 * 1. History summary: everything before the split turn
 * 2. Turn prefix summary: the beginning of the split turn
 *
 * This function combines them into a single coherent summary.
 *
 * @param historySummary - Summary of messages before the split turn
 * @param turnPrefixSummary - Summary of the prefix of the split turn
 * @returns Combined summary text
 */
export function mergeSplitTurnSummaries(
	historySummary: string,
	turnPrefixSummary: string,
): string {
	return `${historySummary}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixSummary}`;
}

/**
 * Build a simple local summary when LLM summarization fails.
 *
 * Creates a bullet-point summary of user/assistant exchanges without
 * calling the LLM. Used as fallback when the model is unavailable.
 *
 * @param messages - Messages to summarize
 * @param maxExchanges - Maximum number of exchanges to include
 * @returns Local summary text
 */
export function buildLocalSummary(
	messages: AppMessage[],
	maxExchanges = 32,
): string {
	const lines: string[] = [];
	let exchange = 1;

	for (const message of messages) {
		if (lines.length >= maxExchanges) break;
		if (shouldSkipAssistantCompactionMessage(message)) continue;

		const content = extractMessageText(message);
		if (!content) continue;

		const truncated = truncateText(content, 180);
		if (message.role === "user") {
			lines.push(`• User ${exchange}: ${truncated}`);
		} else if (message.role === "assistant") {
			lines.push(`  ↳ Assistant: ${truncated}`);
			exchange += 1;
		} else if (message.role === "toolResult") {
			const toolName = (message as { toolName?: string }).toolName || "unknown";
			lines.push(`  ↳ Tool ${toolName}: ${truncateText(content, 160)}`);
		}
	}

	if (!lines.length) {
		return "(conversation summary placeholder: no textual content to compact)";
	}

	return `Conversation summary generated at ${new Date().toLocaleString()}\n${lines.join("\n")}`;
}

/**
 * Extract text content from a message.
 *
 * @param message - Message to extract text from
 * @returns Combined text content or empty string
 */
function extractMessageText(message: AppMessage): string {
	const llmMessage = convertAppMessageToLlm(message);
	if (!llmMessage) {
		return "";
	}
	if (typeof llmMessage.content === "string") {
		return llmMessage.content;
	}
	if (Array.isArray(llmMessage.content)) {
		return llmMessage.content
			.map((part) => {
				if (part.type === "text") return part.text;
				if (part.type === "thinking") return part.thinking;
				return "";
			})
			.filter((part): part is string => Boolean(part))
			.join(" ");
	}
	return "";
}

/**
 * Truncate text to a maximum length with ellipsis.
 *
 * @param text - Text to truncate
 * @param limit - Maximum length
 * @returns Truncated text with ellipsis if needed
 */
function truncateText(text: string, limit = 160): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit - 1).trim()}…`;
}

// ============================================================================
// Compaction Preparation
// ============================================================================

/**
 * Prepare messages for compaction by finding the cut point and splitting.
 *
 * This is a pure function that determines what should be summarized vs kept,
 * without actually performing the summarization or I/O.
 *
 * @param messages - All messages in the conversation
 * @param settings - Compaction settings
 * @param previousSummary - Optional summary from a previous compaction (for cascading)
 * @returns Object with messages to summarize and messages to keep, or null if not enough history
 */
export function prepareCompaction(
	messages: AppMessage[],
	settings: CompactionSettings,
	previousSummary?: string,
): {
	messagesToSummarize: AppMessage[];
	keptMessages: AppMessage[];
	cutIndex: number;
} | null {
	const keepCount = 6; // Minimum messages to always keep
	if (messages.length <= keepCount + 1) {
		return null; // Not enough history to compact
	}

	// Find initial boundary
	let boundary = Math.max(0, messages.length - keepCount);

	// Use token-based cut point if we have usage data
	const lastUsage = getLastAssistantUsage(messages);
	if (lastUsage) {
		const tokenBasedCut = findCutPoint(
			messages,
			0,
			messages.length,
			settings.keepRecentTokens,
		);
		// Use the more conservative of the two (keep more messages)
		boundary = Math.max(boundary, tokenBasedCut);
	}

	// Adjust for tool result integrity
	boundary = adjustBoundaryForToolResults(messages, boundary);

	const older = messages.slice(0, boundary);
	if (!older.length) {
		return null; // No earlier messages to compact
	}

	// Prepare messages for summarization
	const messagesToSummarize: AppMessage[] = [];

	// Include previous summary if cascading
	if (previousSummary) {
		messagesToSummarize.push({
			role: "user",
			content: `Previous session summary:\n${previousSummary}`,
			timestamp: Date.now(),
		});
	}

	// Add older messages (limit to most recent 40 for summarization efficiency)
	const sliceSize = Math.min(40, older.length);
	const summaryTail = stripRedundantPreviousCompactionMessages(
		prepareMessagesForCompactionSummary(older.slice(-sliceSize)),
		previousSummary,
	);
	messagesToSummarize.push(...summaryTail);

	return {
		messagesToSummarize,
		keptMessages: messages.slice(boundary),
		cutIndex: boundary,
	};
}

/**
 * Extract the most recent compaction summary from messages.
 *
 * Looks for a message that appears to be a compaction summary (contains
 * the characteristic handoff prefix or compaction footer).
 *
 * @param messages - Messages to search
 * @returns Previous summary text or undefined
 */
export function findPreviousSummary(
	messages: AppMessage[],
): string | undefined {
	for (const message of messages) {
		if (isDecoratedCompactionSummaryMessage(message)) {
			const text = extractMessageText(message);
			if (text) {
				return text;
			}
		}
	}
	return undefined;
}

// ============================================================================
// Orchestrated Compaction
// ============================================================================

/**
 * Minimal agent interface required by performCompaction.
 * Avoids depending on the full Agent class to keep this module leaf-level.
 */
export interface CompactionAgent {
	state: {
		messages: AppMessage[];
		model: { api: Api; provider: string; id: string };
		systemPromptSourcePaths?: string[];
	};
	generateSummary(
		history: AppMessage[],
		prompt: string,
		systemPrompt: string,
	): Promise<AssistantMessage>;
	replaceMessages(messages: AppMessage[]): void;
	appendMessage?(message: AppMessage): void;
	clearTransientRunState?(): void;
}

/**
 * Minimal session manager interface required by performCompaction.
 */
export interface CompactionSessionManager {
	buildSessionContext(): { messageEntries: Array<{ id?: string }> };
	saveCompaction(
		summary: string,
		firstKeptEntryIndex: number,
		tokensBefore: number,
		options?: {
			auto?: boolean;
			customInstructions?: string;
			firstKeptEntryId?: string;
		},
	): void;
	saveMessage(message: AppMessage): void;
}

/**
 * Result of a performCompaction() call.
 */
export interface PerformCompactionResult {
	success: boolean;
	compactedCount?: number;
	summary?: string;
	firstKeptEntryIndex?: number;
	tokensBefore?: number;
	error?: string;
}

function buildEffectiveCustomInstructions(
	customInstructions: string | undefined,
	hookResult?: {
		systemMessage?: string;
		additionalContext?: string;
	},
): string | undefined {
	const trimmedCustomInstructions = customInstructions?.trim();
	const hookSections = [
		hookResult?.systemMessage?.trim()
			? `Hook system guidance:\n${hookResult.systemMessage.trim()}`
			: null,
		hookResult?.additionalContext?.trim()
			? `Hook context:\n${hookResult.additionalContext.trim()}`
			: null,
	].filter((section): section is string => Boolean(section));

	if (hookSections.length === 0) {
		return trimmedCustomInstructions || undefined;
	}

	if (!trimmedCustomInstructions) {
		return hookSections.join("\n\n");
	}

	return `${trimmedCustomInstructions}\n\n${hookSections.join("\n\n")}`;
}

function buildPostCompactHookMessages(hookResult: {
	systemMessage?: string;
	additionalContext?: string;
}): AppMessage[] {
	const timestamp = new Date().toISOString();
	const messages: AppMessage[] = [];
	const systemMessage = hookResult.systemMessage?.trim();
	if (systemMessage) {
		messages.push(
			createHookMessage(
				"PostCompact",
				`PostCompact hook system guidance:\n${systemMessage}`,
				true,
				undefined,
				timestamp,
			),
		);
	}

	const additionalContext = hookResult.additionalContext?.trim();
	if (additionalContext) {
		messages.push(
			createHookMessage(
				"PostCompact",
				additionalContext,
				true,
				undefined,
				timestamp,
			),
		);
	}

	return messages;
}

/**
 * Perform context compaction end-to-end: calculate boundary, generate summary,
 * replace messages, and persist to session.
 *
 * This function consolidates the compaction logic previously duplicated across
 * main.ts (auto-compact + RPC compact) and ConversationCompactor.
 *
 * @param params.agent - Agent instance (or compatible interface)
 * @param params.sessionManager - Session persistence manager
 * @param params.auto - Whether this is an auto-triggered compaction
 * @param params.customInstructions - Optional focus instructions for summary
 * @param params.renderSummaryText - Optional callback to render an AssistantMessage to plain text.
 *   When omitted, performCompaction uses a JSON-based fallback extractor.
 * @returns Result indicating success or failure
 */
export async function performCompaction(params: {
	agent: CompactionAgent;
	sessionManager: CompactionSessionManager;
	auto?: boolean;
	trigger?: "auto" | "manual" | "token_limit";
	customInstructions?: string;
	persistCustomInstructions?: boolean;
	hookContext?: CompactionHookContext;
	hookService?: CompactionHookService;
	getPostKeepMessages?: () => Promise<AppMessage[]>;
	renderSummaryText?: (message: AssistantMessage) => string;
}): Promise<PerformCompactionResult> {
	const {
		agent,
		sessionManager,
		auto,
		trigger,
		customInstructions,
		persistCustomInstructions = true,
		hookContext,
		hookService,
		getPostKeepMessages,
		renderSummaryText,
	} = params;
	const messages = [...agent.state.messages];
	const keepCount = 6;

	if (messages.length <= keepCount + 1) {
		return { success: false, error: "Not enough history to compact" };
	}

	// Calculate boundary using token-based cut point detection
	let boundary = Math.max(0, messages.length - keepCount);
	const lastUsage = getLastAssistantUsage(messages);
	if (lastUsage) {
		const tokenBasedCut = findCutPoint(
			messages,
			0,
			messages.length,
			DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
		);
		boundary = Math.max(boundary, tokenBasedCut);
	}
	boundary = adjustBoundaryForToolResults(messages, boundary);

	const older = messages.slice(0, boundary);
	if (!older.length) {
		return { success: false, error: "No earlier messages to compact" };
	}
	const keep = messages.slice(boundary);
	const restoredReadMessages = await collectRecentReadRestoreMessages(
		older,
		keep,
		agent.state.systemPromptSourcePaths,
	);
	const readPathsRestoredAfterCompaction =
		collectVisibleReadPaths(restoredReadMessages);

	const tokensBefore = lastUsage ? calculateContextTokens(lastUsage) : 0;
	let effectiveCustomInstructions = customInstructions;

	const effectiveHookService =
		hookService ??
		(hookContext ? createCompactionHookService(hookContext) : undefined);

	if (effectiveHookService) {
		if (
			!effectiveHookService.hasHooks ||
			effectiveHookService.hasHooks("PreCompact")
		) {
			const hookResult = await effectiveHookService.runPreCompactHooks(
				trigger ?? (auto ? "auto" : "manual"),
				tokensBefore,
				DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
				hookContext?.signal,
			);

			if (hookResult.blocked) {
				return {
					success: false,
					error:
						hookResult.blockReason ?? "Compaction blocked by PreCompact hook",
				};
			}

			if (hookResult.preventContinuation) {
				return {
					success: false,
					error:
						hookResult.stopReason ?? "Compaction prevented by PreCompact hook",
				};
			}

			effectiveCustomInstructions = buildEffectiveCustomInstructions(
				customInstructions,
				hookResult,
			);
		}
	}

	// Look for previous summary (cascading)
	const previousSummary = findPreviousSummary(messages);
	const olderForSummary = stripRedundantPreviousCompactionMessages(
		prepareMessagesForCompactionSummary(
			older,
			readPathsRestoredAfterCompaction,
		),
		previousSummary,
	);
	const summaryInput: AppMessage[] = [];
	if (previousSummary) {
		summaryInput.push({
			role: "user",
			content: `Previous session summary:\n${previousSummary}`,
			timestamp: Date.now(),
		});
	}
	const sliceSize = Math.min(40, older.length);
	summaryInput.push(...olderForSummary.slice(-sliceSize));

	let summaryText = "";
	let usedModel = false;
	let summaryInputForAttempt = summaryInput;
	let overflowAttempts = 0;

	for (;;) {
		const prompt = buildSummarizationPrompt(effectiveCustomInstructions);
		try {
			const summary = await agent.generateSummary(
				summaryInputForAttempt,
				prompt,
				"You are a careful note-taker that distills coding conversations into actionable summaries.",
			);
			if (isCompactionOverflowMessage(summary)) {
				throw new Error(
					summary.errorMessage ||
						extractMessageText(summary) ||
						"Prompt too long",
				);
			}
			const llmText = renderSummaryText
				? renderSummaryText(summary)
				: extractMessageText(summary);
			summaryText =
				llmText.trim() || buildLocalSummary(summaryInputForAttempt, 32);
			usedModel = true;
			break;
		} catch (error) {
			if (
				error instanceof Error &&
				isOverflowErrorMessage(error.message) &&
				overflowAttempts < MAX_COMPACTION_OVERFLOW_RETRIES
			) {
				const truncated = truncateSummaryInputForOverflowRetry(
					summaryInputForAttempt,
					error.message,
				);
				if (truncated) {
					summaryInputForAttempt = truncated;
					overflowAttempts += 1;
					continue;
				}
			}
			summaryText = buildLocalSummary(summaryInputForAttempt, 32);
			break;
		}
	}

	const decorated = decorateSummaryText(summaryText, older.length, usedModel);

	// Build summary and resume messages
	const summaryMessage: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: decorated }],
		api: agent.state.model.api,
		provider: agent.state.model.provider,
		model: agent.state.model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};

	const resumeMessage: AppMessage = {
		role: "user",
		content: [
			{
				type: "text",
				text: COMPACTION_RESUME_PROMPT,
			},
		],
		timestamp: Date.now(),
	};

	const sessionContext = sessionManager.buildSessionContext();
	const firstKeptEntryId = sessionContext.messageEntries[boundary]?.id;

	// Persist compaction to session
	sessionManager.saveCompaction(summaryText, boundary, tokensBefore, {
		auto,
		customInstructions: persistCustomInstructions
			? customInstructions
			: undefined,
		firstKeptEntryId,
	});

	// Replace agent messages
	const newMessages = [summaryMessage as AppMessage, resumeMessage, ...keep];
	agent.replaceMessages(newMessages);
	agent.clearTransientRunState?.();
	sessionManager.saveMessage(summaryMessage);
	sessionManager.saveMessage(resumeMessage);
	await runPostCompactionCleanup({
		auto,
		customInstructions,
		compactedCount: older.length,
		firstKeptEntryIndex: boundary,
	});

	const appendedTailMessages: AppMessage[] = [];
	const persistTailMessages = (messagesToPersist: AppMessage[]) => {
		if (messagesToPersist.length === 0) {
			return;
		}

		appendedTailMessages.push(...messagesToPersist);
		if (typeof agent.appendMessage === "function") {
			for (const message of messagesToPersist) {
				agent.appendMessage(message);
				sessionManager.saveMessage(message);
			}
			return;
		}

		agent.replaceMessages([
			summaryMessage as AppMessage,
			resumeMessage,
			...keep,
			...appendedTailMessages,
		]);
		for (const message of messagesToPersist) {
			sessionManager.saveMessage(message);
		}
	};

	const callerPostKeepMessages = (await getPostKeepMessages?.()) ?? [];
	const preservedTailMessages = [...keep, ...callerPostKeepMessages];
	const dedupedRestoredReadMessages = restoredReadMessages.filter((message) => {
		if (
			message.role !== "hookMessage" ||
			message.customType !== READ_RESTORE_COMPACTION_CUSTOM_TYPE ||
			!Array.isArray(message.content)
		) {
			return false;
		}

		const details = message.details;
		const filePath =
			typeof details === "object" &&
			details !== null &&
			"filePath" in details &&
			typeof details.filePath === "string"
				? details.filePath
				: null;
		return (
			filePath !== null &&
			!hasReadRestoreMessage(preservedTailMessages, filePath, message.content)
		);
	});
	const postKeepMessages = [
		...dedupedRestoredReadMessages,
		...(await collectRecentSkillRestoreMessages(older, preservedTailMessages)),
		...callerPostKeepMessages,
	];
	persistTailMessages(postKeepMessages);

	let postCompactHookMessages: AppMessage[] = [];

	if (
		effectiveHookService?.runPostCompactHooks &&
		(!effectiveHookService.hasHooks ||
			effectiveHookService.hasHooks("PostCompact"))
	) {
		const postCompactHookResult =
			await effectiveHookService.runPostCompactHooks(
				trigger ?? (auto ? "auto" : "manual"),
				summaryText,
				hookContext?.signal,
			);
		if (
			postCompactHookResult.blocked ||
			postCompactHookResult.preventContinuation
		) {
			logger.warn(
				"PostCompact hook returned unsupported control flow request; ignoring",
				{
					trigger: trigger ?? (auto ? "auto" : "manual"),
					blocked: postCompactHookResult.blocked,
					preventContinuation: postCompactHookResult.preventContinuation,
					reason:
						postCompactHookResult.blockReason ??
						postCompactHookResult.stopReason,
				},
			);
		}
		postCompactHookMessages = buildPostCompactHookMessages(
			postCompactHookResult,
		);
		persistTailMessages(postCompactHookMessages);
	}

	return {
		success: true,
		compactedCount: older.length,
		summary: summaryText,
		firstKeptEntryIndex: boundary,
		tokensBefore,
	};
}
