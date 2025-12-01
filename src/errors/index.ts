/**
 * Unified error hierarchy for Composer
 *
 * This module provides a standardized error system with:
 * - Consistent error codes and categories
 * - Structured context for debugging
 * - Retry hints for recoverable errors
 * - Proper error chaining
 */

/**
 * Error severity levels
 */
export type ErrorSeverity = "error" | "warning" | "info";

/**
 * Error categories for grouping related errors
 */
export type ErrorCategory =
	| "validation"
	| "permission"
	| "network"
	| "timeout"
	| "filesystem"
	| "tool"
	| "session"
	| "config"
	| "api"
	| "internal";

/**
 * Structured context for errors
 */
export interface ErrorContext {
	[key: string]: unknown;
}

/**
 * Base error class for all Composer errors
 *
 * Provides:
 * - Standardized error codes (e.g., "TOOL_EXECUTION_FAILED")
 * - Error categories for grouping
 * - Severity levels
 * - Retry hints
 * - Structured context
 * - Cause chaining
 */
export class ComposerError extends Error {
	readonly code: string;
	readonly category: ErrorCategory;
	readonly severity: ErrorSeverity;
	readonly retriable: boolean;
	readonly context: ErrorContext;
	override readonly cause?: Error;

	constructor(
		message: string,
		options: {
			code: string;
			category: ErrorCategory;
			severity?: ErrorSeverity;
			retriable?: boolean;
			context?: ErrorContext;
			cause?: Error;
		},
	) {
		super(message);
		this.name = "ComposerError";
		this.code = options.code;
		this.category = options.category;
		this.severity = options.severity ?? "error";
		this.retriable = options.retriable ?? false;
		this.context = options.context ?? {};
		this.cause = options.cause;

		// Maintain proper prototype chain
		Object.setPrototypeOf(this, new.target.prototype);
	}

	/**
	 * Create a structured JSON representation for logging
	 */
	toJSON(): Record<string, unknown> {
		return {
			name: this.name,
			code: this.code,
			category: this.category,
			severity: this.severity,
			message: this.message,
			retriable: this.retriable,
			context: Object.keys(this.context).length > 0 ? this.context : undefined,
			cause: this.cause?.message,
			stack: this.stack,
		};
	}

	/**
	 * Create a user-friendly error message
	 */
	toUserMessage(): string {
		const parts = [this.message];
		if (this.retriable) {
			parts.push("This error may be temporary - please try again.");
		}
		return parts.join(" ");
	}
}

// ============================================================================
// Validation Errors
// ============================================================================

/**
 * Error for invalid input parameters or data
 */
export class ValidationError extends ComposerError {
	constructor(
		message: string,
		options?: {
			field?: string;
			value?: unknown;
			expected?: string;
			cause?: Error;
		},
	) {
		super(message, {
			code: "VALIDATION_ERROR",
			category: "validation",
			severity: "error",
			retriable: false,
			context: {
				field: options?.field,
				value: options?.value,
				expected: options?.expected,
			},
			cause: options?.cause,
		});
		this.name = "ValidationError";
	}
}

/**
 * Error for invalid JSON parsing
 */
export class JsonParseError extends ValidationError {
	constructor(
		message: string,
		options?: {
			input?: string;
			position?: number;
			cause?: Error;
		},
	) {
		super(message, {
			field: "json",
			expected: "valid JSON",
			cause: options?.cause,
		});
		this.name = "JsonParseError";
		(this.context as Record<string, unknown>).input = options?.input?.slice(
			0,
			100,
		);
		(this.context as Record<string, unknown>).position = options?.position;
	}
}

/**
 * Error for invalid file paths
 */
export class PathValidationError extends ValidationError {
	constructor(
		message: string,
		options?: {
			path?: string;
			reason?: string;
			cause?: Error;
		},
	) {
		super(message, {
			field: "path",
			value: options?.path,
			expected: options?.reason ?? "valid file path",
			cause: options?.cause,
		});
		this.name = "PathValidationError";
	}
}

// ============================================================================
// Permission Errors
// ============================================================================

/**
 * Error for permission/access denied scenarios
 */
export class PermissionError extends ComposerError {
	constructor(
		message: string,
		options?: {
			resource?: string;
			action?: string;
			reason?: string;
			cause?: Error;
		},
	) {
		super(message, {
			code: "PERMISSION_DENIED",
			category: "permission",
			severity: "error",
			retriable: false,
			context: {
				resource: options?.resource,
				action: options?.action,
				reason: options?.reason,
			},
			cause: options?.cause,
		});
		this.name = "PermissionError";
	}
}

