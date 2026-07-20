/**
 * Pure text-formatting helpers shared across command controllers.
 */

/** Collapse whitespace and truncate to `limit` characters with an ellipsis. */
export function formatPreview(text: string, limit: number): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= limit) return normalized;
	return `${normalized.slice(0, limit - 1)}…`;
}

/** Trim and truncate to `limit` characters with an ellipsis (preserves newlines). */
export function formatPreviewBlock(text: string, limit: number): string {
	const trimmed = text.trim();
	if (trimmed.length <= limit) return trimmed;
	return `${trimmed.slice(0, limit - 1)}…`;
}

/** Human-readable duration string from milliseconds. */
export function formatDuration(durationMs?: number): string {
	if (!durationMs && durationMs !== 0) return "?";
	if (durationMs < 1000) return `${durationMs}ms`;
	return `${(durationMs / 1000).toFixed(1)}s`;
}
