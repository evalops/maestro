export function formatMemoryRelativeTime(
	timestamp: number | null | undefined,
): string {
	if (!timestamp) return "Never";
	const diff = Date.now() - timestamp;
	if (diff < 60_000) return "just now";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
	return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function truncateMemoryText(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength - 3)}...`;
}

export function extractMemoryTags(content: string): string[] {
	return Array.from(
		new Set((content.match(/#(\w+)/g) ?? []).map((tag) => tag.slice(1))),
	);
}
