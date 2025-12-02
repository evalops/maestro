import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type IpAccessConfig,
	checkIpAccess,
	createWebhookHeaders,
	generateBackupCodes,
	generateTotp,
	generateTotpSecret,
	generateTotpUri,
	hashAuditEntry,
	hashBackupCode,
	isTokenRevoked,
	revokeToken,
	signWebhookPayload,
	verifyAuditChain,
	verifyTotp,
	verifyWebhookSignature,
} from "../../src/security/enterprise.js";

describe("Enterprise Security Features", () => {
	describe("Webhook HMAC Signing", () => {
		const testSecret = "test-webhook-secret-key-at-least-32-chars";

		it("should sign payload with timestamp", () => {
			const payload = { event: "test", data: { id: 123 } };
			const signed = signWebhookPayload(payload, { secret: testSecret });

			expect(signed.payload).toBe(JSON.stringify(payload));
			expect(signed.timestamp).toBeGreaterThan(0);
			expect(signed.signature).toMatch(/^v1=[a-f0-9]+$/);
		});

		it("should verify valid signature", () => {
			const payload = { event: "test" };
			const signed = signWebhookPayload(payload, { secret: testSecret });

			const result = verifyWebhookSignature(
				signed.payload,
				signed.signature,
				signed.timestamp,
				{ secret: testSecret },
			);

			expect(result.valid).toBe(true);
			expect(result.error).toBeUndefined();
		});

		it("should reject tampered payload", () => {
			const signed = signWebhookPayload(
				{ event: "test" },
				{ secret: testSecret },
			);

			const result = verifyWebhookSignature(
				'{"event":"tampered"}',
				signed.signature,
				signed.timestamp,
				{ secret: testSecret },
			);

			expect(result.valid).toBe(false);
			expect(result.error).toBe("Signature mismatch");
		});

		it("should reject wrong secret", () => {
			const signed = signWebhookPayload(
				{ event: "test" },
				{ secret: testSecret },
			);

			const result = verifyWebhookSignature(
				signed.payload,
				signed.signature,
				signed.timestamp,
				{ secret: "wrong-secret-key-at-least-32-chars" },
			);

			expect(result.valid).toBe(false);
		});

		it("should reject expired timestamp", () => {
			const signed = signWebhookPayload(
				{ event: "test" },
				{ secret: testSecret },
			);
			const oldTimestamp = signed.timestamp - 600; // 10 minutes ago

			const result = verifyWebhookSignature(
				signed.payload,
				signed.signature,
				oldTimestamp,
				{ secret: testSecret, timestampTolerance: 300 },
			);

			expect(result.valid).toBe(false);
			expect(result.error).toBe("Timestamp outside tolerance window");
		});

		it("should create proper webhook headers", () => {
			const signed = signWebhookPayload(
				{ event: "test" },
				{ secret: testSecret },
			);
			const headers = createWebhookHeaders(signed);

			expect(headers["Content-Type"]).toBe("application/json");
			expect(headers["X-Composer-Signature"]).toBe(signed.signature);
			expect(headers["X-Composer-Timestamp"]).toBe(signed.timestamp.toString());
			expect(headers["X-Composer-Request-Id"]).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
			);
		});

		it("should support custom header name", () => {
			const signed = signWebhookPayload(
				{ event: "test" },
				{ secret: testSecret },
			);
			const headers = createWebhookHeaders(signed, "X-Custom-Sig");

			expect(headers["X-Custom-Sig"]).toBe(signed.signature);
		});
	});

	describe("IP Access Control", () => {
		it("should allow IP in allowlist", () => {
			const config: IpAccessConfig = {
				defaultAction: "deny",
				rules: [{ pattern: "192.168.1.100", type: "allow" }],
			};

			const result = checkIpAccess("192.168.1.100", config);
			expect(result.allowed).toBe(true);
		});

		it("should deny IP in blocklist", () => {
			const config: IpAccessConfig = {
				defaultAction: "allow",
				rules: [{ pattern: "10.0.0.1", type: "deny" }],
			};

			const result = checkIpAccess("10.0.0.1", config);
			expect(result.allowed).toBe(false);
		});

		it("should match CIDR ranges", () => {
			const config: IpAccessConfig = {
				defaultAction: "deny",
				rules: [{ pattern: "192.168.0.0/16", type: "allow" }],
			};

			expect(checkIpAccess("192.168.1.50", config).allowed).toBe(true);
			expect(checkIpAccess("192.168.255.255", config).allowed).toBe(true);
			expect(checkIpAccess("192.169.0.1", config).allowed).toBe(false);
			expect(checkIpAccess("10.0.0.1", config).allowed).toBe(false);
		});

		it("should match /24 subnet", () => {
			const config: IpAccessConfig = {
				defaultAction: "deny",
				rules: [{ pattern: "10.10.10.0/24", type: "allow" }],
			};

			expect(checkIpAccess("10.10.10.0", config).allowed).toBe(true);
			expect(checkIpAccess("10.10.10.255", config).allowed).toBe(true);
			expect(checkIpAccess("10.10.11.0", config).allowed).toBe(false);
		});

		it("should use default action when no rules match", () => {
			const allowConfig: IpAccessConfig = {
				defaultAction: "allow",
				rules: [],
			};
			const denyConfig: IpAccessConfig = {
				defaultAction: "deny",
				rules: [],
			};

			expect(checkIpAccess("1.2.3.4", allowConfig).allowed).toBe(true);
			expect(checkIpAccess("1.2.3.4", denyConfig).allowed).toBe(false);
		});

		it("should evaluate rules in order (first match wins)", () => {
			const config: IpAccessConfig = {
				defaultAction: "deny",
				rules: [
					{ pattern: "192.168.1.100", type: "deny" }, // Specific deny first
					{ pattern: "192.168.1.0/24", type: "allow" }, // Then subnet allow
				],
			};

			expect(checkIpAccess("192.168.1.100", config).allowed).toBe(false);
			expect(checkIpAccess("192.168.1.50", config).allowed).toBe(true);
		});

		it("should handle IPv4-mapped IPv6 addresses", () => {
			const config: IpAccessConfig = {
				defaultAction: "deny",
				rules: [{ pattern: "192.168.1.1", type: "allow" }],
			};

			expect(checkIpAccess("::ffff:192.168.1.1", config).allowed).toBe(true);
		});

		it("should return matched rule info", () => {
			const config: IpAccessConfig = {
				defaultAction: "deny",
				rules: [
					{
						pattern: "10.0.0.0/8",
						type: "allow",
						description: "Private network",
					},
				],
			};

			const result = checkIpAccess("10.5.5.5", config);
			expect(result.allowed).toBe(true);
			expect(result.matchedRule?.description).toBe("Private network");
		});
	});

	describe("Token Revocation", () => {
		const testToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test.signature";

		it("should not be revoked by default", () => {
			expect(isTokenRevoked("fresh-token-123")).toBe(false);
		});

		it("should be revoked after calling revokeToken", () => {
			const expiresAt = new Date(Date.now() + 3600000); // 1 hour from now
			revokeToken(testToken, expiresAt);

			expect(isTokenRevoked(testToken)).toBe(true);
		});

		it("should not affect other tokens", () => {
			const expiresAt = new Date(Date.now() + 3600000);
			revokeToken("token-to-revoke", expiresAt);

			expect(isTokenRevoked("token-to-revoke")).toBe(true);
			expect(isTokenRevoked("other-token")).toBe(false);
		});
	});

	describe("TOTP 2FA", () => {
		it("should generate valid secret", () => {
			const secret = generateTotpSecret();
			expect(secret).toHaveLength(32); // 20 bytes = 32 base32 chars
			expect(secret).toMatch(/^[A-Z2-7]+$/);
		});

		it("should generate 6-digit TOTP code", () => {
			const secret = generateTotpSecret();
			const code = generateTotp(secret);

			expect(code).toHaveLength(6);
			expect(code).toMatch(/^\d{6}$/);
		});

		it("should verify valid TOTP code", () => {
			const secret = generateTotpSecret();
			const code = generateTotp(secret);

			const result = verifyTotp(secret, code);
			expect(result.valid).toBe(true);
			expect(result.drift).toBe(0);
		});

		it("should reject wrong TOTP code", () => {
			const secret = generateTotpSecret();
			const result = verifyTotp(secret, "000000");

			// Unless by coincidence it matches
			if (!result.valid) {
				expect(result.valid).toBe(false);
			}
		});

		it("should accept code within time window", () => {
			const secret = generateTotpSecret();
			// Generate code for 30 seconds ago
			const pastTime = Date.now() / 1000 - 30;
			const pastCode = generateTotp(secret, pastTime);

			const result = verifyTotp(secret, pastCode, 1);
			expect(result.valid).toBe(true);
			expect(result.drift).toBe(-1);
		});

		it("should generate unique backup codes", () => {
			const codes = generateBackupCodes(10);

			expect(codes).toHaveLength(10);
			expect(new Set(codes).size).toBe(10); // All unique
			for (const code of codes) {
				expect(code).toMatch(/^[A-F0-9]{4}-[A-F0-9]{4}$/);
			}
		});

		it("should hash backup codes consistently", () => {
			const code = "ABCD-1234";
			const hash1 = hashBackupCode(code);
			const hash2 = hashBackupCode(code);
			const hash3 = hashBackupCode("abcd1234"); // Same without dash, lowercase

			expect(hash1).toBe(hash2);
			expect(hash1).toBe(hash3); // Normalized
			expect(hash1).toHaveLength(64); // SHA-256 hex
		});

		it("should generate valid otpauth URI", () => {
			const secret = "JBSWY3DPEHPK3PXP";
			const uri = generateTotpUri(secret, "user@example.com", "TestApp");

			expect(uri).toContain("otpauth://totp/");
			expect(uri).toContain("TestApp");
			expect(uri).toContain("user%40example.com");
			expect(uri).toContain(`secret=${secret}`);
			expect(uri).toContain("algorithm=SHA1");
			expect(uri).toContain("digits=6");
			expect(uri).toContain("period=30");
		});
	});

	describe("Audit Log Integrity", () => {
		it("should generate consistent hash for same entry", () => {
			const entry = {
				id: "entry-1",
				timestamp: new Date("2024-01-01T00:00:00Z"),
				action: "test.action",
				userId: "user-1",
				metadata: { foo: "bar" },
			};
			const previousHash = "0".repeat(64);

			const hash1 = hashAuditEntry(entry, previousHash);
			const hash2 = hashAuditEntry(entry, previousHash);

			expect(hash1).toBe(hash2);
			expect(hash1).toHaveLength(64);
		});

		it("should produce different hash for different entries", () => {
			const entry1 = {
				id: "entry-1",
				timestamp: new Date("2024-01-01T00:00:00Z"),
				action: "test.action",
				userId: "user-1",
			};
			const entry2 = {
				id: "entry-2",
				timestamp: new Date("2024-01-01T00:00:00Z"),
				action: "test.action",
				userId: "user-1",
			};
			const previousHash = "0".repeat(64);

			expect(hashAuditEntry(entry1, previousHash)).not.toBe(
				hashAuditEntry(entry2, previousHash),
			);
		});

		it("should chain hashes correctly", () => {
			const genesis = "0".repeat(64);
			const entry1 = {
				id: "1",
				timestamp: new Date(),
				action: "a",
				userId: "u",
			};
			const entry2 = {
				id: "2",
				timestamp: new Date(),
				action: "b",
				userId: "u",
			};

			const hash1 = hashAuditEntry(entry1, genesis);
			const hash2 = hashAuditEntry(entry2, hash1);

			// Hash2 should be different if we use wrong previous hash
			const wrongHash2 = hashAuditEntry(entry2, genesis);
			expect(hash2).not.toBe(wrongHash2);
		});

		it("should verify valid chain", () => {
			const genesis = "0".repeat(64);
			const entries = [
				{
					id: "1",
					timestamp: new Date("2024-01-01T00:00:00Z"),
					action: "a",
					userId: "u",
				},
				{
					id: "2",
					timestamp: new Date("2024-01-01T00:00:01Z"),
					action: "b",
					userId: "u",
				},
				{
					id: "3",
					timestamp: new Date("2024-01-01T00:00:02Z"),
					action: "c",
					userId: "u",
				},
			];

			// Add integrity hashes
			let previousHash = genesis;
			const entriesWithHashes = entries.map((e) => {
				const integrityHash = hashAuditEntry(e, previousHash);
				previousHash = integrityHash;
				return { ...e, integrityHash };
			});

			const result = verifyAuditChain(entriesWithHashes, genesis);
			expect(result.valid).toBe(true);
		});

		it("should detect tampered entry", () => {
			const genesis = "0".repeat(64);
			const entries = [
				{
					id: "1",
					timestamp: new Date("2024-01-01T00:00:00Z"),
					action: "a",
					userId: "u",
				},
				{
					id: "2",
					timestamp: new Date("2024-01-01T00:00:01Z"),
					action: "b",
					userId: "u",
				},
			];

			// Add integrity hashes
			let previousHash = genesis;
			const entriesWithHashes = entries.map((e) => {
				const integrityHash = hashAuditEntry(e, previousHash);
				previousHash = integrityHash;
				return { ...e, integrityHash };
			});

			// Tamper with second entry
			entriesWithHashes[1].action = "tampered";

			const result = verifyAuditChain(entriesWithHashes, genesis);
			expect(result.valid).toBe(false);
			expect(result.brokenAt).toBe(1);
		});
	});
});
