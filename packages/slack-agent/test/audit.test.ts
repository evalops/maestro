import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditLogger } from "../src/audit.js";

describe("AuditLogger", () => {
	let dir: string;
	let logger: AuditLogger;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "slack-agent-audit-"));
		logger = new AuditLogger(dir, {
			enablePiiRedaction: true,
			maxPreviewLength: 100,
			retentionDays: 7,
			rotateAtMB: 10,
		});
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	describe("log", () => {
		it("creates audit log file", async () => {
			logger.log({ action: "message", userId: "U123", channel: "C456" });

			const auditDir = join(dir, "audit");
			const files = await readdir(auditDir);
			expect(files.length).toBe(1);
			expect(files[0]).toMatch(/^audit-\d{4}-\d{2}-\d{2}\.jsonl$/);
		});

		it("writes valid JSONL entries", async () => {
			logger.log({ action: "message", userId: "U123", channel: "C456" });
			logger.log({ action: "tool_call", toolName: "read", status: "success" });

			const auditDir = join(dir, "audit");
			const files = await readdir(auditDir);
			const content = await readFile(join(auditDir, files[0]!), "utf-8");
			const lines = content.trim().split("\n");

			expect(lines.length).toBe(2);
			const entry1 = JSON.parse(lines[0]!);
			const entry2 = JSON.parse(lines[1]!);

			expect(entry1.action).toBe("message");
			expect(entry2.action).toBe("tool_call");
		});

		it("includes timestamp and integrity hash", async () => {
			logger.log({ action: "message", userId: "U123" });

			const auditDir = join(dir, "audit");
			const files = await readdir(auditDir);
			const content = await readFile(join(auditDir, files[0]!), "utf-8");
			const entry = JSON.parse(content.trim());

			expect(entry.timestamp).toBeDefined();
			expect(entry.integrityHash).toBeDefined();
			expect(entry.integrityHash).toHaveLength(64); // SHA-256 hex
		});
	});

	describe("hash chaining", () => {
		it("chains hashes between entries", async () => {
			logger.log({ action: "message", userId: "U1" });
			logger.log({ action: "message", userId: "U2" });
			logger.log({ action: "message", userId: "U3" });

			const auditDir = join(dir, "audit");
			const files = await readdir(auditDir);
			const content = await readFile(join(auditDir, files[0]!), "utf-8");
			const entries = content
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l));

			// First entry has no previous hash
			expect(entries[0].previousHash).toBeUndefined();

			// Second entry links to first
			expect(entries[1].previousHash).toBe(entries[0].integrityHash);

			// Third entry links to second
			expect(entries[2].previousHash).toBe(entries[1].integrityHash);
		});
	});

	describe("verifyIntegrity", () => {
		it("returns valid for untampered logs", async () => {
			logger.log({ action: "message", userId: "U1" });
			logger.log({ action: "message", userId: "U2" });

			const result = logger.verifyIntegrity();
			expect(result.valid).toBe(true);
			expect(result.errors).toHaveLength(0);
		});
	});

	describe("PII redaction", () => {
		it("redacts email addresses", async () => {
			logger.log({
				action: "message",
				inputPreview: "Contact me at john@example.com",
			});

			const auditDir = join(dir, "audit");
			const files = await readdir(auditDir);
			const content = await readFile(join(auditDir, files[0]!), "utf-8");
			const entry = JSON.parse(content.trim());

			expect(entry.inputPreview).toBe("Contact me at [EMAIL]");
		});

		it("redacts phone numbers", async () => {
			logger.log({
				action: "message",
				inputPreview: "Call me at 555-123-4567",
			});

			const auditDir = join(dir, "audit");
			const files = await readdir(auditDir);
			const content = await readFile(join(auditDir, files[0]!), "utf-8");
			const entry = JSON.parse(content.trim());

			expect(entry.inputPreview).toBe("Call me at [PHONE]");
		});

		it("redacts credit card numbers", async () => {
			logger.log({
				action: "message",
				inputPreview: "Card: 5500-0000-0000-0004",
			});

			const auditDir = join(dir, "audit");
			const files = await readdir(auditDir);
			const content = await readFile(join(auditDir, files[0]!), "utf-8");
			const entry = JSON.parse(content.trim());

			expect(entry.inputPreview).toBe("Card: [CARD]");
		});

		it("redacts API keys", async () => {
			// Pattern requires prefix (sk/pk/api/etc) followed by 16+ alphanumeric chars
			logger.log({
				action: "message",
				inputPreview: "Key: sk_abcdefghijklmnopqrst",
			});

			const auditDir = join(dir, "audit");
			const files = await readdir(auditDir);
			const content = await readFile(join(auditDir, files[0]!), "utf-8");
			const entry = JSON.parse(content.trim());

			expect(entry.inputPreview).toBe("Key: [REDACTED_KEY]");
		});

		it("redacts AWS keys", async () => {
			logger.log({
				action: "message",
				inputPreview: "AWS: ABIATESTKEYFAKE12345",
			});

			const auditDir = join(dir, "audit");
			const files = await readdir(auditDir);
			const content = await readFile(join(auditDir, files[0]!), "utf-8");
			const entry = JSON.parse(content.trim());

			expect(entry.inputPreview).toBe("AWS: [AWS_KEY]");
		});
	});

	describe("preview truncation", () => {
		it("truncates long previews", async () => {
			const longText = "x".repeat(200);
			logger.log({ action: "message", inputPreview: longText });

			const auditDir = join(dir, "audit");
			const files = await readdir(auditDir);
			const content = await readFile(join(auditDir, files[0]!), "utf-8");
			const entry = JSON.parse(content.trim());

			expect(entry.inputPreview.length).toBeLessThan(200);
			expect(entry.inputPreview).toContain("[truncated]");
		});
	});

	describe("logMessage", () => {
		it("logs message events", async () => {
			logger.logMessage("U123", "C456", "Hello world", "T789");

			const auditDir = join(dir, "audit");
			const files = await readdir(auditDir);
			const content = await readFile(join(auditDir, files[0]!), "utf-8");
			const entry = JSON.parse(content.trim());

			expect(entry.action).toBe("message");
			expect(entry.userId).toBe("U123");
			expect(entry.channel).toBe("C456");
			expect(entry.inputPreview).toBe("Hello world");
			expect(entry.threadTs).toBe("T789");
		});
	});

	describe("logToolCall", () => {
		it("logs tool call events", async () => {
			logger.logToolCall(
				"U123",
				"C456",
				"read",
				{ path: "/etc/passwd" },
				"success",
				"file contents",
				150,
			);

			const auditDir = join(dir, "audit");
			const files = await readdir(auditDir);
			const content = await readFile(join(auditDir, files[0]!), "utf-8");
			const entry = JSON.parse(content.trim());

			expect(entry.action).toBe("tool_call");
			expect(entry.toolName).toBe("read");
			expect(entry.status).toBe("success");
			expect(entry.durationMs).toBe(150);
		});
	});

	describe("logApproval", () => {
		it("logs approval requests with pending status", async () => {
			logger.logApproval("U123", "C456", "approval_request", "rm -rf /");

			const auditDir = join(dir, "audit");
			const files = await readdir(auditDir);
			const content = await readFile(join(auditDir, files[0]!), "utf-8");
			const entry = JSON.parse(content.trim());

			expect(entry.action).toBe("approval_request");
			expect(entry.status).toBe("pending");
		});

		it("logs approval granted with success status", async () => {
			logger.logApproval("U123", "C456", "approval_granted", "rm -rf /");

			const auditDir = join(dir, "audit");
			const files = await readdir(auditDir);
			const content = await readFile(join(auditDir, files[0]!), "utf-8");
			const entry = JSON.parse(content.trim());

			expect(entry.action).toBe("approval_granted");
			expect(entry.status).toBe("success");
		});

		it("logs approval denied with denied status", async () => {
			logger.logApproval("U123", "C456", "approval_denied", "rm -rf /");

			const auditDir = join(dir, "audit");
			const files = await readdir(auditDir);
			const content = await readFile(join(auditDir, files[0]!), "utf-8");
			const entry = JSON.parse(content.trim());

			expect(entry.action).toBe("approval_denied");
			expect(entry.status).toBe("denied");
		});
	});

	describe("query", () => {
		it("queries logs by user", async () => {
			logger.log({ action: "message", userId: "U1" });
			logger.log({ action: "message", userId: "U2" });
			logger.log({ action: "message", userId: "U1" });

			const results = logger.query({ userId: "U1" });
			expect(results.length).toBe(2);
			expect(results.every((r) => r.userId === "U1")).toBe(true);
		});

		it("queries logs by action", async () => {
			logger.log({ action: "message", userId: "U1" });
			logger.log({ action: "tool_call", userId: "U1" });
			logger.log({ action: "message", userId: "U2" });

			const results = logger.query({ action: "message" });
			expect(results.length).toBe(2);
			expect(results.every((r) => r.action === "message")).toBe(true);
		});

		it("respects limit", async () => {
			for (let i = 0; i < 10; i++) {
				logger.log({ action: "message", userId: `U${i}` });
			}

			const results = logger.query({ limit: 5 });
			expect(results.length).toBe(5);
		});
	});
});

describe("AuditLogger with PII redaction disabled", () => {
	let dir: string;
	let logger: AuditLogger;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "slack-agent-audit-no-pii-"));
		logger = new AuditLogger(dir, { enablePiiRedaction: false });
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("preserves PII when redaction is disabled", async () => {
		logger.log({
			action: "message",
			inputPreview: "Email: test@example.com",
		});

		const auditDir = join(dir, "audit");
		const files = await readdir(auditDir);
		const content = await readFile(join(auditDir, files[0]!), "utf-8");
		const entry = JSON.parse(content.trim());

		expect(entry.inputPreview).toBe("Email: test@example.com");
	});
});
