import { describe, expect, it } from "vitest";
import { sanitizeWithStaticMask } from "../../src/utils/secret-redactor.js";

const joinParts = (...parts: string[]) => parts.join("");
const toBase64Url = (value: string) => Buffer.from(value).toString("base64url");

const AWS_SECRET_ACCESS_KEY = joinParts(
	"wJalrXUtnFEMI",
	"/K7MDENG+bPxRfiCY",
	"EXAMPLEKEY",
);
const SLACK_BOT_TOKEN = joinParts(
	"xoxb-",
	"123456789012-",
	"123456789012-",
	"abcdefghijklmnopqrstuvwx",
);
const GOOGLE_API_KEY = joinParts("AIza", "Sy", "A".repeat(33));
const GCP_ACCESS_TOKEN = joinParts("ya29.", "b".repeat(24));
const JWT_WITH_WHITESPACE_PREFIXED_PAYLOAD = [
	toBase64Url(JSON.stringify({ alg: "HS256", typ: "JWT" })),
	toBase64Url(' {"sub":"1234567890","name":"John Doe"}'),
	"a".repeat(32),
].join(".");

describe("sanitizeWithStaticMask", () => {
	it("redacts credential catalog patterns used by telemetry", () => {
		const value = [
			`aws --secret-access-key ${AWS_SECRET_ACCESS_KEY}`,
			`slack=${SLACK_BOT_TOKEN}`,
			`google=${GOOGLE_API_KEY}`,
			`gcp=${GCP_ACCESS_TOKEN}`,
		].join("\n");

		const sanitized = sanitizeWithStaticMask(value);

		expect(sanitized).toContain("--secret-access-key [secret]");
		expect(sanitized).toContain("slack=[secret]");
		expect(sanitized).toContain("google=[secret]");
		expect(sanitized).toContain("gcp=[secret]");
		expect(sanitized).not.toContain(AWS_SECRET_ACCESS_KEY);
		expect(sanitized).not.toContain(SLACK_BOT_TOKEN);
		expect(sanitized).not.toContain(GOOGLE_API_KEY);
		expect(sanitized).not.toContain(GCP_ACCESS_TOKEN);
	});

	it("preserves log labels while redacting captured credential values", () => {
		expect(
			sanitizeWithStaticMask(`Authorization: Bearer ${GCP_ACCESS_TOKEN}`),
		).toBe("Authorization: Bearer [secret]");
		expect(
			sanitizeWithStaticMask(
				`Basic ${Buffer.from("longuser:longerpassword").toString("base64")}`,
			),
		).toBe("Basic [secret]");
		expect(sanitizeWithStaticMask(`token ${AWS_SECRET_ACCESS_KEY}`)).toBe(
			"token [secret]",
		);
	});

	it("does not redact benign Basic auth prose", () => {
		// The Basic Auth Token pattern now requires ≥16 base64 chars, so
		// benign English like "Basic authentication" / "Basic Auth overview"
		// does not trip the mask.
		expect(sanitizeWithStaticMask("Use Basic authentication here")).toBe(
			"Use Basic authentication here",
		);
		expect(sanitizeWithStaticMask("Basic Auth overview")).toBe(
			"Basic Auth overview",
		);
		expect(sanitizeWithStaticMask("Document Authorization: Basic flow")).toBe(
			"Document Authorization: Basic flow",
		);
	});

	it("keeps the legacy static-mask fallback for long hex secrets", () => {
		const hexSecret = "a".repeat(64);

		expect(sanitizeWithStaticMask(`sha=${hexSecret}`)).toBe("sha=[secret]");
	});

	it("redacts JWTs even when the payload segment does not start with eyJ", () => {
		expect(JWT_WITH_WHITESPACE_PREFIXED_PAYLOAD.split(".")[1]).not.toMatch(
			/^eyJ/,
		);
		expect(
			sanitizeWithStaticMask(
				`session ${JWT_WITH_WHITESPACE_PREFIXED_PAYLOAD} completed`,
			),
		).toBe("session [secret] completed");
	});

	it("redacts the full Bearer token including base64-padded signatures", () => {
		// Real JWT signatures are URL-base64 with `+`, `/`, `=` characters.
		// A regex limited to `[a-zA-Z0-9_\-\.]` truncates the mask at the
		// first such character and leaks the rest of the signature.
		const jwtWithBase64PaddedSig = [
			toBase64Url(JSON.stringify({ alg: "HS256", typ: "JWT" })),
			toBase64Url(JSON.stringify({ sub: "u1" })),
			"sig+abc/def=",
		].join(".");

		const sanitized = sanitizeWithStaticMask(
			`Bearer ${jwtWithBase64PaddedSig}`,
		);

		expect(sanitized).toBe("Bearer [secret]");
		expect(sanitized).not.toContain("sig");
		expect(sanitized).not.toContain("+");
		expect(sanitized).not.toContain("/");
		expect(sanitized).not.toContain("=");
	});

	it("does not let attacker-controlled sentinel literals collide with staged replacements", () => {
		// The internal staging sentinel used to be the literal `<<MSTR RPL 0>>`,
		// so an attacker placing that string before a real credential could
		// either corrupt the redactor output or, in vault mode, smuggle a
		// stored credential reference into attacker-controlled text. The
		// per-call random nonce makes the sentinel unguessable.
		const value = `attempt <<MSTR RPL 0>> then ${GCP_ACCESS_TOKEN}`;

		const sanitized = sanitizeWithStaticMask(value);

		expect(sanitized).toContain("<<MSTR RPL 0>>");
		expect(sanitized).not.toContain(GCP_ACCESS_TOKEN);
		expect(sanitized).toContain("[secret]");
	});
});
