/**
 * Session Message Sanitization
 * Pure functions for sanitizing messages before session persistence.
 * Handles credential redaction, attachment extraction, and content normalization.
 */

import type {
	AppMessage,
	Attachment,
	UserMessageWithAttachments,
} from "../agent/types.js";
import { sanitizePayload } from "../safety/context-firewall.js";

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
	if (message.role === "assistant") {
		if (!Array.isArray(message.content)) return message;

		let changed = false;
		const sanitizedContent = message.content.map((block) => {
			if (block.type !== "toolCall") return block;
			const sanitizedArgs = sanitizePayload(block.arguments, {
				redactSecrets: true,
				vaultCredentials: false,
			}) as Record<string, unknown>;
			changed = true;
			return { ...block, arguments: sanitizedArgs };
		});

		return changed ? { ...message, content: sanitizedContent } : message;
	}

	if (message.role !== "toolResult") return message;

	let changed = false;
	const sanitizedContent = message.content.map((block) => {
		if (block.type !== "text") return block;
		const sanitizedText = sanitizePayload(block.text, {
			redactSecrets: true,
			vaultCredentials: false,
		});
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
		sanitizedDetails = sanitizePayload(sanitizedDetails, {
			redactSecrets: true,
			vaultCredentials: false,
		}) as typeof message.details;
		changed = true;
	}

	return changed
		? { ...message, content: sanitizedContent, details: sanitizedDetails }
		: message;
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
