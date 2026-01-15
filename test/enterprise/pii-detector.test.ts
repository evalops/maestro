import { describe, expect, it } from "vitest";
import {
	PiiDetector,
	getGlobalPiiDetector,
	hasPii,
	redactPii,
} from "../../src/security/pii-detector.js";

// Split tokens to avoid triggering secret scanners in the repo.
const joinParts = (...parts: string[]) => parts.join("");
const SAMPLE_AWS_ACCESS_KEY = joinParts("AK", "IA", "IOSFODNN7", "EXAMPLE");
const SAMPLE_GITHUB_TOKEN = joinParts(
	"gh",
	"p_",
	"1234567890abcdefghijklmnopqrstuvwxyz",
);

describe("PII Detector", () => {
	describe("email detection", () => {
		it("detects email addresses", () => {
			const detector = new PiiDetector();
			const text = "Contact me at john.doe@example.com for details";
			const result = detector.detect(text);
			expect(result.hasPii).toBe(true);
			expect(result.patterns).toContain("email");
		});

		it("redacts email addresses", () => {
			const text = "Contact me at john.doe@example.com";
			const result = redactPii(text);
			expect(result).not.toContain("john.doe@example.com");
			expect(result).toContain("[EMAIL_REDACTED]");
		});
	});

	describe("phone number detection", () => {
		it("detects US phone numbers", () => {
			const detector = new PiiDetector();
			const text = "Call me at 555-123-4567";
			const result = detector.detect(text);
			expect(result.hasPii).toBe(true);
			expect(result.patterns).toContain("phone_us");
		});

		it("redacts phone with parentheses", () => {
			const text = "Phone: (555) 123-4567";
			const result = redactPii(text);
			expect(result).toContain("[PHONE_REDACTED]");
		});
	});

	describe("SSN detection", () => {
		it("detects social security numbers", () => {
			const detector = new PiiDetector();
			const text = "SSN: 123-45-6789";
			const result = detector.detect(text);
			expect(result.hasPii).toBe(true);
			expect(result.patterns).toContain("ssn");
		});

		it("redacts SSN", () => {
			const text = "SSN: 123-45-6789";
			const result = redactPii(text);
			expect(result).not.toContain("123-45-6789");
			expect(result).toContain("[SSN_REDACTED]");
		});
	});

	describe("credit card detection", () => {
		it("detects Visa card numbers", () => {
			const detector = new PiiDetector();
			const text = "Card: 4111111111111111";
			const result = detector.detect(text);
			expect(result.hasPii).toBe(true);
			expect(result.patterns).toContain("credit_card");
		});

		it("redacts credit card numbers", () => {
			const detector = new PiiDetector();
			const result = detector.redact("Card: 4111111111111111");
			expect(result.hasPii).toBe(true);
			expect(result.redactedContent).toContain("[CREDIT_CARD_REDACTED]");
		});
	});

	describe("API key detection", () => {
		it("detects AWS access keys", () => {
			const detector = new PiiDetector();
			const text = `AWS key: ${SAMPLE_AWS_ACCESS_KEY}`;
			const result = detector.detect(text);
			expect(result.hasPii).toBe(true);
			expect(result.patterns).toContain("aws_access_key");
		});

		it("detects GitHub tokens", () => {
			const detector = new PiiDetector();
			const text = `Token: ${SAMPLE_GITHUB_TOKEN}`;
			const result = detector.detect(text);
			expect(result.hasPii).toBe(true);
			expect(result.patterns).toContain("github_token");
		});
	});

	describe("JWT detection", () => {
		it("detects JWT tokens", () => {
			const detector = new PiiDetector();
			const text =
				"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
			const result = detector.detect(text);
			expect(result.hasPii).toBe(true);
			expect(result.patterns).toContain("jwt");
		});
	});

	describe("hasPii helper", () => {
		it("returns true when PII is present", () => {
			expect(hasPii("Email: test@example.com")).toBe(true);
		});

		it("returns false when no PII is present", () => {
			expect(hasPii("Hello world")).toBe(false);
		});
	});

	describe("multiple PII types", () => {
		it("detects multiple types in single text", () => {
			const detector = new PiiDetector();
			const text =
				"Contact john@example.com or call 555-123-4567, SSN: 123-45-6789";
			const result = detector.detect(text);
			expect(result.hasPii).toBe(true);
			expect(result.patterns).toContain("email");
			expect(result.patterns).toContain("phone_us");
			expect(result.patterns).toContain("ssn");
		});

		it("redacts all PII types", () => {
			const text = "Email: test@example.com, Phone: 555-123-4567";
			const result = redactPii(text);
			expect(result).not.toContain("test@example.com");
			expect(result).not.toContain("555-123-4567");
		});
	});

	describe("PiiDetector class", () => {
		it("redacts objects recursively", () => {
			const detector = new PiiDetector();
			const obj = {
				email: "test@example.com",
				nested: {
					phone: "555-123-4567",
				},
			};

			const redacted = detector.redactObject(obj);
			expect(redacted.email).toContain("[EMAIL_REDACTED]");
			expect(redacted.nested.phone).toContain("[PHONE_REDACTED]");
		});

		it("handles text without PII", () => {
			const detector = new PiiDetector();
			const result = detector.detect("Hello world");
			expect(result.hasPii).toBe(false);
			expect(result.patterns).toHaveLength(0);
		});
	});

	describe("getGlobalPiiDetector", () => {
		it("returns singleton instance", () => {
			const detector1 = getGlobalPiiDetector();
			const detector2 = getGlobalPiiDetector();
			expect(detector1).toBe(detector2);
		});
	});
});
