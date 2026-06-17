/**
 * Session Message Sanitization
 * Pure functions for sanitizing messages before session persistence.
 * Handles credential redaction, attachment extraction, and content normalization.
 */

import type {
	AppMessage,
	Attachment,
	ImageContent,
	TextContent,
	UserMessageWithAttachments,
} from "../agent/types.js";
import { sanitizePayload } from "../safety/context-firewall-sanitize.js";

const SESSION_TEXT_SANITIZE_OPTIONS = {
	redactSecrets: true,
	truncateLargeBlobs: false,
	vaultCredentials: false,
	maxStringLength: Number.MAX_SAFE_INTEGER,
} as const;

const SESSION_PAYLOAD_SANITIZE_OPTIONS = {
	...SESSION_TEXT_SANITIZE_OPTIONS,
	maxArrayLength: Number.MAX_SAFE_INTEGER,
} as const;

export function isMessageWithAttachments(
	message: AppMessage,
): message is UserMessageWithAttachments & { attachments: Attachment[] } {
	return (
		typeof message === "object" &&
		message !== null &&
		"attachments" in message &&
		Array.isArray((message as { attachments?: unknown }).attachments)
	);
}

export function sanitizeMessageForSession(message: AppMessage): AppMessage {
	if (message.role === "user") {
		const sanitizedContent = sanitizeMessageContent(message.content);
		const sanitizedAttachments = sanitizeMessageAttachments(message);
		let sanitizedMetadata = message.metadata;
		if (sanitizedMetadata !== undefined) {
			sanitizedMetadata = sanitizeSessionPayload(sanitizedMetadata);
		}

		return sanitizedContent.changed ||
			sanitizedAttachments.changed ||
			sanitizedMetadata !== undefined
			? {
					...message,
					content: sanitizedContent.content,
					...(sanitizedAttachments.changed
						? { attachments: sanitizedAttachments.attachments }
						: {}),
					metadata: sanitizedMetadata,
				}
			: message;
	}

	if (message.role === "hookMessage") {
		const sanitizedContent = sanitizeMessageContent(message.content);
		let sanitizedDetails = message.details;
		if (sanitizedDetails !== undefined) {
			sanitizedDetails = sanitizeSessionPayload(sanitizedDetails);
		}

		return sanitizedContent.changed || sanitizedDetails !== undefined
			? {
					...message,
					content: sanitizedContent.content,
					details: sanitizedDetails,
				}
			: message;
	}

	if (message.role === "assistant") {
		if (!Array.isArray(message.content)) return message;

		let changed = false;
		const sanitizedContent = message.content.map((block) => {
			if (block.type !== "toolCall") return block;
			const sanitizedArgs = sanitizeSessionPayload(block.arguments);
			changed = true;
			return { ...block, arguments: sanitizedArgs };
		});

		return changed ? { ...message, content: sanitizedContent } : message;
	}

	if (message.role !== "toolResult") return message;

	let changed = false;
	const sanitizedContent = message.content.map((block) => {
		if (block.type !== "text") return block;
		const sanitizedText = sanitizeSessionTextForPersistence(block.text);
		if (typeof sanitizedText !== "string") {
			changed = true;
			return { ...block, text: String(sanitizedText) };
		}
		if (sanitizedText !== block.text) {
			changed = true;
			return { ...block, text: sanitizedText };
		}
		return block;
	});

	let sanitizedDetails = message.details;
	if (sanitizedDetails !== undefined) {
		sanitizedDetails = sanitizeSessionPayload(sanitizedDetails);
		changed = true;
	}

	return changed
		? { ...message, content: sanitizedContent, details: sanitizedDetails }
		: message;
}

export function sanitizeCustomMessageEntryForSession<T = unknown>(
	content: string | (TextContent | ImageContent)[],
	details?: T,
): {
	content: string | (TextContent | ImageContent)[];
	details?: T;
} {
	const sanitizedContent = sanitizeMessageContent(content);
	return {
		content: sanitizedContent.content,
		details:
			details === undefined ? undefined : sanitizeSessionPayload(details),
	};
}

function sanitizeSessionPayload<T>(payload: T): T {
	return sanitizePayload(payload, SESSION_PAYLOAD_SANITIZE_OPTIONS) as T;
}

export function sanitizeSessionTextForPersistence(text: string): string {
	const sanitizedText = sanitizePayload(text, {
		...SESSION_TEXT_SANITIZE_OPTIONS,
	});
	return typeof sanitizedText === "string"
		? sanitizedText
		: String(sanitizedText);
}

