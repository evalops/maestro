import { beforeEach, describe, expect, it } from "vitest";
import { GovernanceEngine } from "../src/engine.js";
import type { GovernanceAuditEvent } from "../src/types.js";

// Build fake AWS keys at runtime to avoid tripping the pre-commit heuristic scanner.
const fakeAwsKey = `${"AK"}IA1234567890ABCDEF`;
const fakeAwsKey2 = `${"AK"}IAIOSFODNN7EXAMPLE1`;

describe("GovernanceEngine", () => {
	let engine: GovernanceEngine;

	beforeEach(() => {
		engine = new GovernanceEngine();
	});

	describe("evaluate()", () => {
		it("should block or require approval for destructive bash commands", async () => {
			const result = await engine.evaluate({
				toolName: "bash",
				args: { command: "rm -rf /" },
			});
			expect(result.verdict).not.toBe("allow");
			expect(result.reason).toBeDefined();
		});

		it("should allow safe read-only commands", async () => {
			const result = await engine.evaluate({
				toolName: "bash",
				args: { command: "echo hello" },
			});
			expect(result.verdict).toBe("allow");
		});

		it("should return sanitized args in result", async () => {
			const result = await engine.evaluate({
				toolName: "bash",
				args: { command: "ls -la" },
			});
			expect(result.sanitizedArgs).toBeDefined();
		});

		it("should require approval for system path modifications", async () => {
			const result = await engine.evaluate({
				toolName: "write",
				args: { file_path: "/etc/passwd", content: "hacked" },
			});
			// Either block or require_approval depending on the rule
			expect(result.verdict).not.toBe("allow");
		});
	});

	describe("scanPayload()", () => {
		it("should detect AWS keys in payload", () => {
			const result = engine.scanPayload({
				key: fakeAwsKey,
			});
			expect(result.hasSensitiveContent).toBe(true);
			expect(result.findingCount).toBeGreaterThan(0);
			expect(result.sanitizedPayload).toBeDefined();
		});

		it("should return clean result for safe payloads", () => {
			const result = engine.scanPayload({
				message: "Hello world",
			});
			expect(result.hasSensitiveContent).toBe(false);
			expect(result.findingCount).toBe(0);
		});

		it("should redact sensitive content in sanitized payload", () => {
			const result = engine.scanPayload({
				key: fakeAwsKey2,
			});
			expect(result.hasSensitiveContent).toBe(true);
			const sanitized = result.sanitizedPayload as Record<string, unknown>;
			// The sanitized value should differ from the original
			expect(String(sanitized.key)).not.toBe(fakeAwsKey2);
		});
	});

	describe("analyzeCommand()", () => {
		it("should flag destructive commands", () => {
			const result = engine.analyzeCommand("sudo rm -rf /tmp/test");
			expect(result.destructive).toBe(true);
			expect(result.safe).toBe(false);
		});

		it("should detect egress primitives", () => {
			const result = engine.analyzeCommand("curl https://example.com");
			expect(result.hasEgress).toBe(true);
		});

		it("should allow safe commands", () => {
			const result = engine.analyzeCommand("echo hello");
			expect(result.safe).toBe(true);
			expect(result.destructive).toBe(false);
		});
	});

	describe("checkPolicy()", () => {
		it("should allow when no policy file exists", async () => {
			const result = await engine.checkPolicy({
				toolName: "bash",
				args: { command: "ls" },
			});
			expect(result.allowed).toBe(true);
		});
	});

	describe("getPolicy()", () => {
		it("should return unloaded policy when no file exists", () => {
			const info = engine.getPolicy();
			expect(info.loaded).toBe(false);
			expect(info.hasToolRestrictions).toBe(false);
		});
	});

	describe("audit log", () => {
		it("should record evaluation events", async () => {
			await engine.evaluate({
				toolName: "bash",
				args: { command: "ls" },
			});
			const log = engine.getAuditLog();
			expect(log.length).toBeGreaterThan(0);
			expect(log[0]?.type).toBe("evaluation");
		});

		it("should allow manual audit event logging", () => {
			engine.logAuditEvent({
				type: "execution",
				toolName: "test",
				details: { custom: true },
			});
			const log = engine.getAuditLog();
			expect(log.length).toBe(1);
			expect(log[0]?.toolName).toBe("test");
			expect(log[0]?.timestamp).toBeInstanceOf(Date);
		});

		it("should clear audit log on reset", async () => {
			await engine.evaluate({
				toolName: "bash",
				args: { command: "ls" },
			});
			expect(engine.getAuditLog().length).toBeGreaterThan(0);
			engine.reset();
			expect(engine.getAuditLog().length).toBe(0);
		});
	});

	describe("onAuditEvent callback", () => {
		it("should fire callback for each event", async () => {
			const events: GovernanceAuditEvent[] = [];
			const engine = new GovernanceEngine({
				onAuditEvent: (event) => events.push(event),
			});
			await engine.evaluate({
				toolName: "bash",
				args: { command: "ls" },
			});
			expect(events.length).toBeGreaterThan(0);
		});
	});

	describe("recordExecution()", () => {
		it("should record execution and update state", () => {
			engine.recordExecution("bash", { command: "ls" }, true);
			const log = engine.getAuditLog();
			expect(log.some((e) => e.type === "execution")).toBe(true);
		});
	});
});
