/**
 * Tests for the unified error hierarchy
 */

import { describe, expect, it } from "vitest";
import {
	ApiError,
	ApprovalDeniedError,
	ComposerError,
	ConfigError,
	DirectoryAccessError,
	FileNotFoundError,
	FileSystemError,
	InternalError,
	JsonParseError,
	MissingConfigError,
	NetworkError,
	PathValidationError,
	PermissionError,
	SessionError,
	SessionNotFoundError,
	SessionParseError,
	TimeoutError,
	ToolExecutionError,
	ToolValidationError,
	ValidationError,
	getErrorMessage,
	isComposerError,
	isRetriableError,
	wrapError,
} from "../../src/errors/index.js";

describe("Error Hierarchy", () => {
	describe("ComposerError", () => {
		it("should create error with all properties", () => {
			const error = new ComposerError("Test error", {
				code: "TEST_ERROR",
				category: "internal",
				severity: "warning",
				retriable: true,
				context: { foo: "bar" },
			});

			expect(error.message).toBe("Test error");
			expect(error.code).toBe("TEST_ERROR");
			expect(error.category).toBe("internal");
			expect(error.severity).toBe("warning");
			expect(error.retriable).toBe(true);
			expect(error.context).toEqual({ foo: "bar" });
			expect(error.name).toBe("ComposerError");
		});

		it("should use default values", () => {
			const error = new ComposerError("Test error", {
				code: "TEST_ERROR",
				category: "internal",
			});

			expect(error.severity).toBe("error");
			expect(error.retriable).toBe(false);
			expect(error.context).toEqual({});
		});

		it("should chain cause errors", () => {
			const cause = new Error("Original error");
			const error = new ComposerError("Wrapped error", {
				code: "WRAPPED",
				category: "internal",
				cause,
			});

			expect(error.cause).toBe(cause);
		});

		it("should serialize to JSON", () => {
			const error = new ComposerError("Test error", {
				code: "TEST_ERROR",
				category: "validation",
				context: { field: "name" },
			});

			const json = error.toJSON();
			expect(json.name).toBe("ComposerError");
			expect(json.code).toBe("TEST_ERROR");
			expect(json.category).toBe("validation");
			expect(json.message).toBe("Test error");
			expect(json.context).toEqual({ field: "name" });
		});

		it("should generate user-friendly message", () => {
			const error = new ComposerError("Operation failed", {
				code: "OP_FAILED",
				category: "network",
				retriable: true,
			});

			expect(error.toUserMessage()).toContain("Operation failed");
			expect(error.toUserMessage()).toContain("try again");
		});

		it("should be instanceof Error", () => {
			const error = new ComposerError("Test", {
				code: "TEST",
				category: "internal",
			});

			expect(error instanceof Error).toBe(true);
			expect(error instanceof ComposerError).toBe(true);
		});
	});

	describe("ValidationError", () => {
		it("should create validation error with field info", () => {
			const error = new ValidationError("Invalid email", {
				field: "email",
				value: "not-an-email",
				expected: "valid email address",
			});

			expect(error.code).toBe("VALIDATION_ERROR");
			expect(error.category).toBe("validation");
			expect(error.context.field).toBe("email");
			expect(error.context.value).toBe("not-an-email");
			expect(error.context.expected).toBe("valid email address");
			expect(error.retriable).toBe(false);
		});
	});

	describe("JsonParseError", () => {
		it("should create JSON parse error", () => {
			const error = new JsonParseError("Invalid JSON", {
				input: '{"broken',
				position: 7,
			});

			expect(error.name).toBe("JsonParseError");
			expect(error.context.input).toBe('{"broken');
			expect(error.context.position).toBe(7);
		});

		it("should truncate long input", () => {
			const longInput = "x".repeat(200);
			const error = new JsonParseError("Invalid JSON", {
				input: longInput,
			});

			expect((error.context.input as string).length).toBe(100);
		});
	});

	describe("PathValidationError", () => {
		it("should create path validation error", () => {
			const error = new PathValidationError("Invalid path", {
				path: "/etc/passwd",
				reason: "path outside workspace",
			});

			expect(error.name).toBe("PathValidationError");
			expect(error.context.value).toBe("/etc/passwd");
			expect(error.context.expected).toBe("path outside workspace");
		});
	});

	describe("PermissionError", () => {
		it("should create permission error", () => {
			const error = new PermissionError("Access denied", {
				resource: "/secret/file",
				action: "read",
				reason: "insufficient permissions",
			});

			expect(error.code).toBe("PERMISSION_DENIED");
			expect(error.category).toBe("permission");
			expect(error.context.resource).toBe("/secret/file");
			expect(error.context.action).toBe("read");
		});
	});

	describe("DirectoryAccessError", () => {
		it("should create directory access error", () => {
			const error = new DirectoryAccessError("Cannot access directory", {
				path: "/root",
				action: "write",
			});

			expect(error.name).toBe("DirectoryAccessError");
			expect(error.context.resource).toBe("/root");
			expect(error.context.action).toBe("write");
		});
	});

	describe("ApprovalDeniedError", () => {
		it("should create approval denied error", () => {
			const error = new ApprovalDeniedError("Action not approved", {
				action: "rm -rf /",
				policy: "dangerous command blocked",
			});

			expect(error.name).toBe("ApprovalDeniedError");
			expect(error.context.action).toBe("rm -rf /");
			expect(error.context.reason).toBe("dangerous command blocked");
		});
	});

	describe("NetworkError", () => {
		it("should create network error", () => {
			const error = new NetworkError("Connection failed", {
				url: "https://api.example.com",
				statusCode: 503,
			});

			expect(error.code).toBe("NETWORK_ERROR");
			expect(error.category).toBe("network");
			expect(error.context.url).toBe("https://api.example.com");
			expect(error.retriable).toBe(true);
		});

		it("should allow non-retriable network errors", () => {
			const error = new NetworkError("Invalid request", {
				retriable: false,
			});

			expect(error.retriable).toBe(false);
		});
	});

	describe("ApiError", () => {
		it("should create API error with status code", () => {
			const error = new ApiError(404, "Not found", {
				url: "/api/users/123",
			});

			expect(error.statusCode).toBe(404);
			expect(error.retriable).toBe(false);
		});

		it("should be retriable for 5xx errors", () => {
			const error = new ApiError(500, "Internal server error");
			expect(error.retriable).toBe(true);
			expect(error.isServerError()).toBe(true);
		});

		it("should be retriable for rate limit errors", () => {
			const error = new ApiError(429, "Rate limited");
			expect(error.retriable).toBe(true);
			expect(error.isRateLimited()).toBe(true);
		});

		it("should not be retriable for 4xx errors", () => {
			const error = new ApiError(400, "Bad request");
			expect(error.retriable).toBe(false);
		});
	});

	describe("TimeoutError", () => {
		it("should create timeout error", () => {
			const error = new TimeoutError("Operation timed out", {
				operation: "API call",
				timeoutMs: 30000,
			});

			expect(error.code).toBe("TIMEOUT");
			expect(error.category).toBe("timeout");
			expect(error.retriable).toBe(true);
			expect(error.context.operation).toBe("API call");
			expect(error.context.timeoutMs).toBe(30000);
		});
	});

	describe("FileSystemError", () => {
		it("should create filesystem error", () => {
			const error = new FileSystemError("Cannot read file", {
				path: "/foo/bar.txt",
				operation: "read",
				errno: -2,
				syscall: "open",
			});

			expect(error.code).toBe("FILESYSTEM_ERROR");
			expect(error.category).toBe("filesystem");
			expect(error.context.path).toBe("/foo/bar.txt");
			expect(error.context.errno).toBe(-2);
		});
	});

	describe("FileNotFoundError", () => {
		it("should create file not found error", () => {
			const error = new FileNotFoundError("/missing/file.txt");

			expect(error.name).toBe("FileNotFoundError");
			expect(error.message).toBe("File not found: /missing/file.txt");
			expect(error.context.path).toBe("/missing/file.txt");
		});
	});

	describe("ToolExecutionError", () => {
		it("should create tool execution error", () => {
			const error = new ToolExecutionError("bash", "Command failed", {
				parameters: { command: "ls -la" },
			});

			expect(error.code).toBe("TOOL_BASH_FAILED");
			expect(error.category).toBe("tool");
			expect(error.context.toolName).toBe("bash");
			expect(error.context.parameters).toEqual({ command: "ls -la" });
		});
	});

	describe("ToolValidationError", () => {
		it("should create tool validation error", () => {
			const error = new ToolValidationError("read", "Invalid path", {
				parameter: "path",
				value: "",
				expected: "non-empty string",
			});

			expect(error.name).toBe("ToolValidationError");
			expect(error.context.toolName).toBe("read");
			expect(error.context.parameters).toEqual({ path: "" });
			expect(error.context.expected).toBe("non-empty string");
		});
	});

	describe("SessionError", () => {
		it("should create session error", () => {
			const error = new SessionError("Session corrupted", {
				sessionId: "abc123",
				operation: "save",
			});

			expect(error.code).toBe("SESSION_ERROR");
			expect(error.category).toBe("session");
			expect(error.context.sessionId).toBe("abc123");
		});
	});

	describe("SessionNotFoundError", () => {
		it("should create session not found error", () => {
			const error = new SessionNotFoundError("session-xyz");

			expect(error.name).toBe("SessionNotFoundError");
			expect(error.message).toBe("Session not found: session-xyz");
		});
	});

	describe("ConfigError", () => {
		it("should create config error", () => {
			const error = new ConfigError("Invalid configuration", {
				configKey: "apiKey",
				configFile: "~/.composer/config.json",
			});

			expect(error.code).toBe("CONFIG_ERROR");
			expect(error.category).toBe("config");
			expect(error.context.configKey).toBe("apiKey");
		});
	});

	describe("MissingConfigError", () => {
		it("should create missing config error", () => {
			const error = new MissingConfigError("ANTHROPIC_API_KEY");

			expect(error.name).toBe("MissingConfigError");
			expect(error.message).toBe(
				"Missing required configuration: ANTHROPIC_API_KEY",
			);
		});
	});

	describe("InternalError", () => {
		it("should create internal error", () => {
			const error = new InternalError("Unexpected state", {
				component: "AgentRuntime",
			});

			expect(error.code).toBe("INTERNAL_ERROR");
			expect(error.category).toBe("internal");
			expect(error.context.component).toBe("AgentRuntime");
		});
	});

	describe("Utility Functions", () => {
		describe("isComposerError", () => {
			it("should return true for ComposerError instances", () => {
				const error = new ComposerError("Test", {
					code: "TEST",
					category: "internal",
				});
				expect(isComposerError(error)).toBe(true);
			});

			it("should return true for subclasses", () => {
				const error = new ValidationError("Invalid");
				expect(isComposerError(error)).toBe(true);
			});

			it("should return false for regular errors", () => {
				const error = new Error("Regular error");
				expect(isComposerError(error)).toBe(false);
			});

			it("should return false for non-errors", () => {
				expect(isComposerError("string")).toBe(false);
				expect(isComposerError(null)).toBe(false);
				expect(isComposerError(undefined)).toBe(false);
			});
		});

		describe("isRetriableError", () => {
			it("should return true for retriable ComposerErrors", () => {
				const error = new NetworkError("Timeout");
				expect(isRetriableError(error)).toBe(true);
			});

			it("should return false for non-retriable ComposerErrors", () => {
				const error = new ValidationError("Invalid");
				expect(isRetriableError(error)).toBe(false);
			});

			it("should return true for ECONNRESET errors", () => {
				const error = new Error("Connection reset") as NodeJS.ErrnoException;
				error.code = "ECONNRESET";
				expect(isRetriableError(error)).toBe(true);
			});

			it("should return true for ETIMEDOUT errors", () => {
				const error = new Error("Timed out") as NodeJS.ErrnoException;
				error.code = "ETIMEDOUT";
				expect(isRetriableError(error)).toBe(true);
			});

			it("should return false for regular errors", () => {
				const error = new Error("Regular error");
				expect(isRetriableError(error)).toBe(false);
			});
		});

		describe("wrapError", () => {
			it("should return ComposerError unchanged", () => {
				const error = new ValidationError("Invalid");
				const wrapped = wrapError(error);
				expect(wrapped).toBe(error);
			});

			it("should wrap regular errors", () => {
				const error = new Error("Original");
				const wrapped = wrapError(error, "Wrapped message");

				expect(wrapped.message).toBe("Wrapped message");
				expect(wrapped.cause).toBe(error);
				expect(wrapped.code).toBe("WRAPPED_ERROR");
			});

			it("should wrap non-error values", () => {
				const wrapped = wrapError("string error");

				expect(wrapped.message).toBe("string error");
				expect(wrapped.cause?.message).toBe("string error");
			});

			it("should use specified category", () => {
				const wrapped = wrapError(new Error("Test"), "Wrapped", "filesystem");
				expect(wrapped.category).toBe("filesystem");
			});
		});

		describe("getErrorMessage", () => {
			it("should get message from ComposerError", () => {
				const error = new ComposerError("Test error", {
					code: "TEST",
					category: "internal",
					retriable: true,
				});
				const message = getErrorMessage(error);

				expect(message).toContain("Test error");
				expect(message).toContain("try again");
			});

			it("should get message from regular Error", () => {
				const error = new Error("Regular error");
				expect(getErrorMessage(error)).toBe("Regular error");
			});

			it("should convert non-errors to string", () => {
				expect(getErrorMessage("string")).toBe("string");
				expect(getErrorMessage(123)).toBe("123");
			});
		});
	});

	describe("Error inheritance", () => {
		it("all errors should be instanceof ComposerError", () => {
			const errors = [
				new ValidationError("test"),
				new JsonParseError("test"),
				new PathValidationError("test"),
				new PermissionError("test"),
				new DirectoryAccessError("test"),
				new ApprovalDeniedError("test"),
				new NetworkError("test"),
				new ApiError(500, "test"),
				new TimeoutError("test"),
				new FileSystemError("test"),
				new FileNotFoundError("/test"),
				new ToolExecutionError("test", "test"),
				new ToolValidationError("test", "test"),
				new SessionError("test"),
				new SessionParseError("test"),
				new SessionNotFoundError("test"),
				new ConfigError("test"),
				new MissingConfigError("test"),
				new InternalError("test"),
			];

			for (const error of errors) {
				expect(error instanceof ComposerError).toBe(true);
				expect(error instanceof Error).toBe(true);
			}
		});
	});
});
