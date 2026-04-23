import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleCompliance } from "../../src/server/handlers/compliance.js";
import {
	ComplianceService,
	setComplianceServiceForTest,
} from "../../src/services/compliance/index.js";
import { TracesUnavailableError } from "../../src/services/traces/index.js";

interface MockResponse {
	writableEnded: boolean;
	headersSent: boolean;
	statusCode?: number;
	body?: string;
	writeHead: ReturnType<typeof vi.fn>;
	end: ReturnType<typeof vi.fn>;
}

function createRequest(
	method: string,
	url: string,
	body?: unknown,
): IncomingMessage {
	const payload =
		body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
	const req = Readable.from(payload) as IncomingMessage;
	req.method = method;
	req.url = url;
	req.headers = { host: "localhost" };
	return req;
}

function createResponse(): MockResponse {
	const res: MockResponse = {
		writableEnded: false,
		headersSent: false,
		writeHead: vi.fn((statusCode: number) => {
			res.statusCode = statusCode;
			res.headersSent = true;
		}),
		end: vi.fn((body?: string) => {
			res.body = body;
			res.writableEnded = true;
		}),
	};
	return res;
}

function parseJsonResponse(res: MockResponse): unknown {
	return JSON.parse(res.body ?? "{}");
}

function serviceWithoutTraces(): ComplianceService {
	return new ComplianceService(
		() => ({
			listTraces: vi.fn().mockRejectedValue(new TracesUnavailableError()),
		}),
		() => new Date("2026-04-20T12:00:00.000Z"),
	);
}

describe("compliance service", () => {
	afterEach(() => {
		setComplianceServiceForTest(null);
		vi.restoreAllMocks();
	});

	it("generates SOC2 and ISO27001 evidence reports from agent actions", async () => {
		const service = serviceWithoutTraces();

		const report = await service.generateReport({
			workspaceId: "workspace-a",
			frameworks: ["soc2", "iso27001"],
			actions: [
				{
					actionId: "act-access",
					workspaceId: "workspace-a",
					agentId: "agent-1",
					type: "credential_access",
					status: "success",
					timestamp: "2026-04-20T10:00:00.000Z",
					resource: "github-token",
				},
				{
					actionId: "act-tool",
					workspaceId: "workspace-a",
					agentId: "agent-1",
					type: "tool_call",
					status: "success",
					timestamp: "2026-04-20T10:05:00.000Z",
					resource: "read",
				},
				{
					actionId: "act-pr",
					workspaceId: "workspace-a",
					agentId: "agent-1",
					type: "pull_request",
					status: "success",
					timestamp: "2026-04-20T10:10:00.000Z",
					resource: "evalops/maestro-internal#1307",
				},
			],
		});

		expect(report.reportId).toMatch(/^compliance_report_[0-9a-f]{16}$/);
		expect(report.generatedAt).toBe("2026-04-20T12:00:00.000Z");
		expect(report.summary).toEqual({
			controls: 7,
			satisfied: 7,
			missing: 0,
			evidenceItems: 7,
		});
		expect(
			report.controls.find((entry) => entry.control.id === "soc2.cc7.2"),
		).toMatchObject({
			status: "satisfied",
			evidenceCount: 1,
		});
	});

	it("returns tracked action evidence for a specific control", async () => {
		const service = serviceWithoutTraces();
		service.trackAgentAction({
			workspaceId: "workspace-a",
			agentId: "agent-1",
			type: "tool_call",
			status: "success",
			timestamp: "2026-04-20T10:05:00.000Z",
			resource: "write",
		});

		const result = await service.getEvidenceForControl("soc2.cc7.2", {
			workspaceId: "workspace-a",
		});

		expect(result?.control.id).toBe("soc2.cc7.2");
		expect(result?.evidence).toHaveLength(1);
		expect(result?.evidence[0]).toMatchObject({
			controlId: "soc2.cc7.2",
			sourceType: "tool_call",
			workspaceId: "workspace-a",
			agentId: "agent-1",
			resource: "write",
		});
	});

	it("includes execution trace evidence when traces are available", async () => {
		const listTraces = vi.fn().mockResolvedValue({
			traces: [
				{
					traceId: "trace-1",
					workspaceId: "workspace-a",
					agentId: "agent-1",
					durationMs: 125,
					status: "completed",
					spanCount: 3,
					createdAt: "2026-04-20T10:00:00.000Z",
				},
			],
			pagination: { limit: 100, offset: 0, hasMore: false },
		});
		const service = new ComplianceService(
			() => ({ listTraces }),
			() => new Date("2026-04-20T12:00:00.000Z"),
		);

		const report = await service.generateReport({
			workspaceId: "workspace-a",
			frameworks: ["soc2"],
		});

		expect(listTraces).toHaveBeenCalledWith({
			workspaceId: "workspace-a",
			limit: 100,
			offset: 0,
		});
		expect(
			report.controls.find((entry) => entry.control.id === "soc2.cc7.2"),
		).toMatchObject({
			status: "satisfied",
			evidenceCount: 1,
		});
		expect(report.summary.evidenceItems).toBe(1);
	});

	it("renders auditor artifacts from governance policy evaluations", async () => {
		const service = serviceWithoutTraces();
		service.trackGovernanceEvaluation({
			evaluationId: "gov-eval-1",
			workspaceId: "workspace-a",
			agentId: "agent-1",
			policyId: "require-human-review",
			actionType: "bash",
			decision: "escalate",
			riskLevel: "high",
			reason: "Command touches production resources",
			timestamp: "2026-04-20T10:15:00.000Z",
			metadata: {
				policyVersion: "2026.04",
			},
		});

		const report = await service.generateReport({
			workspaceId: "workspace-a",
			frameworks: ["soc2"],
			includeEvidence: false,
		});

		expect(
			report.controls.find((entry) => entry.control.id === "soc2.cc7.2"),
		).toMatchObject({
			status: "satisfied",
			evidenceCount: 1,
		});
		expect(report.artifact).toMatchObject({
			format: "auditor_json",
			reportId: report.reportId,
			sourceManifest: [
				{
					sourceType: "governance_policy_evaluation",
					evidenceCount: 1,
					firstSeenAt: "2026-04-20T10:15:00.000Z",
					lastSeenAt: "2026-04-20T10:15:00.000Z",
				},
			],
			gaps: [
				{ controlId: "soc2.cc6.1", severity: "high" },
				{ controlId: "soc2.cc8.1", severity: "medium" },
			],
		});
		const row = report.artifact?.controlMatrix.find(
			(entry) => entry.controlId === "soc2.cc7.2",
		);
		expect(row).toMatchObject({
			status: "satisfied",
			evidenceCount: 1,
			evidenceSources: ["governance_policy_evaluation"],
			lastEvidenceAt: "2026-04-20T10:15:00.000Z",
		});
		expect(report.artifact?.evidenceIndex[0]).toMatchObject({
			actionId: "gov-eval-1",
			sourceType: "governance_policy_evaluation",
			metadata: {
				source: "governance",
				policyId: "require-human-review",
				decision: "escalate",
				riskLevel: "high",
				reason: "Command touches production resources",
				policyVersion: "2026.04",
			},
		});
		expect(report.artifact?.exports.drata.controlEvidence).toContainEqual({
			controlExternalId: "soc2.cc7.2",
			evidenceIds: [expect.stringMatching(/^evidence_[0-9a-f]{16}$/)],
			status: "ready",
		});
	});
});

