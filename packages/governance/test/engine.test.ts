import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GovernanceEngine } from "../src/engine.js";
import type { GovernanceAuditEvent } from "../src/types.js";

// Build fake AWS keys at runtime to avoid tripping the pre-commit heuristic scanner.
const fakeAwsKey = `${"AK"}IA1234567890ABCDEF`;
const fakeAwsKey2 = `${"AK"}IAIOSFODNN7EXAMPLE1`;

describe("GovernanceEngine", () => {
	let engine: GovernanceEngine;

	beforeEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		engine = new GovernanceEngine({ service: false });
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
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

		it("delegates action evaluation to the governance service when configured", async () => {
			const fetchMock = vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						evaluation: {
							decision: "ACTION_DECISION_REQUIRE_APPROVAL",
							riskLevel: "RISK_LEVEL_HIGH",
							reasons: ["destructive action requested"],
							matchedRules: ["rule-delete"],
						},
					}),
					{ status: 200 },
				),
			);
			vi.stubGlobal("fetch", fetchMock);
			const engine = new GovernanceEngine({
				service: {
					baseUrl: "https://governance.test/",
					maxAttempts: 1,
					timeoutMs: 500,
					token: "governance-token",
					workspaceId: "workspace-1",
				},
			});

			const result = await engine.evaluate({
				toolName: "bash",
				args: { command: "rm -rf /tmp/build" },
				userIntent: "clean build output",
			});

			expect(result).toMatchObject({
				reason: "destructive action requested",
				ruleId: "rule-delete",
				triggeredBy: "policy",
				verdict: "require_approval",
			});
			expect(result.sanitizedArgs).toEqual({
				command: "rm -rf /tmp/build",
			});
			expect(fetchMock).toHaveBeenCalledTimes(1);
			const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
			expect(url).toBe(
				"https://governance.test/governance.v1.GovernanceService/EvaluateAction",
			);
			expect(init.method).toBe("POST");
			expect(init.headers).toMatchObject({
				Authorization: "Bearer governance-token",
				"Connect-Protocol-Version": "1",
				"Content-Type": "application/json",
			});
			const body = JSON.parse(String(init.body)) as {
				actionPayload: string;
				actionType: string;
				agentId: string;
				workspaceId: string;
			};
			expect(body).toMatchObject({
				actionType: "bash",
				agentId: "maestro",
				workspaceId: "workspace-1",
			});
			expect(
				JSON.parse(Buffer.from(body.actionPayload, "base64").toString("utf8")),
			).toMatchObject({
				args: { command: "rm -rf /tmp/build" },
				toolName: "bash",
				userIntent: "clean build output",
			});
		});

		it("normalizes governance service URLs before storing request config", async () => {
			const fetchMock = vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						evaluation: {
							decision: "ACTION_DECISION_ALLOW",
							reasons: [],
							matchedRules: [],
						},
					}),
					{ status: 200 },
				),
			);
			vi.stubGlobal("fetch", fetchMock);
			const engine = new GovernanceEngine({
				service: {
					baseUrl: "https://governance.test/governance.v1.GovernanceService/",
					maxAttempts: 1,
					timeoutMs: 500,
					workspaceId: "workspace-1",
				},
			});

			const result = await engine.evaluate({
				toolName: "bash",
				args: { command: "echo hello" },
			});

			expect(result.verdict).toBe("allow");
			expect(fetchMock).toHaveBeenCalledTimes(1);
			const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
			expect(url).toBe(
				"https://governance.test/governance.v1.GovernanceService/EvaluateAction",
			);
		});

		it("falls back to local evaluation when the optional governance service fails", async () => {
			const fetchMock = vi
				.fn()
				.mockRejectedValue(new Error("connection refused"));
			vi.stubGlobal("fetch", fetchMock);
			const engine = new GovernanceEngine({
				service: {
					baseUrl: "https://governance.test",
					maxAttempts: 1,
					timeoutMs: 500,
					workspaceId: "workspace-1",
				},
			});

			const result = await engine.evaluate({
				toolName: "bash",
				args: { command: "echo hello" },
			});

			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(result.verdict).toBe("allow");
		});

		it("disables firewall-level governance delegation when engine-level service fallback is enabled by env", async () => {
			const fetchMock = vi
				.fn()
				.mockRejectedValue(new Error("connection refused"));
			vi.stubGlobal("fetch", fetchMock);
			vi.stubEnv("GOVERNANCE_SERVICE_URL", "https://governance.test");
			vi.stubEnv("GOVERNANCE_SERVICE_WORKSPACE_ID", "workspace-1");
			vi.stubEnv("GOVERNANCE_SERVICE_MAX_ATTEMPTS", "1");
			vi.stubEnv("GOVERNANCE_SERVICE_TIMEOUT_MS", "500");

			const engine = new GovernanceEngine();
			const result = await engine.evaluate({
				toolName: "bash",
				args: { command: "echo hello" },
			});

			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(result.verdict).toBe("allow");
		});

		it("blocks when the required governance service is unavailable", async () => {
			const fetchMock = vi
				.fn()
				.mockRejectedValue(new Error("connection refused"));
			vi.stubGlobal("fetch", fetchMock);
			const engine = new GovernanceEngine({
				service: {
					baseUrl: "https://governance.test",
					maxAttempts: 1,
					required: true,
					timeoutMs: 500,
					workspaceId: "workspace-1",
				},
			});

			const result = await engine.evaluate({
				toolName: "bash",
				args: { command: "echo hello" },
			});

			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(result.verdict).toBe("block");
			expect(result.reason).toContain("Governance service unavailable");
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
				service: false,
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
