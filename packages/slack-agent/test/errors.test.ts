import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ApiError,
	ConfigError,
	FileSystemError,
	SlackAgentError,
	ValidationError,
	assertDefined,
	assertValid,
	getErrorMessage,
	getErrorStack,
	isRetryableError,
	logError,
	retryAsync,
	tryAsync,
	trySync,
	wrapError,
} from "../src/errors.js";

describe("SlackAgentError", () => {
	it("creates error with message", () => {
		const error = new SlackAgentError("Something went wrong");

		expect(error.message).toBe("Something went wrong");
		expect(error.name).toBe("SlackAgentError");
		expect(error.code).toBe("UNKNOWN_ERROR");
	});

	it("creates error with options", () => {
		const cause = new Error("Root cause");
		const error = new SlackAgentError("Wrapped error", {
			code: "CUSTOM_CODE",
			cause,
			context: { key: "value" },
		});

		expect(error.code).toBe("CUSTOM_CODE");
		expect(error.cause).toBe(cause);
		expect(error.context).toEqual({ key: "value" });
	});

	it("captures stack trace", () => {
		const error = new SlackAgentError("Test");
		expect(error.stack).toBeDefined();
		expect(error.stack).toContain("SlackAgentError");
	});

	it("serializes to JSON", () => {
		const cause = new Error("Cause");
		const error = new SlackAgentError("Test", {
			code: "TEST",
			cause,
			context: { foo: "bar" },
		});

		const json = error.toJSON();

		expect(json.name).toBe("SlackAgentError");
		expect(json.message).toBe("Test");
		expect(json.code).toBe("TEST");
		expect(json.context).toEqual({ foo: "bar" });
		expect(json.cause).toBeDefined();
		expect((json.cause as Record<string, unknown>).message).toBe("Cause");
	});
});

describe("ApiError", () => {
	it("creates API error with status code", () => {
		const error = new ApiError("Request failed", { statusCode: 500 });

		expect(error.name).toBe("ApiError");
		expect(error.code).toBe("API_ERROR");
		expect(error.statusCode).toBe(500);
	});
});

describe("ConfigError", () => {
	it("creates config error", () => {
		const error = new ConfigError("Missing config", { env: "PROD" });

		expect(error.name).toBe("ConfigError");
		expect(error.code).toBe("CONFIG_ERROR");
		expect(error.context).toEqual({ env: "PROD" });
	});
});

describe("FileSystemError", () => {
	it("creates filesystem error with path", () => {
		const error = new FileSystemError("File not found", { path: "/tmp/test" });

		expect(error.name).toBe("FileSystemError");
		expect(error.code).toBe("FS_ERROR");
		expect(error.path).toBe("/tmp/test");
	});
});

describe("ValidationError", () => {
	it("creates validation error", () => {
		const error = new ValidationError("Invalid input", { field: "email" });

		expect(error.name).toBe("ValidationError");
		expect(error.code).toBe("VALIDATION_ERROR");
		expect(error.context).toEqual({ field: "email" });
	});
});

describe("getErrorMessage", () => {
	it("extracts message from Error", () => {
		const error = new Error("Test message");
		expect(getErrorMessage(error)).toBe("Test message");
	});

	it("returns string directly", () => {
		expect(getErrorMessage("String error")).toBe("String error");
	});

	it("converts other types to string", () => {
		expect(getErrorMessage(42)).toBe("42");
		expect(getErrorMessage({ error: "test" })).toBe("[object Object]");
		expect(getErrorMessage(null)).toBe("null");
	});
});

describe("getErrorStack", () => {
	it("returns stack from Error", () => {
		const error = new Error("Test");
		expect(getErrorStack(error)).toBeDefined();
		expect(getErrorStack(error)).toContain("Test");
	});

	it("returns undefined for non-Error", () => {
		expect(getErrorStack("string")).toBeUndefined();
		expect(getErrorStack(null)).toBeUndefined();
	});
});

describe("wrapError", () => {
	it("wraps Error with context", () => {
		const original = new Error("Original");
		const wrapped = wrapError(original, "Wrapped message", { key: "val" });

		expect(wrapped.message).toBe("Wrapped message");
		expect(wrapped.cause).toBe(original);
		expect(wrapped.context).toEqual({ key: "val" });
	});

	it("wraps string error", () => {
		const wrapped = wrapError("String error", "Wrapped");

		expect(wrapped.message).toBe("Wrapped");
		expect(wrapped.cause?.message).toBe("String error");
	});
});

