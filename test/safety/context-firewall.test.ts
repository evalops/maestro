import { describe, expect, it } from "vitest";
import {
	checkContextFirewall,
	containsHighSeverityContent,
	detectSensitiveContent,
	sanitizePayload,
} from "../../src/safety/context-firewall.js";

// Split tokens to avoid triggering secret scanners in the repo.
const joinParts = (...parts: string[]) => parts.join("");
const SAMPLE_OPENAI_KEY = joinParts(
	"sk",
	"-",
	"abc123def456ghi789jkl012mno345pqr678",
);
const SAMPLE_ANTHROPIC_KEY = joinParts(
	"sk",
	"-",
	"ant",
	"-",
	"api03",
	"-",
	"abcdefghijklmnopqrstuvwxyz",
);
const SAMPLE_GITHUB_TOKEN = joinParts(
	"gh",
	"p_",
	"abcdefghijklmnopqrstuvwxyz1234567890",
);
const SAMPLE_AWS_ACCESS_KEY = joinParts("AK", "IA", "IOSFODNN7", "EXAMPLE");
const SAMPLE_RSA_PRIVATE_KEY = joinParts(
	"-----BEGIN ",
	["RSA", "PRIVATE", "KEY"].join(" "),
	"-----\nMIIEpAIBAAKCAQEA...",
);
const SAMPLE_JWT_TOKEN = joinParts(
	"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
	".",
	"eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ",
	".",
	"SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
);
const SAMPLE_JWT_SHORT = joinParts(
	"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
	".",
	"eyJzdWIiOiIxMjM0NTY3ODkwIn0",
	".",
	"dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
);