/**
 * Error for directory access denied
 */
export class DirectoryAccessError extends PermissionError {
	constructor(
		message: string,
		options?: {
			path?: string;
			action?: string;
			cause?: Error;
		},
	) {
		super(message, {
			resource: options?.path,
			action: options?.action ?? "access",
			reason: "directory access restricted",
			cause: options?.cause,
		});
		this.name = "DirectoryAccessError";
	}
}

/**
 * Error for approval/policy denied
 */
export class ApprovalDeniedError extends PermissionError {
	constructor(
		message: string,
		options?: {
			action?: string;
			policy?: string;
			cause?: Error;
		},
	) {
		super(message, {
			action: options?.action,
			reason: options?.policy ?? "action not approved",
			cause: options?.cause,
		});
		this.name = "ApprovalDeniedError";
	}
}

// ============================================================================
// Network/API Errors
// ============================================================================

/**
 * Error for network-related failures
 */
export class NetworkError extends ComposerError {
	constructor(
		message: string,
		options?: {
			url?: string;
			statusCode?: number;
			retriable?: boolean;
			cause?: Error;
		},
	) {
		super(message, {
			code: "NETWORK_ERROR",
			category: "network",
			severity: "error",
			retriable: options?.retriable ?? true,
			context: {
				url: options?.url,
				statusCode: options?.statusCode,
			},
			cause: options?.cause,
		});
		this.name = "NetworkError";
	}
}

/**
 * Error for API request failures
 */
export class ApiError extends NetworkError {
	readonly statusCode: number;

	constructor(
		statusCode: number,
		message: string,
		options?: {
			url?: string;
			responseBody?: unknown;
			cause?: Error;
		},
	) {
		const retriable = statusCode >= 500 || statusCode === 429;
		super(message, {
			url: options?.url,
			statusCode,
			retriable,
			cause: options?.cause,
		});
		this.name = "ApiError";
		this.statusCode = statusCode;
		(this.context as Record<string, unknown>).responseBody =
			options?.responseBody;
	}

	/**
	 * Check if this is a rate limit error
	 */
	isRateLimited(): boolean {
		return this.statusCode === 429;
	}

	/**
	 * Check if this is a server error
	 */
	isServerError(): boolean {
		return this.statusCode >= 500;
	}
}

// ============================================================================
// Timeout Errors
// ============================================================================

/**
 * Error for operation timeouts
 */
export class TimeoutError extends ComposerError {
	constructor(
		message: string,
		options?: {
			operation?: string;
			timeoutMs?: number;
			cause?: Error;
		},
	) {
		super(message, {
			code: "TIMEOUT",
			category: "timeout",
			severity: "error",
			retriable: true,
			context: {
				operation: options?.operation,
				timeoutMs: options?.timeoutMs,
			},
			cause: options?.cause,
		});
		this.name = "TimeoutError";
	}
}

// ============================================================================
// Filesystem Errors
// ============================================================================

/**
 * Error for filesystem operations
 */
export class FileSystemError extends ComposerError {
	constructor(
		message: string,
		options?: {
			path?: string;
			operation?: string;
			errno?: number;
			syscall?: string;
			cause?: Error;
		},
	) {
		super(message, {
			code: "FILESYSTEM_ERROR",
			category: "filesystem",
			severity: "error",
			retriable: false,
			context: {
				path: options?.path,
				operation: options?.operation,
				errno: options?.errno,
				syscall: options?.syscall,
			},
			cause: options?.cause,
		});
		this.name = "FileSystemError";
	}
}

/**
 * Error when a file is not found
 */
export class FileNotFoundError extends FileSystemError {
	constructor(
		path: string,
		options?: {
			cause?: Error;
		},
	) {
		super(`File not found: ${path}`, {
			path,
			operation: "read",
			cause: options?.cause,
		});
		this.name = "FileNotFoundError";
	}
}

// ============================================================================
// Tool Errors
// ============================================================================

/**
 * Error for tool execution failures
 */
export class ToolExecutionError extends ComposerError {
	constructor(
		toolName: string,
		message: string,
		options?: {
			parameters?: Record<string, unknown>;
			retriable?: boolean;
			cause?: Error;
		},
	) {
		super(message, {
			code: `TOOL_${toolName.toUpperCase()}_FAILED`,
			category: "tool",
			severity: "error",
			retriable: options?.retriable ?? false,
			context: {
				toolName,
				parameters: options?.parameters,
			},
			cause: options?.cause,
		});
		this.name = "ToolExecutionError";
	}
}

/**
 * Error for tool parameter validation failures
 */