describe("logError", () => {
	let consoleLogSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		consoleLogSpy.mockRestore();
	});

	it("logs error with operation name", () => {
		const error = new Error("Test error");
		logError("File read", error);

		expect(consoleLogSpy).toHaveBeenCalled();
		const output = consoleLogSpy.mock.calls[0]![0] as string;
		expect(output).toContain("File read failed");
		expect(output).toContain("Test error");
	});

	it("logs with context", () => {
		const error = new Error("Test");
		logError("Operation", error, { path: "/tmp/test" });

		expect(consoleLogSpy).toHaveBeenCalled();
	});
});

describe("tryAsync", () => {
	let consoleLogSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		consoleLogSpy.mockRestore();
	});

	it("returns result on success", async () => {
		const result = await tryAsync("Test", async () => "success");
		expect(result).toBe("success");
	});

	it("returns undefined on failure", async () => {
		const result = await tryAsync("Test", async () => {
			throw new Error("Failed");
		});
		expect(result).toBeUndefined();
	});

	it("returns fallback on failure", async () => {
		const result = await tryAsync(
			"Test",
			async () => {
				throw new Error("Failed");
			},
			{ fallback: "default" },
		);
		expect(result).toBe("default");
	});

	it("logs error by default", async () => {
		await tryAsync("Test op", async () => {
			throw new Error("Error");
		});
		expect(consoleLogSpy).toHaveBeenCalled();
	});

	it("suppresses logging when silent", async () => {
		await tryAsync(
			"Test",
			async () => {
				throw new Error("Error");
			},
			{ silent: true },
		);
		expect(consoleLogSpy).not.toHaveBeenCalled();
	});
});

describe("trySync", () => {
	let consoleLogSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		consoleLogSpy.mockRestore();
	});

	it("returns result on success", () => {
		const result = trySync("Test", () => "success");
		expect(result).toBe("success");
	});

	it("returns undefined on failure", () => {
		const result = trySync("Test", () => {
			throw new Error("Failed");
		});
		expect(result).toBeUndefined();
	});

	it("returns fallback on failure", () => {
		const result = trySync(
			"Test",
			() => {
				throw new Error("Failed");
			},
			{ fallback: "default" },
		);
		expect(result).toBe("default");
	});

	it("logs error by default", () => {
		trySync("Test op", () => {
			throw new Error("Error");
		});
		expect(consoleLogSpy).toHaveBeenCalled();
	});

	it("suppresses logging when silent", () => {
		trySync(
			"Test",
			() => {
				throw new Error("Error");
			},
			{ silent: true },
		);
		expect(consoleLogSpy).not.toHaveBeenCalled();
	});
});

describe("retryAsync", () => {
	let consoleLogSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		consoleLogSpy.mockRestore();
	});

	it("returns on first success", async () => {
		let attempts = 0;
		const result = await retryAsync("Test", async () => {
			attempts++;
			return "success";
		});

		expect(result).toBe("success");
		expect(attempts).toBe(1);
	});

	it("retries on failure when shouldRetry returns true", async () => {
		let attempts = 0;
		const result = await retryAsync(
			"Test",
			async () => {
				attempts++;
				if (attempts < 3) throw new Error("Fail");
				return "success";
			},
			{ maxAttempts: 3, initialDelayMs: 10, shouldRetry: () => true },
		);

		expect(result).toBe("success");
		expect(attempts).toBe(3);
	});

	it("retries on retryable errors by default", async () => {
		let attempts = 0;
		const result = await retryAsync(
			"Test",
			async () => {
				attempts++;
				if (attempts < 2) throw new Error("Connection timeout");
				return "success";
			},
			{ maxAttempts: 3, initialDelayMs: 10 },
		);

		expect(result).toBe("success");
		expect(attempts).toBe(2);
	});

	it("throws after max attempts", async () => {
		let attempts = 0;
		await expect(
			retryAsync(
				"Test",
				async () => {
					attempts++;
					throw new Error("Always fails");
				},
				{ maxAttempts: 2, initialDelayMs: 10, shouldRetry: () => true },
			),
		).rejects.toThrow("Test failed after 2 attempts");
		expect(attempts).toBe(2);
	});

	it("respects shouldRetry predicate", async () => {
		let attempts = 0;
		await expect(
			retryAsync(
				"Test",
				async () => {
					attempts++;
					throw new Error("Not retryable");
				},
				{
					maxAttempts: 3,
					initialDelayMs: 10,
					shouldRetry: () => false, // Never retry
				},
			),
		).rejects.toThrow();
		expect(attempts).toBe(1); // Only tried once
	});
});