describe("compliance REST handler", () => {
	afterEach(() => {
		setComplianceServiceForTest(null);
		vi.restoreAllMocks();
	});

	it("lists controls with framework filtering", async () => {
		setComplianceServiceForTest(serviceWithoutTraces());
		const req = createRequest("GET", "/api/compliance/controls?framework=soc2");
		const res = createResponse();

		await handleCompliance(req, res as unknown as ServerResponse, {});

		expect(res.statusCode).toBe(200);
		const payload = parseJsonResponse(res) as {
			controls: Array<{ framework: string }>;
		};
		expect(payload.controls).toHaveLength(3);
		expect(
			payload.controls.every((control) => control.framework === "soc2"),
		).toBe(true);
	});

	it("generates reports through the REST handler", async () => {
		setComplianceServiceForTest(serviceWithoutTraces());
		const req = createRequest("POST", "/api/compliance/generate-report", {
			frameworks: ["soc2"],
			actions: [
				{
					workspaceId: "workspace-a",
					agentId: "agent-1",
					type: "tool_call",
					timestamp: "2026-04-20T10:00:00.000Z",
				},
			],
		});
		const res = createResponse();

		await handleCompliance(req, res as unknown as ServerResponse, {});

		expect(res.statusCode).toBe(200);
		expect(parseJsonResponse(res)).toMatchObject({
			report: {
				frameworks: ["soc2"],
				artifact: {
					format: "auditor_json",
					controlMatrix: expect.arrayContaining([
						expect.objectContaining({
							controlId: "soc2.cc7.2",
							status: "satisfied",
						}),
					]),
				},
				summary: {
					controls: 3,
					satisfied: 1,
				},
			},
		});
	});

	it("returns evidence for one control through the REST handler", async () => {
		const service = serviceWithoutTraces();
		service.trackAgentAction({
			workspaceId: "workspace-a",
			agentId: "agent-1",
			type: "approval",
			timestamp: "2026-04-20T10:00:00.000Z",
			description: "Human approval granted for command execution",
		});
		setComplianceServiceForTest(service);
		const req = createRequest(
			"GET",
			"/api/compliance/evidence/soc2.cc6.1?workspace_id=workspace-a",
		);
		const res = createResponse();

		await handleCompliance(
			req,
			res as unknown as ServerResponse,
			{},
			{ controlId: "soc2.cc6.1" },
		);

		expect(res.statusCode).toBe(200);
		expect(parseJsonResponse(res)).toMatchObject({
			control: { id: "soc2.cc6.1" },
			evidence: [
				{
					controlId: "soc2.cc6.1",
					sourceType: "approval",
					workspaceId: "workspace-a",
				},
			],
		});
	});
});
