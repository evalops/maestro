/**
 * Tool categorization utilities for the sequence analyzer
 *
 * Provides tag-based classification of tools and sensitive path detection.
 *
 * @module safety/tool-categorization
 */

/**
 * Tool tags for categorization
 */
export const TOOL_TAGS: Record<string, string[]> = {
	// Read operations
	read: ["read", "file_read", "cat", "head", "tail", "grep"],
	// Write operations
	write: ["write", "edit", "file_write", "touch", "mkdir"],
	// Delete operations
	delete: ["delete_file", "rm", "rmdir", "unlink"],
	// Network egress
	egress: [
		"web_fetch",
		"webfetch",
		"fetch",
		"http_request",
		"curl",
		"wget",
		"send_email",
		"send_message",
	],
	// Execution
	exec: ["bash", "exec", "run", "spawn", "shell"],
	// System paths
	system: ["sudo", "chmod", "chown", "chroot"],
	// Sensitive data access
	sensitive: ["read_env", "read_secrets", "read_config", "get_credentials"],
	// Git operations
	git: ["git", "gh", "git_push", "git_commit"],
	// Authentication
	auth: ["login", "authenticate", "verify_token", "check_password"],
};

/**
 * Check if tool name matches a pattern using word-boundary logic
 * This handles cases like:
 * - "read" matches "read" (exact)
 * - "file_read" matches "read" (ends with pattern)
 * - "read_file" matches "read" (starts with pattern)
 * - "my_read_file" matches "read" (pattern in middle at word boundary)
 * But avoids false positives like:
 * - "reader" should NOT match "read" (pattern is substring, not word)
 */
export function matchesToolPattern(toolName: string, pattern: string): boolean {
	// Exact match
	if (toolName === pattern) {
		return true;
	}

	// Word-boundary match using regex
	// Match pattern at start, end, or surrounded by word separators (_, -)
	const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const wordBoundaryRegex = new RegExp(`(?:^|[_-])${escaped}(?:[_-]|$)`, "i");

	return wordBoundaryRegex.test(toolName);
}

/**
 * Get tags for a tool based on its name
 */
export function getToolTags(toolName: string): Set<string> {
	const tags = new Set<string>();

	const normalizedName = toolName.toLowerCase();

	for (const [tag, patterns] of Object.entries(TOOL_TAGS)) {
		if (patterns.some((p) => matchesToolPattern(normalizedName, p))) {
			tags.add(tag);
		}
	}

	// Special cases based on tool naming conventions
	if (normalizedName.includes("mcp_")) {
		// MCP tools might need specific handling
		if (normalizedName.includes("send") || normalizedName.includes("post")) {
			tags.add("egress");
		}
		if (normalizedName.includes("read") || normalizedName.includes("get")) {
			tags.add("read");
		}
	}

	return tags;
}

/**
 * Check if args contain paths to sensitive locations
 */
export function containsSensitivePath(args: Record<string, unknown>): boolean {
	const sensitivePatterns = [
		/\/etc\//,
		/\/var\/log\//,
		/\.ssh\//,
		/\.aws\//,
		/\.env/,
		/credentials/i,
		/secrets?/i,
		/password/i,
		/token/i,
		/private[_-]?key/i,
	];

	const checkValue = (value: unknown): boolean => {
		if (typeof value === "string") {
			return sensitivePatterns.some((p) => p.test(value));
		}
		if (Array.isArray(value)) {
			return value.some(checkValue);
		}
		if (value && typeof value === "object") {
			return Object.values(value).some(checkValue);
		}
		return false;
	};

	return checkValue(args);
}