describe("isRetryableError", () => {
	it("returns false for non-Error values", () => {
		expect(isRetryableError(null)).toBe(false);
		expect(isRetryableError(undefined)).toBe(false);
		expect(isRetryableError("string")).toBe(false);
		expect(isRetryableError(42)).toBe(false);
		expect(isRetryableError({})).toBe(false);
	});

	it("detects rate limit errors", () => {
		expect(isRetryableError(new Error("Rate limit exceeded"))).toBe(true);
		expect(isRetryableError(new Error("rate limit reached"))).toBe(true);
		expect(isRetryableError(new Error("HTTP 429 Too Many Requests"))).toBe(
			true,
		);
	});

	it("detects timeout errors", () => {
		expect(isRetryableError(new Error("Request timeout"))).toBe(true);
		expect(isRetryableError(new Error("Connection timed out"))).toBe(true);
	});

	it("detects network errors", () => {
		expect(isRetryableError(new Error("Network error"))).toBe(true);
		expect(isRetryableError(new Error("ECONNRESET"))).toBe(true);
		expect(isRetryableError(new Error("ECONNREFUSED"))).toBe(true);
		expect(isRetryableError(new Error("Socket hang up"))).toBe(true);
		expect(isRetryableError(new Error("Fetch failed"))).toBe(true);
	});

	it("detects server errors (5xx)", () => {
		expect(isRetryableError(new Error("HTTP 500"))).toBe(true);
		expect(isRetryableError(new Error("Internal server error"))).toBe(true);
		expect(isRetryableError(new Error("HTTP 502"))).toBe(true);
		expect(isRetryableError(new Error("Bad gateway"))).toBe(true);
		expect(isRetryableError(new Error("HTTP 503"))).toBe(true);
		expect(isRetryableError(new Error("Service unavailable"))).toBe(true);
		expect(isRetryableError(new Error("HTTP 504"))).toBe(true);
	});

	it("detects overload errors", () => {
		expect(isRetryableError(new Error("Server overloaded"))).toBe(true);
		expect(isRetryableError(new Error("At capacity"))).toBe(true);
	});

	it("returns false for non-retryable errors", () => {
		expect(isRetryableError(new Error("Unauthorized"))).toBe(false);
		expect(isRetryableError(new Error("Invalid API key"))).toBe(false);
		expect(isRetryableError(new Error("HTTP 400 Bad Request"))).toBe(false);
		expect(isRetryableError(new Error("HTTP 404 Not Found"))).toBe(false);
	});
});

describe("assertValid", () => {
	it("does not throw when condition is true", () => {
		expect(() => assertValid(true, "Should not throw")).not.toThrow();
	});

	it("throws ValidationError when condition is false", () => {
		expect(() => assertValid(false, "Invalid")).toThrow(ValidationError);
		expect(() => assertValid(false, "Invalid")).toThrow("Invalid");
	});

	it("includes context in error", () => {
		try {
			assertValid(false, "Invalid", { field: "email" });
		} catch (error) {
			expect(error).toBeInstanceOf(ValidationError);
			expect((error as ValidationError).context).toEqual({ field: "email" });
		}
	});

	it("treats truthy values as valid", () => {
		expect(() => assertValid(1, "")).not.toThrow();
		expect(() => assertValid("string", "")).not.toThrow();
		expect(() => assertValid({}, "")).not.toThrow();
	});

	it("treats falsy values as invalid", () => {
		expect(() => assertValid(0, "")).toThrow();
		expect(() => assertValid("", "")).toThrow();
		expect(() => assertValid(null, "")).toThrow();
		expect(() => assertValid(undefined, "")).toThrow();
	});
});

describe("assertDefined", () => {
	it("does not throw for defined values", () => {
		expect(() => assertDefined("value", "")).not.toThrow();
		expect(() => assertDefined(0, "")).not.toThrow();
		expect(() => assertDefined(false, "")).not.toThrow();
		expect(() => assertDefined("", "")).not.toThrow();
	});

	it("throws for undefined", () => {
		expect(() => assertDefined(undefined, "Missing")).toThrow(ValidationError);
		expect(() => assertDefined(undefined, "Missing")).toThrow("Missing");
	});

	it("throws for null", () => {
		expect(() => assertDefined(null, "Missing")).toThrow(ValidationError);
	});
});
