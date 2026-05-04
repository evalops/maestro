import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GovernanceEngine } from "../src/engine.js";
import type { GovernanceAuditEvent } from "../src/types.js";

describe("GovernanceEngine", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it("fails closed when Platform governance is not configured", async () => {
		const engine = new GovernanceEngine({ service: false });

		const result = await engine.evaluate({
			args: { command: "echo hello" },
			toolName: "bash",
		});

		expect(result).toMatchObject({
			reason: "Platform governance service is not configured",
			ruleId: "governance-service-not-configured",
			triggeredBy: "policy",
			verdict: "block",
		});
	});

	it("proxies action evaluation to Platform governance", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					evaluation: {
						decision: "ACTION_DECISION_REQUIRE_APPROVAL",
						matchedRules: ["rule-delete"],
						reasons: ["destructive action requested"],
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
				token: "governance-token",
				workspaceId: "workspace-1",
			},
		});

		const result = await engine.evaluate({
			args: { command: "rm -rf /tmp/build" },
			toolName: "bash",
			userIntent: "clean build output",
		});

		expect(result).toMatchObject({
			reason: "destructive action requested",
			ruleId: "rule-delete",
			triggeredBy: "policy",
			verdict: "require_approval",
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

	it("does not fall back to local policy when the Platform proxy fails", async () => {
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
			args: { command: "echo hello" },
			toolName: "bash",
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({
			ruleId: "governance-service-unavailable",
			verdict: "block",
		});
	});

	it("proxies payload scanning to Platform DetectPII", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					result: {
						enforcementAction: "PII_ENFORCEMENT_ACTION_REDACT",
						redactedText: '{"email":"[redacted]"}',
						spans: [
							{ category: "PII_CATEGORY_EMAIL", detector: "regex.email" },
						],
					},
				}),
				{ status: 200 },
			),
		);
		vi.stubGlobal("fetch", fetchMock);
		const engine = new GovernanceEngine({
			service: {
				baseUrl: "https://platform.test",
				maxAttempts: 1,
				timeoutMs: 500,
				workspaceId: "workspace-1",
			},
		});

		const result = await engine.scanPayload({ email: "person@example.com" });

		expect(result).toMatchObject({
			findingCount: 1,
			findingTypes: ["PII_CATEGORY_EMAIL"],
			hasSensitiveContent: true,
			sanitizedPayload: '{"email":"[redacted]"}',
		});
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(
			"https://platform.test/governance.v1.GovernanceService/DetectPII",
		);
		expect(JSON.parse(String(init.body))).toEqual({
			text: '{"email":"person@example.com"}',
		});
	});

	it("fails closed with a scan result when Platform DetectPII is unavailable", async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error("timeout"));
		vi.stubGlobal("fetch", fetchMock);
		const engine = new GovernanceEngine({
			service: {
				baseUrl: "https://platform.test",
				maxAttempts: 1,
				timeoutMs: 500,
				workspaceId: "workspace-1",
			},
		});

		const result = await engine.scanPayload({ email: "person@example.com" });

		expect(result).toMatchObject({
			blockReason: "Governance service unavailable: timeout",
			blocked: true,
			findingCount: 0,
			findingTypes: [],
			hasSensitiveContent: false,
			sanitizedPayload: { email: "person@example.com" },
		});
	});

	it("summarizes Platform safety policy instead of reading local policy", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					policy: {
						rules: [
							{ action: "ACTION_DECISION_REQUIRE_APPROVAL" },
							{ action: "ACTION_DECISION_DENY" },
						],
						workspaceId: "workspace-1",
					},
				}),
				{ status: 200 },
			),
		);
		vi.stubGlobal("fetch", fetchMock);
		const engine = new GovernanceEngine({
			service: {
				baseUrl: "https://platform.test",
				maxAttempts: 1,
				timeoutMs: 500,
				workspaceId: "workspace-1",
			},
		});

		const result = await engine.getPolicy();

		expect(result).toMatchObject({
			hasToolRestrictions: true,
			loaded: true,
			orgId: "workspace-1",
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"https://platform.test/governance.v1.GovernanceService/GetSafetyPolicy",
			expect.objectContaining({ method: "POST" }),
		);
	});

	it("returns an unloaded policy summary when Platform policy fetch fails", async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error("503 unavailable"));
		vi.stubGlobal("fetch", fetchMock);
		const engine = new GovernanceEngine({
			service: {
				baseUrl: "https://platform.test",
				maxAttempts: 1,
				timeoutMs: 500,
				workspaceId: "workspace-1",
			},
		});

		const result = await engine.getPolicy();

		expect(result).toMatchObject({
			error: "Governance service unavailable: 503 unavailable",
			hasToolRestrictions: false,
			loaded: false,
			orgId: "workspace-1",
		});
	});

	it("preserves obvious egress signal in command analysis", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					evaluation: {
						decision: "ACTION_DECISION_ALLOW",
						matchedRules: [],
						reasons: [],
					},
				}),
				{ status: 200 },
			),
		);
		vi.stubGlobal("fetch", fetchMock);
		const engine = new GovernanceEngine({
			service: {
				baseUrl: "https://platform.test",
				maxAttempts: 1,
				timeoutMs: 500,
				workspaceId: "workspace-1",
			},
		});

		const result = await engine.analyzeCommand("curl https://example.com");

		expect(result).toMatchObject({
			hasEgress: true,
			safe: true,
		});
	});

	it("records local process audit callbacks for proxy activity", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					evaluation: {
						decision: "ACTION_DECISION_ALLOW",
						matchedRules: [],
						reasons: [],
					},
				}),
				{ status: 200 },
			),
		);
		vi.stubGlobal("fetch", fetchMock);
		const events: GovernanceAuditEvent[] = [];
		const engine = new GovernanceEngine({
			onAuditEvent: (event) => events.push(event),
			service: {
				baseUrl: "https://platform.test",
				maxAttempts: 1,
				timeoutMs: 500,
				workspaceId: "workspace-1",
			},
		});

		await engine.evaluate({ args: { command: "ls" }, toolName: "bash" });

		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			toolName: "bash",
			type: "evaluation",
			verdict: "allow",
		});
		expect(events[0]?.timestamp).toBeInstanceOf(Date);
	});
});
