/**
 * Input Validation - Message and command validation utilities
 *
 * Provides configurable validation for user inputs before processing.
 */

export interface ValidationConfig {
	/** Max message length in characters (default: 16000) */
	maxMessageLength: number;
	/** Max attachment count per message (default: 10) */
	maxAttachments: number;
	/** Max file size for attachments in bytes (default: 25MB) */
	maxFileSize: number;
}

export interface ValidationResult {
	valid: boolean;
	error?: string;
	/** Truncated text if message was too long */
	truncatedText?: string;
}

const DEFAULT_CONFIG: ValidationConfig = {
	maxMessageLength: 16_000, // ~4000 tokens
	maxAttachments: 10,
	maxFileSize: 25 * 1024 * 1024, // 25MB
};

/**
 * Validate and optionally truncate a message
 */
export function validateMessage(
	text: string,
	config: Partial<ValidationConfig> = {},
): ValidationResult {
	const cfg = { ...DEFAULT_CONFIG, ...config };

	if (!text || text.trim().length === 0) {
		return { valid: false, error: "Empty message" };
	}

	if (text.length > cfg.maxMessageLength) {
		const truncated = text.substring(0, cfg.maxMessageLength);
		return {
			valid: true,
			truncatedText: truncated,
			error: `Message truncated from ${text.length} to ${cfg.maxMessageLength} characters`,
		};
	}

	return { valid: true };
}

/**
 * Validate attachments
 */
export function validateAttachments(
	attachments: Array<{ size?: number; name?: string }>,
	config: Partial<ValidationConfig> = {},
): ValidationResult {
	const cfg = { ...DEFAULT_CONFIG, ...config };

	if (attachments.length > cfg.maxAttachments) {
		return {
			valid: false,
			error: `Too many attachments: ${attachments.length} (max: ${cfg.maxAttachments})`,
		};
	}

	for (const attachment of attachments) {
		if (attachment.size && attachment.size > cfg.maxFileSize) {
			const sizeMB = (attachment.size / (1024 * 1024)).toFixed(1);
			const maxMB = (cfg.maxFileSize / (1024 * 1024)).toFixed(0);
			return {
				valid: false,
				error: `Attachment "${attachment.name || "file"}" is too large: ${sizeMB}MB (max: ${maxMB}MB)`,
			};
		}
	}

	return { valid: true };
}

/**
 * Sanitize text for safe logging (remove sensitive patterns)
 */
export function sanitizeForLogging(text: string): string {
	// Mask API keys and tokens
	return text
		.replace(/sk-[a-zA-Z0-9_-]{10,}/g, "sk-***") // Anthropic keys (sk-ant-api0X-xxx format)
		.replace(/xoxb-[a-zA-Z0-9-]+/g, "xoxb-***")
		.replace(/xapp-[a-zA-Z0-9-]+/g, "xapp-***")
		.replace(/Bearer\s+[a-zA-Z0-9._-]+/gi, "Bearer ***");
}

/**
 * Validate a channel ID format
 */
export function isValidChannelId(id: string): boolean {
	// Slack channel IDs start with C (public), G (private), or D (DM)
	return /^[CGD][A-Z0-9]{8,}$/i.test(id);
}

/**
 * Validate a user ID format
 */
export function isValidUserId(id: string): boolean {
	// Slack user IDs start with U or W
	return /^[UW][A-Z0-9]{8,}$/i.test(id);
}

/**
 * Create an input validator with custom config
 */
export function createValidator(config: Partial<ValidationConfig> = {}) {
	const cfg = { ...DEFAULT_CONFIG, ...config };

	return {
		validateMessage: (text: string) => validateMessage(text, cfg),
		validateAttachments: (attachments: Array<{ size?: number; name?: string }>) =>
			validateAttachments(attachments, cfg),
		config: cfg,
	};
}