export class ToolValidationError extends ToolExecutionError {
	constructor(
		toolName: string,
		message: string,
		options?: {
			parameter?: string;
			value?: unknown;
			expected?: string;
			cause?: Error;
		},
	) {
		super(toolName, message, {
			parameters: options?.parameter
				? { [options.parameter]: options.value }
				: undefined,
			retriable: false,
			cause: options?.cause,
		});
		this.name = "ToolValidationError";
		(this.context as Record<string, unknown>).expected = options?.expected;
	}
}

// ============================================================================
// Session Errors
// ============================================================================

/**
 * Error for session-related failures
 */
export class SessionError extends ComposerError {
	constructor(
		message: string,
		options?: {
			sessionId?: string;
			operation?: string;
			cause?: Error;
		},
	) {
		super(message, {
			code: "SESSION_ERROR",
			category: "session",
			severity: "error",
			retriable: false,
			context: {
				sessionId: options?.sessionId,
				operation: options?.operation,
			},
			cause: options?.cause,
		});
		this.name = "SessionError";
	}
}

/**
 * Error for session parsing failures
 */
export class SessionParseError extends SessionError {
	constructor(
		message: string,
		options?: {
			sessionId?: string;
			cause?: Error;
		},
	) {
		super(message, {
			sessionId: options?.sessionId,
			operation: "parse",
			cause: options?.cause,
		});
		this.name = "SessionParseError";
	}
}

/**
 * Error when a session is not found
 */
export class SessionNotFoundError extends SessionError {
	constructor(
		sessionId: string,
		options?: {
			cause?: Error;
		},
	) {
		super(`Session not found: ${sessionId}`, {
			sessionId,
			operation: "load",
			cause: options?.cause,
		});
		this.name = "SessionNotFoundError";
	}
}

// ============================================================================
// Configuration Errors
// ============================================================================

/**
 * Error for configuration-related failures
 */
export class ConfigError extends ComposerError {
	constructor(
		message: string,
		options?: {
			configKey?: string;
			configFile?: string;
			cause?: Error;
		},
	) {
		super(message, {
			code: "CONFIG_ERROR",
			category: "config",
			severity: "error",
			retriable: false,
			context: {
				configKey: options?.configKey,
				configFile: options?.configFile,
			},
			cause: options?.cause,
		});
		this.name = "ConfigError";
	}
}

/**
 * Error when a required configuration is missing
 */
export class MissingConfigError extends ConfigError {
	constructor(
		configKey: string,
		options?: {
			configFile?: string;
			cause?: Error;
		},
	) {
		super(`Missing required configuration: ${configKey}`, {
			configKey,
			configFile: options?.configFile,
			cause: options?.cause,
		});
		this.name = "MissingConfigError";
	}
}

// ============================================================================
// Internal Errors
// ============================================================================

/**
 * Error for internal/unexpected failures
 */
export class InternalError extends ComposerError {
	constructor(
		message: string,
		options?: {
			component?: string;
			cause?: Error;
		},
	) {
		super(message, {
			code: "INTERNAL_ERROR",
			category: "internal",
			severity: "error",
			retriable: false,
			context: {
				component: options?.component,
			},
			cause: options?.cause,
		});
		this.name = "InternalError";
	}
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Type guard to check if an error is a ComposerError
 */
export function isComposerError(error: unknown): error is ComposerError {
	return error instanceof ComposerError;
}

/**
 * Type guard to check if an error is retriable
 */
export function isRetriableError(error: unknown): boolean {
	if (isComposerError(error)) {
		return error.retriable;
	}
	// Consider ECONNRESET, ETIMEDOUT, etc. as retriable
	if (error instanceof Error) {
		const code = (error as NodeJS.ErrnoException).code;
		return (
			code === "ECONNRESET" ||
			code === "ETIMEDOUT" ||
			code === "ENOTFOUND" ||
			code === "ECONNREFUSED"
		);
	}
	return false;
}

/**
 * Wrap an unknown error in a ComposerError
 */
export function wrapError(
	error: unknown,
	message?: string,
	category: ErrorCategory = "internal",
): ComposerError {
	if (isComposerError(error)) {
		return error;
	}

	const cause = error instanceof Error ? error : new Error(String(error));
	const errorMessage = message ?? cause.message;

	return new ComposerError(errorMessage, {
		code: "WRAPPED_ERROR",
		category,
		cause,
	});
}

/**
 * Extract a user-friendly message from any error
 */
export function getErrorMessage(error: unknown): string {
	if (isComposerError(error)) {
		return error.toUserMessage();
	}
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}