describe("context-firewall", () => {
	describe("detectSensitiveContent", () => {
		it("detects OpenAI API keys", () => {
			const payload = { key: SAMPLE_OPENAI_KEY };
			const findings = detectSensitiveContent(payload);
			expect(findings.some((f) => f.type === "api_key")).toBe(true);
		});

		it("detects Anthropic API keys", () => {
			const payload = { key: SAMPLE_ANTHROPIC_KEY };
			const findings = detectSensitiveContent(payload);
			expect(findings.some((f) => f.type === "api_key")).toBe(true);
		});

		it("detects GitHub tokens", () => {
			const payload = { token: SAMPLE_GITHUB_TOKEN };
			const findings = detectSensitiveContent(payload);
			expect(findings.some((f) => f.type === "api_key")).toBe(true);
		});

		it("detects AWS access key IDs", () => {
			const payload = { accessKey: SAMPLE_AWS_ACCESS_KEY };
			const findings = detectSensitiveContent(payload);
			expect(findings.some((f) => f.type === "aws_secret")).toBe(true);
		});

		it("detects private keys", () => {
			const payload = {
				key: SAMPLE_RSA_PRIVATE_KEY,
			};
			const findings = detectSensitiveContent(payload);
			expect(findings.some((f) => f.type === "private_key")).toBe(true);
		});

		it("detects JWT tokens", () => {
			const payload = {
				token: SAMPLE_JWT_TOKEN,
			};
			const findings = detectSensitiveContent(payload);
			expect(findings.some((f) => f.type === "jwt_token")).toBe(true);
		});

		it("detects passwords in URLs", () => {
			const payload = { url: "https://user:secretpassword@example.com/api" };
			const findings = detectSensitiveContent(payload);
			expect(findings.some((f) => f.type === "password")).toBe(true);
		});

		it("detects control characters", () => {
			const payload = { data: "Hello\x00World\x1F" };
			const findings = detectSensitiveContent(payload);
			expect(findings.some((f) => f.type === "control_char")).toBe(true);
		});

		it("detects sensitive key names", () => {
			const payload = { api_key: "some-value", password: "secret123" };
			const findings = detectSensitiveContent(payload);
			expect(findings.some((f) => f.type === "generic_secret")).toBe(true);
		});

		it("handles deeply nested objects", () => {
			const payload = {
				level1: {
					level2: {
						level3: {
							secret: SAMPLE_OPENAI_KEY,
						},
					},
				},
			};
			const findings = detectSensitiveContent(payload);
			expect(findings.some((f) => f.type === "api_key")).toBe(true);
			expect(findings.some((f) => f.path.includes("level3"))).toBe(true);
		});

		it("handles arrays", () => {
			const payload = {
				keys: ["normal-value", SAMPLE_OPENAI_KEY, "another-value"],
			};
			const findings = detectSensitiveContent(payload);
			expect(findings.some((f) => f.type === "api_key")).toBe(true);
		});

		it("returns empty for safe payloads", () => {
			const payload = { name: "John", age: 30, active: true };
			const findings = detectSensitiveContent(payload);
			expect(findings).toHaveLength(0);
		});
	});

	describe("sanitizePayload", () => {
		it("removes control characters", () => {
			const payload = { data: "Hello\x00World\x1F!" };
			const sanitized = sanitizePayload(payload) as { data: string };
			expect(sanitized.data).toBe("HelloWorld!");
		});

		it("redacts API keys", () => {
			const payload = { key: SAMPLE_OPENAI_KEY };
			const sanitized = sanitizePayload(payload) as { key: string };
			expect(sanitized.key).toContain("[REDACTED:");
			expect(sanitized.key).not.toContain("abc123def456");
		});

		it("truncates long strings", () => {
			// Use a string that won't match base64 pattern (contains spaces/punctuation)
			const longString = "Hello world! This is a test. ".repeat(200);
			const payload = { data: longString };
			const sanitized = sanitizePayload(payload) as { data: string };
			expect(sanitized.data.length).toBeLessThan(longString.length);
			expect(sanitized.data).toContain("[truncated:");
		});

		it("truncates large base64 blobs", () => {
			const base64Blob = "A".repeat(2000);
			const payload = { data: base64Blob };
			const sanitized = sanitizePayload(payload) as { data: string };
			expect(sanitized.data.length).toBeLessThan(2000);
			expect(sanitized.data).toContain("[base64:");
		});

		it("truncates long arrays", () => {
			const longArray = Array.from({ length: 150 }, (_, i) => i);
			const payload = { items: longArray };
			const sanitized = sanitizePayload(payload) as { items: unknown[] };
			expect(sanitized.items.length).toBeLessThan(150);
		});

		it("handles max depth", () => {
			// Create deeply nested object
			let obj: Record<string, unknown> = { value: "test" };
			for (let i = 0; i < 25; i++) {
				obj = { nested: obj };
			}
			const sanitized = sanitizePayload(obj) as Record<string, unknown>;
			// Should not throw, and deep values should be replaced
			expect(sanitized).toBeDefined();
		});

		it("preserves safe values", () => {
			const payload = {
				name: "John",
				age: 30,
				active: true,
				items: [1, 2, 3],
			};
			const sanitized = sanitizePayload(payload);
			expect(sanitized).toEqual(payload);
		});

		it("handles null and undefined", () => {
			const payload = { a: null, b: undefined, c: "test" };
			const sanitized = sanitizePayload(payload) as Record<string, unknown>;
			expect(sanitized.a).toBeNull();
			expect(sanitized.b).toBeUndefined();
			expect(sanitized.c).toBe("test");
		});

		it("respects options", () => {
			const payload = { data: "Hello\x00World" };
			const sanitized = sanitizePayload(payload, {
				removeControlChars: false,
			}) as { data: string };
			expect(sanitized.data).toBe("Hello\x00World");
		});
	});

	describe("containsHighSeverityContent", () => {
		it("returns true for API keys", () => {
			const payload = { key: SAMPLE_OPENAI_KEY };
			expect(containsHighSeverityContent(payload)).toBe(true);
		});

		it("returns true for private keys", () => {
			const payload = { key: SAMPLE_RSA_PRIVATE_KEY };
			expect(containsHighSeverityContent(payload)).toBe(true);
		});

		it("returns false for JWT tokens (medium severity)", () => {
			const payload = {
				token: SAMPLE_JWT_SHORT,
			};
			expect(containsHighSeverityContent(payload)).toBe(false);
		});

		it("returns false for safe content", () => {
			const payload = { name: "John", email: "john@example.com" };
			expect(containsHighSeverityContent(payload)).toBe(false);
		});
	});

	describe("checkContextFirewall", () => {
		it("allows safe payloads", () => {
			const payload = { name: "John", count: 42 };
			const result = checkContextFirewall(payload);
			expect(result.allowed).toBe(true);
			expect(result.blocked).toBeFalsy();
			expect(result.findings).toHaveLength(0);
		});

		it("sanitizes and allows medium severity content", () => {
			const payload = {
				token: SAMPLE_JWT_SHORT,
			};
			const result = checkContextFirewall(payload);
			expect(result.allowed).toBe(true);
			expect(result.findings.length).toBeGreaterThan(0);
		});

		it("blocks high severity content when option enabled", () => {
			const payload = { key: SAMPLE_OPENAI_KEY };
			const result = checkContextFirewall(payload, { blockHighSeverity: true });
			expect(result.allowed).toBe(false);
			expect(result.blocked).toBe(true);
			expect(result.blockReason).toContain("High-severity");
		});

		it("allows high severity content when blocking disabled", () => {
			const payload = { key: SAMPLE_OPENAI_KEY };
			const result = checkContextFirewall(payload, {
				blockHighSeverity: false,
			});
			expect(result.allowed).toBe(true);
			expect(result.findings.length).toBeGreaterThan(0);
		});

		it("returns sanitized payload", () => {
			const payload = { key: SAMPLE_OPENAI_KEY };
			const result = checkContextFirewall(payload);
			const sanitized = result.sanitizedPayload as { key: string };
			expect(sanitized.key).toContain("[REDACTED:");
		});
	});
});
