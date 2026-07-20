export function isBlockedFollowUpShortcutDraft(text: string): boolean {
	const trimmed = text.trimStart();
	return trimmed.startsWith("/") || trimmed.startsWith("!");
}

export function canQueueFollowUpShortcut(options: {
	text: string;
	hasAttachments?: boolean;
}): boolean {
	const { text, hasAttachments = false } = options;
	if (text.trim().length === 0) {
		return hasAttachments;
	}
	return !isBlockedFollowUpShortcutDraft(text);
}