function sanitizeMessageContent(
	content: string | (TextContent | ImageContent)[],
): {
	content: string | (TextContent | ImageContent)[];
	changed: boolean;
} {
	if (typeof content === "string") {
		const sanitizedText = sanitizeSessionTextForPersistence(content);
		return { content: sanitizedText, changed: sanitizedText !== content };
	}

	let changed = false;
	const sanitizedBlocks = content.map((block) => {
		if (block.type !== "text") return block;
		const sanitizedText = sanitizeSessionTextForPersistence(block.text);
		if (sanitizedText === block.text) return block;
		changed = true;
		return { ...block, text: sanitizedText };
	});

	return { content: sanitizedBlocks, changed };
}

function sanitizeMessageAttachments(message: AppMessage): {
	attachments?: Attachment[];
	changed: boolean;
} {
	if (!isMessageWithAttachments(message) || message.attachments.length === 0) {
		return { changed: false };
	}

	let changed = false;
	const attachments = message.attachments.map((attachment) => {
		const sanitized = sanitizeAttachmentForSession(attachment);
		if (sanitized !== attachment) {
			changed = true;
		}
		return sanitized;
	});

	return { attachments, changed };
}

function sanitizeAttachmentForSession(attachment: Attachment): Attachment {
	let changed = false;
	const next: Attachment = { ...attachment };

	const fileName = sanitizeSessionTextForPersistence(attachment.fileName);
	if (fileName !== attachment.fileName) {
		next.fileName = fileName;
		changed = true;
	}

	const mimeType = sanitizeSessionTextForPersistence(attachment.mimeType);
	if (mimeType !== attachment.mimeType) {
		next.mimeType = mimeType;
		changed = true;
	}

	const content = sanitizeAttachmentContentForSession(attachment);
	if (content !== attachment.content) {
		next.content = content;
		changed = true;
	}

	if (attachment.extractedText !== undefined) {
		const extractedText = sanitizeSessionTextForPersistence(
			attachment.extractedText,
		);
		if (extractedText !== attachment.extractedText) {
			next.extractedText = extractedText;
			changed = true;
		}
	}

	return changed ? next : attachment;
}

function sanitizeAttachmentContentForSession(attachment: Attachment): string {
	if (attachment.type !== "document") {
		return attachment.content;
	}

	const decodedText = decodeBase64AttachmentText(attachment.content);
	if (decodedText === null) {
		return attachment.content;
	}
	if (!isTextLikeAttachment(attachment.mimeType, decodedText)) {
		return attachment.content;
	}

	const sanitizedText = sanitizeSessionTextForPersistence(decodedText);
	return sanitizedText === decodedText
		? attachment.content
		: Buffer.from(sanitizedText, "utf8").toString("base64");
}

function decodeBase64AttachmentText(content: string): string | null {
	const normalized = content.trim();
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
		return null;
	}
	try {
		const bytes = Buffer.from(normalized, "base64");
		if (bytes.length === 0 && normalized.length > 0) {
			return null;
		}
		const canonical = bytes.toString("base64").replace(/=+$/, "");
		if (canonical !== normalized.replace(/=+$/, "")) {
			return null;
		}
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}

function isTextLikeAttachment(mimeType: string, decodedText: string): boolean {
	const normalizedMime = mimeType.toLowerCase();
	if (
		normalizedMime.startsWith("text/") ||
		[
			"application/json",
			"application/ld+json",
			"application/javascript",
			"application/xml",
			"application/yaml",
			"application/x-yaml",
			"application/toml",
			"application/x-sh",
		].includes(normalizedMime)
	) {
		return true;
	}

	if (decodedText.length === 0) {
		return true;
	}
	let controlCount = 0;
	for (const char of decodedText) {
		const code = char.charCodeAt(0);
		if (code < 32 && char !== "\n" && char !== "\r" && char !== "\t") {
			controlCount += 1;
		}
	}
	return controlCount / decodedText.length < 0.02;
}

export function applyAttachmentExtracts(
	message: AppMessage,
	extractedById: Map<string, string>,
): AppMessage {
	if (!isMessageWithAttachments(message) || message.attachments.length === 0) {
		return message;
	}
	const attachments = message.attachments;

	let changed = false;
	const nextAttachments = attachments.map((att) => {
		if (!att || typeof att !== "object") return att;
		const id = typeof att.id === "string" ? att.id : "";
		if (!id) return att;
		const extracted = extractedById.get(id);
		if (!extracted) return att;
		if (att.extractedText === extracted) return att;
		changed = true;
		return { ...att, extractedText: extracted };
	});

	if (!changed) return message;
	return { ...message, attachments: nextAttachments };
}
