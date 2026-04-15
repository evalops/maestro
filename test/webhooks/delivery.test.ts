import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildWebhookDeliveryHeaders,
	signPayload,
	verifySignature,
} from "../../src/webhooks/delivery.js";

describe("Webhook Delivery", () => {
	describe("signPayload", () => {
		const secret = "test-webhook-secret-32-chars-min";

		it("should sign payload with timestamp", () => {
			const payload = JSON.stringify({ event: "test", data: {} });
			const result = signPayload(payload, secret);

			expect(result.signature).toMatch(/^t=\d+,v1=[a-f0-9]+$/);
			expect(result.timestamp).toBeGreaterThan(0);
		});

		it("should produce consistent signatures for same input", () => {
			const payload = JSON.stringify({ event: "test" });
			const timestamp = 1700000000;

			const sig1 = signPayload(payload, secret, timestamp);
			const sig2 = signPayload(payload, secret, timestamp);

			expect(sig1.signature).toBe(sig2.signature);
		});

		it("should produce different signatures for different payloads", () => {
			const timestamp = 1700000000;

			const sig1 = signPayload('{"a":1}', secret, timestamp);
			const sig2 = signPayload('{"a":2}', secret, timestamp);

			expect(sig1.signature).not.toBe(sig2.signature);
		});

		it("should produce different signatures for different timestamps", () => {
			const payload = JSON.stringify({ event: "test" });

			const sig1 = signPayload(payload, secret, 1700000000);
			const sig2 = signPayload(payload, secret, 1700000001);

			expect(sig1.signature).not.toBe(sig2.signature);
		});

		it("should produce different signatures for different secrets", () => {
			const payload = JSON.stringify({ event: "test" });
			const timestamp = 1700000000;

			const sig1 = signPayload(
				payload,
				"secret-one-32-chars-minimum!!",
				timestamp,
			);
			const sig2 = signPayload(
				payload,
				"secret-two-32-chars-minimum!!",
				timestamp,
			);

			expect(sig1.signature).not.toBe(sig2.signature);
		});
	});

	describe("verifySignature", () => {
		const secret = "test-webhook-secret-32-chars-min";

		it("should verify valid signature", () => {
			const payload = JSON.stringify({ event: "test", data: { id: 123 } });
			const { signature } = signPayload(payload, secret);

			const result = verifySignature(payload, signature, secret);

			expect(result.valid).toBe(true);
			expect(result.error).toBeUndefined();
		});

		it("should reject tampered payload", () => {
			const payload = JSON.stringify({ event: "test" });
			const { signature } = signPayload(payload, secret);

			const result = verifySignature('{"event":"tampered"}', signature, secret);

			expect(result.valid).toBe(false);
			expect(result.error).toBe("Signature mismatch");
		});

		it("should reject wrong secret", () => {
			const payload = JSON.stringify({ event: "test" });
			const { signature } = signPayload(payload, secret);

			const result = verifySignature(
				payload,
				signature,
				"wrong-secret-32-characters-min!!",
			);

			expect(result.valid).toBe(false);
			expect(result.error).toBe("Signature mismatch");
		});

		it("should reject expired timestamp", () => {
			const payload = JSON.stringify({ event: "test" });
			const oldTimestamp = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago
			const { signature } = signPayload(payload, secret, oldTimestamp);

			const result = verifySignature(payload, signature, secret, 300); // 5 min tolerance

			expect(result.valid).toBe(false);
			expect(result.error).toBe("Timestamp outside tolerance");
		});

		it("should accept timestamp within tolerance", () => {
			const payload = JSON.stringify({ event: "test" });
			const recentTimestamp = Math.floor(Date.now() / 1000) - 60; // 1 minute ago
			const { signature } = signPayload(payload, secret, recentTimestamp);

			const result = verifySignature(payload, signature, secret, 300);

			expect(result.valid).toBe(true);
		});

		it("should reject invalid signature format", () => {
			const payload = JSON.stringify({ event: "test" });

			expect(verifySignature(payload, "invalid", secret).valid).toBe(false);
			expect(verifySignature(payload, "invalid", secret).error).toBe(
				"Invalid signature format",
			);

			expect(verifySignature(payload, "t=123", secret).valid).toBe(false);
			expect(verifySignature(payload, "v1=abc", secret).valid).toBe(false);
		});

		it("should reject invalid timestamp", () => {
			const payload = JSON.stringify({ event: "test" });

			const result = verifySignature(payload, "t=notanumber,v1=abc123", secret);

			expect(result.valid).toBe(false);
			expect(result.error).toBe("Invalid timestamp");
		});
	});

	describe("webhook payload format", () => {
		it("should create proper alert webhook payload", () => {
			const payload = {
				event: "alert.permission_denial_spike",
				timestamp: new Date().toISOString(),
				data: {
					severity: "high",
					message: "User has been denied permission 5 times",
					threshold: 5,
					currentValue: 5,
				},
			};

			expect(payload.event).toMatch(/^alert\./);
			expect(payload.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
			expect(payload.data.severity).toBeDefined();
			expect(payload.data.message).toBeDefined();
		});
	});

	describe("buildWebhookDeliveryHeaders", () => {
		it("emits both composer and maestro signature headers", () => {
			const headers = buildWebhookDeliveryHeaders("sig-123");

			expect(headers["X-Composer-Signature"]).toBe("sig-123");
			expect(headers["X-Maestro-Signature"]).toBe("sig-123");
			expect(headers["Content-Type"]).toBe("application/json");
		});
	});
});
