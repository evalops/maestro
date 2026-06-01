import type { ApiClient, Message } from "../services/api-client.js";
import type { UiMessage } from "./composer-chat-stream-state.js";

export type ComposerChatAttachment = NonNullable<
	Message["attachments"]
>[number];
export type ComposerChatAttachments = NonNullable<Message["attachments"]>;

type AttachmentExtractionClient = Pick<ApiClient, "extractAttachmentText">;
type AttachmentHydrationClient = Pick<
	ApiClient,
	| "getSessionAttachmentContentBase64"
	| "getSharedSessionAttachmentContentBase64"
>;

export async function ensureExtractedTextForComposerAttachments(
	apiClient: AttachmentExtractionClient,
	attachments: ComposerChatAttachments,
): Promise<ComposerChatAttachments> {
	const out: ComposerChatAttachments = [];
	for (const att of attachments) {
		if (!att || typeof att !== "object") continue;

		if (
			att.type !== "document" ||
			typeof att.extractedText === "string" ||
			typeof att.content !== "string" ||
			att.content.length === 0
		) {
			out.push(att);
			continue;
		}

		try {
			const res = await apiClient.extractAttachmentText({
				fileName: att.fileName,
				mimeType: att.mimeType,
				contentBase64: att.content,
			});
			out.push({
				...att,
				extractedText: res.extractedText || undefined,
			});
		} catch (e) {
			console.warn("Attachment extraction failed", e);
			out.push(att);
		}
	}
	return out;
}

export async function hydrateComposerAttachmentForRequest(
	apiClient: AttachmentHydrationClient,
	contentCache: Map<string, string>,
	att: ComposerChatAttachment,
	options: { sessionId?: string | null; shareToken?: string | null },
): Promise<ComposerChatAttachment> {
	const sessionId = options.sessionId ?? null;
	const shareToken = options.shareToken ?? null;
	if (!att?.id) return att;

	if (typeof att.content === "string" && att.content.length > 0) {
		if (!contentCache.has(att.id)) {
			contentCache.set(att.id, att.content);
		}
		return att;
	}

	if (!att.contentOmitted) return att;

	const cached = contentCache.get(att.id);
	if (cached) {
		return { ...att, content: cached, contentOmitted: undefined };
	}

	if (!sessionId && !shareToken) return att;

	try {
		const base64 = shareToken
			? await apiClient.getSharedSessionAttachmentContentBase64(
					shareToken,
					att.id,
				)
			: await apiClient.getSessionAttachmentContentBase64(sessionId!, att.id);
		contentCache.set(att.id, base64);
		return { ...att, content: base64, contentOmitted: undefined };
	} catch (e) {
		console.warn("Failed to hydrate attachment content", e);
		return att;
	}
}

export async function hydrateComposerAttachmentsForRequest(
	apiClient: AttachmentHydrationClient,
	contentCache: Map<string, string>,
	attachments: ComposerChatAttachments,
	options: { sessionId?: string | null; shareToken?: string | null },
): Promise<ComposerChatAttachments> {
	const sessionId = options.sessionId ?? null;
	const shareToken = options.shareToken ?? null;
	if (!sessionId && !shareToken) return attachments;
	return await Promise.all(
		attachments.map((att) =>
			hydrateComposerAttachmentForRequest(
				apiClient,
				contentCache,
				att,
				options,
			),
		),
	);
}

export async function buildComposerMessagesForChatRequest(
	messages: UiMessage[],
	options: {
		apiClient: AttachmentHydrationClient;
		contentCache: Map<string, string>;
		sessionId?: string | null;
		shareToken?: string | null;
	},
): Promise<Message[]> {
	const sessionId = options.sessionId ?? null;
	const shareToken = options.shareToken ?? null;
	const filtered = messages.filter((msg) => !msg.localOnly);
	if (!sessionId && !shareToken) return filtered;

	const out: Message[] = [];
	for (const msg of filtered) {
		const atts = Array.isArray(msg.attachments) ? msg.attachments : [];
		if (msg.role !== "user" || atts.length === 0) {
			out.push(msg);
			continue;
		}

		const hydrated = await hydrateComposerAttachmentsForRequest(
			options.apiClient,
			options.contentCache,
			atts,
			{ sessionId, shareToken },
		);
		out.push({ ...msg, attachments: hydrated });
	}
	return out;
}

export function getAllComposerAttachments(
	messages: UiMessage[],
	contentCache: Map<string, string>,
): ComposerChatAttachments {
	const byId = new Map<string, ComposerChatAttachment>();

	for (const msg of messages) {
		if (msg.role !== "user") continue;
		const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
		for (const a of attachments) {
			if (!a || typeof a !== "object") continue;
			const id = typeof a.id === "string" ? a.id : "";
			if (!id) continue;

			const existing = byId.get(id);
			if (!existing) {
				byId.set(id, a);
				continue;
			}

			byId.set(id, {
				...existing,
				...a,
				content: a.content ?? existing.content,
				preview: a.preview ?? existing.preview,
				extractedText: a.extractedText ?? existing.extractedText,
			});
		}
	}

	return Array.from(byId.values()).map((a) => {
		if (typeof a.content === "string" && a.content.length > 0) return a;
		if (!a.contentOmitted) return a;
		const cached = contentCache.get(a.id);
		return cached ? { ...a, content: cached, contentOmitted: undefined } : a;
	});
}
